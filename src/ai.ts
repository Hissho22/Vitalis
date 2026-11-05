import {
  AIProjectClient,
  type AgentDefinitionUnion,
  type PromptAgentDefinition,
} from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import type {
  FunctionTool,
  ResponseFunctionToolCall,
} from "openai/resources/responses/responses.js";
import type { AppConfig } from "./config.js";
import {
  buscarCatalogoMedicamentos,
  buscarAdmision,
  consultarEmpleadoPorEntraId,
  consultarSeguros,
  crearAdmision,
  listarRecetasPendientes,
  LookupError,
  marcarRecetaEntregada,
  obtenerExpedienteMaster,
  PharmacyInventoryError,
  registrarAtencion,
  type AdmissionInput,
  type PharmacyDeliveryResult,
  type Recipe,
} from "./db.js";
import { AuthorizationError, authorizeTool } from "./rbac.js";

const MAX_TOOL_ROUNDS = 8;
const CONTENT_POLICY_RESPONSE =
  "No puedo procesar esa solicitud por políticas de seguridad. Reformúlala sin pedir secretos, credenciales ni información no autorizada.";
const AUTHORIZATION_DENIED_RESPONSE =
  "Su rol actual no cuenta con autorización para acceder a esta información o realizar esta acción clínica. Por favor, remítase a las tareas correspondientes a su área asignada.";
const AUTHORIZATION_DENIAL_INSTRUCTION =
  "Si una herramienta es rechazada por autorización, informa con tono profesional y hospitalario que el rol actual no permite acceder a esa información o realizar esa acción y deriva al área correspondiente. No reveles nombres de herramientas, funciones, métodos, tablas, campos, variables, errores internos ni otros detalles de implementación.";
const MEDICATION_CATALOG_INSTRUCTION =
  "El catálogo es una referencia factual de insumos, descripciones, indicaciones registradas, claves y stock; no es una guía terapéutica. Admin, Médico y Farmacia deben invocar consultar_catalogo_medicamentos antes de contestar cualquier consulta sobre stock o disponibilidad, presentaciones, claves oficiales o indicaciones registradas. Responde sobre estos datos únicamente con resultados devueltos por la herramienta; no inventes ni infieras datos que no estén registrados. No afirmes que careces de acceso al catálogo o inventario ni que no puedes consultarlos. Médico debe identificar cada receta por clave oficial o nombre exacto de insumo e indicar explícitamente la cantidad total de unidades de inventario prescritas. Calcula esa cantidad solo a partir de una pauta y duración explícitamente establecidas; si falta información para determinarla, no la inventes ni emitas una cantidad. El catálogo no contiene una pauta de dosificación: no deduzcas dosis ni tratamientos personalizados de sus resultados; Médico debe seguir el protocolo clínico aprobado y validar alergias.";
type JsonRecord = Record<string, unknown>;

export function authorizationDenialResponse(error: unknown): string | undefined {
  return error instanceof AuthorizationError
    ? AUTHORIZATION_DENIED_RESPONSE
    : undefined;
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function asRecord(value: unknown): JsonRecord | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as JsonRecord;
}

function isContentPolicyCode(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const code = value.toLowerCase().replace(/[^a-z]/g, "");
  return new Set([
    "contentfilter",
    "contentpolicyviolation",
    "responsibleaipolicyviolation",
    "imagecontentpolicyviolation",
    "biopolicy",
    "misalignmentpolicyviolation",
    "moderationblocked",
    "safetyviolation",
  ]).has(code);
}

export function isContentPolicyBlock(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const error = asRecord(record.error);
  const details = asRecord(record.incomplete_details);
  return (
    details?.reason === "content_filter" ||
    isContentPolicyCode(record.code) ||
    isContentPolicyCode(record.type) ||
    isContentPolicyCode(error?.code) ||
    isContentPolicyCode(error?.type)
  );
}

class ContentPolicyBlockedError extends Error {
  constructor() {
    super(CONTENT_POLICY_RESPONSE);
    this.name = "ContentPolicyBlockedError";
  }
}

async function withContentPolicyHandling<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isContentPolicyBlock(error)) throw new ContentPolicyBlockedError();
    throw error;
  }
}

export async function runSpecialistResponse(
  operation: () => Promise<unknown>,
): Promise<string> {
  const response = await withContentPolicyHandling(operation);
  if (isContentPolicyBlock(response)) throw new ContentPolicyBlockedError();
  const outputText = asRecord(response)?.output_text;
  if (typeof outputText !== "string" || !outputText) {
    throw new Error("El agente especialista terminó sin producir una respuesta.");
  }
  return outputText;
}

function stringArgument(
  args: JsonRecord,
  name: string,
  nullable = false,
): string | null {
  const value = args[name];
  if (nullable && value === null) return null;
  if (typeof value !== "string") {
    throw new TypeError(`El argumento ${name} debe ser texto${nullable ? " o null" : ""}.`);
  }
  return value;
}

function patientIdentifierArgument(args: JsonRecord, name: string): string {
  return stringArgument(args, name)!
    .trim()
    .replace(/^(?:paciente\s+)?(?:con\s+)?NSS\s+/i, "")
    .trim();
}

function booleanArgument(args: JsonRecord, name: string): boolean {
  const value = args[name];
  if (typeof value !== "boolean") {
    throw new TypeError(`El argumento ${name} debe ser booleano.`);
  }
  return value;
}

function integerArgument(args: JsonRecord, name: string): number | null {
  const value = args[name];
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new TypeError(`El argumento ${name} debe ser un entero o null.`);
  }
  return value;
}

function objectArgument(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("Los argumentos de la herramienta deben ser un objeto.");
  }
  return value as JsonRecord;
}

function stringParameter(description: string): Record<string, unknown> {
  return { type: "string", description };
}

function functionTool(
  name: string,
  description: string,
  properties: Record<string, unknown>,
): FunctionTool {
  return {
    type: "function",
    name,
    description,
    parameters: {
      type: "object",
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
    strict: true,
  };
}

const admissionProperties: Record<string, unknown> = {
  nss: stringParameter(
    "Identificador único exacto del paciente; se admite texto alfanumérico según el formato de la base de datos",
  ),
  nombre: stringParameter("Nombre completo confirmado"),
  datos_confirmados: { type: "boolean" },
};
for (const field of [
  "telefono",
  "contacto_emergencia",
  "parentesco",
  "telefono_emergencia",
  "fecha_nacimiento",
  "sexo",
  "tipo_sangre",
  "alergias",
  "enfermedades_cronicas",
  "cirugias_previas",
  "antecedentes_familiares",
  "habitos_toxicologias",
  "discapacidades_dispositivos",
]) {
  admissionProperties[field] = {
    type: ["string", "null"],
    description: `${field}; null si no fue proporcionado`,
  };
}

const functionTools: FunctionTool[] = [
  functionTool(
    "buscar_paciente_admision",
    "Busca en Azure SQL por identificador exacto del paciente o nombre completo exacto; el identificador puede ser alfanumérico (incluidos códigos DEMO); no crea registros.",
    {
      identificador: stringParameter(
        "Identificador exacto del paciente, alfanumérico permitido (por ejemplo DEMO-0001), o nombre completo exacto",
      ),
    },
  ),
  functionTool(
    "registrar_admision",
    "Crea admisión e historial usando únicamente datos confirmados por Admisión. Incluye parentesco del contacto de emergencia cuando se haya proporcionado; no lo infieras.",
    admissionProperties,
  ),
  functionTool(
    "consultar_historico",
    "Consulta datos biológicos e históricos explícitos por identificador exacto del paciente (también alfanumérico) o nombre completo exacto.",
    {
      identificador: stringParameter(
        "Identificador exacto del paciente, alfanumérico permitido (por ejemplo DEMO-0001), o nombre completo exacto",
      ),
    },
  ),
  functionTool(
    "obtener_expediente_master",
    "Obtiene el expediente consolidado de dbo.master usando el identificador exacto del paciente, incluidos identificadores alfanuméricos.",
    { nss: stringParameter("Identificador exacto del paciente; se admite texto alfanumérico") },
  ),
  functionTool(
    "validar_poliza",
    "Consulta el estatus de póliza; no calcula deducibles ni cobertura.",
    {
      identificador: stringParameter(
        "Identificador exacto del paciente, alfanumérico permitido (por ejemplo DEMO-0001), o nombre completo exacto",
      ),
      motivo: stringParameter("Motivo de la consulta administrativa"),
    },
  ),
  functionTool(
    "evaluar_consulta_medica",
    "Delega la evaluación clínica al Agente Médico y registra su resultado. Cada receta debe incluir medicamento identificado por nombre exacto de insumo o clave oficial, dosis_y_tiempo y cantidad positiva de unidades del catálogo que se prescriben. Si se requiere consultar un insumo del catálogo, proporciona termino_catalogo y opcionalmente clave_catalogo para que el backend incluya resultados verificados.",
    {
      nss: stringParameter(
        "Identificador exacto del paciente; se admite texto alfanumérico como DEMO-0001",
      ),
      motivo_consulta: stringParameter("Motivo proporcionado"),
      signos_vitales: stringParameter(
        "Signos vitales reportados; no inventar mediciones",
      ),
      termino_catalogo: {
        type: ["string", "null"],
        description:
          "Término para buscar en insumo, descripción o indicaciones; null si no se requiere catálogo",
      },
      clave_catalogo: {
        type: ["string", "null"],
        description:
          "Clave oficial exacta opcional; null si no se requiere filtrar por clave",
      },
    },
  ),
  functionTool(
    "gestionar_farmacia",
    "Consulta pendientes por identificador exacto del paciente, incluso alfanumérico, o registra una entrega solo después de confirmación explícita del empleado, verificando el catálogo y descontando la cantidad prescrita en una transacción.",
    {
      accion: { type: "string", enum: ["pendientes", "entregar"] },
      nss: stringParameter(
        "Identificador exacto del paciente; se admite texto alfanumérico como DEMO-0001",
      ),
      id_receta: { type: ["integer", "null"] },
      confirmar_entrega: { type: "boolean" },
    },
  ),
  functionTool(
    "consultar_catalogo_medicamentos",
    "Busca hasta cinco registros del catálogo por insumo, descripción o indicaciones; puede acotarse por clave oficial. Devuelve únicamente datos registrados y stock, no recomienda tratamientos ni dosis.",
    {
      termino: stringParameter(
        "Texto para buscar en insumo, descripción o indicaciones; puede estar vacío si se proporciona una clave",
      ),
      clave: {
        type: ["string", "null"],
        description: "Clave oficial exacta opcional; null si no se conoce",
      },
    },
  ),
];

export async function executeMedicationCatalogSearch(
  args: JsonRecord,
  search: typeof buscarCatalogoMedicamentos = buscarCatalogoMedicamentos,
): Promise<string> {
  const term = stringArgument(args, "termino")!.trim();
  const rawKey = args.clave;
  const key =
    rawKey === undefined
      ? null
      : stringArgument(args, "clave", true)?.trim() || null;
  if (!term && !key) {
    throw new TypeError("Proporciona un término de búsqueda o una clave.");
  }
  if (term.length > 500) {
    throw new TypeError("El término de búsqueda excede 500 caracteres.");
  }
  if (key && key.length > 255) {
    throw new TypeError("La clave excede 255 caracteres.");
  }
  return JSON.stringify(await search(term, key), null, 2);
}

export function parseMedicalResult(responseText: string): {
  notas_medicas: string;
  diagnostico: string;
  recetas: Recipe[];
} {
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(
        "El Agente Médico no devolvió el JSON requerido; no se guardó la atención.",
        { cause: error },
      );
    }
    throw error;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("La respuesta clínica no tiene el formato esperado.");
  }
  const result = parsed as JsonRecord;
  const notes = result.notas_medicas;
  const diagnosis = result.diagnostico;
  const recipes = result.recetas;
  if (
    typeof notes !== "string" ||
    !notes.trim() ||
    typeof diagnosis !== "string" ||
    !diagnosis.trim() ||
    !Array.isArray(recipes)
  ) {
    throw new Error("La respuesta clínica contiene campos inválidos.");
  }

  const validatedRecipes = recipes.map((recipe): Recipe => {
    if (
      typeof recipe !== "object" ||
      recipe === null ||
      Array.isArray(recipe) ||
      !("medicamento" in recipe) ||
      !("dosis_y_tiempo" in recipe) ||
      !("cantidad" in recipe) ||
      typeof recipe.medicamento !== "string" ||
      !recipe.medicamento.trim() ||
      typeof recipe.dosis_y_tiempo !== "string" ||
      !recipe.dosis_y_tiempo.trim() ||
      typeof recipe.cantidad !== "number" ||
      !Number.isInteger(recipe.cantidad) ||
      recipe.cantidad <= 0 ||
      recipe.cantidad > 2_147_483_647
    ) {
      throw new Error("La respuesta contiene una receta incompleta.");
    }
    return {
      medicamento: recipe.medicamento,
      dosis_y_tiempo: recipe.dosis_y_tiempo,
      cantidad: recipe.cantidad,
    };
  });

  return {
    notas_medicas: notes,
    diagnostico: diagnosis,
    recetas: validatedRecipes,
  };
}

export interface PharmacyOperations {
  listPendingRecipes: typeof listarRecetasPendientes;
  markRecipeDelivered: typeof marcarRecetaEntregada;
}

export async function executePharmacyAction(
  args: JsonRecord,
  userMessage: string,
  operations: PharmacyOperations = {
    listPendingRecipes: listarRecetasPendientes,
    markRecipeDelivered: marcarRecetaEntregada,
  },
): Promise<string> {
  const action = stringArgument(args, "accion")!;
  const nss = patientIdentifierArgument(args, "nss");
  if (action === "pendientes") {
    return JSON.stringify(await operations.listPendingRecipes(nss), null, 2);
  }
  if (action === "entregar") {
    const recipeId = integerArgument(args, "id_receta");
    const confirmed = booleanArgument(args, "confirmar_entrega");
    if (recipeId === null) {
      throw new TypeError("Se requiere id_receta para confirmar la entrega.");
    }
    const confirmation = new RegExp(
      `\\bconfirmo que la entrega f[ií]sica de la receta\\s+${recipeId}\\s+ya fue realizada\\b`,
      "i",
    );
    if (!confirmed || !confirmation.test(userMessage)) {
      return JSON.stringify({
        confirmacion_requerida: true,
        mensaje:
          `Para registrar la entrega de la receta ${recipeId}, confirma en un mensaje separado: ` +
          `"Confirmo que la entrega física de la receta ${recipeId} ya fue realizada."`,
      });
    }
    let delivery: PharmacyDeliveryResult;
    try {
      delivery = await operations.markRecipeDelivered(recipeId, nss);
    } catch (error) {
      if (error instanceof LookupError) {
        return JSON.stringify({
          entrega_registrada: false,
          mensaje:
            "No se registró la entrega: la receta no existe para este paciente o ya no está pendiente.",
        });
      }
      if (error instanceof PharmacyInventoryError) {
        return JSON.stringify({
          entrega_registrada: false,
          mensaje: error.message,
        });
      }
      throw error;
    }
    return JSON.stringify({
      id_receta: recipeId,
      estatus_farmacia: "Entregado",
      ...delivery,
    });
  }
  throw new TypeError("La acción debe ser 'pendientes' o 'entregar'.");
}

function createAgentClient(agentName: string, project: AIProjectClient) {
  return project.getOpenAIClient({
    azureConfig: { allowPreview: true, agentName },
  });
}

function isPromptDefinition(
  definition: AgentDefinitionUnion,
): definition is PromptAgentDefinition {
  return (
    definition.kind === "prompt" &&
    "model" in definition &&
    typeof definition.model === "string"
  );
}

export function createAiService(config: AppConfig) {
  const credential = new DefaultAzureCredential();
  const project = new AIProjectClient(config.projectEndpoint, credential, {
    tracingOptions: {
      experimental: true,
      contentRecording: false,
    },
  });
  const openAIClient = project.getOpenAIClient();
  let orchestratorDefinitionPromise: Promise<PromptAgentDefinition> | undefined;
  const specialistClients = new Map(
    Object.entries(config.agents)
      .filter(([role]) => role !== "orchestrator")
      .map(([role, agentName]) => [
        agentName,
        createAgentClient(agentName, project),
      ]),
  );

  async function getOrchestratorDefinition(): Promise<PromptAgentDefinition> {
    if (!orchestratorDefinitionPromise) {
      const pending = project.agents
        .get(config.agents.orchestrator)
        .then((agent) => {
          const definition = agent.versions.latest.definition;
          if (!isPromptDefinition(definition)) {
            throw new TypeError(
              `El agente ${config.agents.orchestrator} no tiene una definición prompt con modelo configurado.`,
            );
          }
          return definition;
        });
      const tracked = pending.catch((error: unknown) => {
        if (orchestratorDefinitionPromise === tracked) {
          orchestratorDefinitionPromise = undefined;
        }
        throw error;
      });
      orchestratorDefinitionPromise = tracked;
    }
    return orchestratorDefinitionPromise;
  }

  async function runSpecialist(agentName: string, message: string): Promise<string> {
    const client = specialistClients.get(agentName);
    if (!client) {
      throw new Error(`El agente especialista no está configurado: ${agentName}`);
    }
    return runSpecialistResponse(() =>
      client.responses.create({ input: message }),
    );
  }

  async function executeTool(
    functionName: string,
    rawArguments: unknown,
    entraObjectId: string,
    userMessage: string,
  ): Promise<string> {
    const employee = await consultarEmpleadoPorEntraId(entraObjectId);
    if (!employee) {
      throw new PermissionError(
        "La cuenta ya no tiene un perfil activo en Vitalis.",
      );
    }
    authorizeTool(employee.rol, functionName);
    const args = objectArgument(rawArguments);

    switch (functionName) {
      case "buscar_paciente_admision": {
        const identifier = patientIdentifierArgument(args, "identificador");
        let patient: JsonRecord;
        try {
          patient = await buscarAdmision(identifier);
        } catch (error) {
          if (!(error instanceof Error) || error.name !== "LookupError") throw error;
          patient = { encontrado: false, mensaje: error.message };
          return runSpecialist(
            config.agents.admission,
            "Continúa el proceso de admisión con este resultado exacto de Azure SQL. " +
              "Si no existe el paciente, solicita los datos faltantes sin inventarlos. " +
              "Si existe, confirma la identidad sin exponer datos innecesarios.\n" +
              `Resultado de búsqueda:\n${JSON.stringify(patient)}`,
          );
        }
        return runSpecialist(
          config.agents.admission,
          "Continúa el proceso de admisión con este resultado exacto de Azure SQL. " +
            "Si no existe el paciente, solicita los datos faltantes sin inventarlos. " +
            "Si existe, confirma la identidad sin exponer datos innecesarios.\n" +
            `Resultado de búsqueda:\n${JSON.stringify({ encontrado: true, paciente: patient })}`,
        );
      }
      case "registrar_admision": {
        if (booleanArgument(args, "datos_confirmados") !== true) {
          throw new TypeError(
            "La admisión requiere confirmación explícita de los datos recopilados.",
          );
        }
        const input: AdmissionInput = {
          nss: patientIdentifierArgument(args, "nss"),
          nombre: stringArgument(args, "nombre")!,
          telefono: stringArgument(args, "telefono", true),
          contacto_emergencia: stringArgument(args, "contacto_emergencia", true),
          parentesco: stringArgument(args, "parentesco", true),
          telefono_emergencia: stringArgument(args, "telefono_emergencia", true),
          fecha_nacimiento: stringArgument(args, "fecha_nacimiento", true),
          sexo: stringArgument(args, "sexo", true),
          tipo_sangre: stringArgument(args, "tipo_sangre", true),
          alergias: stringArgument(args, "alergias", true),
          enfermedades_cronicas: stringArgument(args, "enfermedades_cronicas", true),
          cirugias_previas: stringArgument(args, "cirugias_previas", true),
          antecedentes_familiares: stringArgument(args, "antecedentes_familiares", true),
          habitos_toxicologias: stringArgument(args, "habitos_toxicologias", true),
          discapacidades_dispositivos: stringArgument(
            args,
            "discapacidades_dispositivos",
            true,
          ),
        };
        return JSON.stringify(await crearAdmision(input));
      }
      case "obtener_expediente_master": {
        const nss = patientIdentifierArgument(args, "nss");
        return JSON.stringify(await obtenerExpedienteMaster(nss), null, 2);
      }
      case "consultar_historico": {
        const patient = await buscarAdmision(
          patientIdentifierArgument(args, "identificador"),
        );
        const record = await obtenerExpedienteMaster(String(patient.nss));
        return runSpecialist(
          config.agents.history,
          "Presenta únicamente los antecedentes explícitos recibidos. No los " +
            "interpretes clínicamente ni agregues información.\n" +
            `Datos de Azure SQL:\n${JSON.stringify(record.historico, null, 2)}`,
        );
      }
      case "validar_poliza": {
        const patient = await buscarAdmision(
          patientIdentifierArgument(args, "identificador"),
        );
        const policies = await consultarSeguros(String(patient.nss));
        if (policies.length === 0) {
          return "No se encontró una póliza registrada para este NSS.";
        }
        return runSpecialist(
          config.agents.insurance,
          "Informa únicamente los datos explícitos y el estatus de estas pólizas. " +
            "No calcules deducibles ni infieras cobertura.\n" +
            `Datos de Azure SQL:\n${JSON.stringify(policies, null, 2)}\n` +
            `Motivo informado: ${stringArgument(args, "motivo")!}`,
        );
      }
      case "evaluar_consulta_medica": {
        const nss = patientIdentifierArgument(args, "nss");
        const motivo = stringArgument(args, "motivo_consulta")!;
        const vitalSigns = stringArgument(args, "signos_vitales")!;
        const catalogTerm = stringArgument(args, "termino_catalogo", true);
        const catalogKey = stringArgument(args, "clave_catalogo", true);
        const record = await obtenerExpedienteMaster(nss);
        const medicationCatalog =
          catalogTerm?.trim() || catalogKey?.trim()
            ? await buscarCatalogoMedicamentos(
                catalogTerm ?? "",
                catalogKey,
              )
            : [];
        const clinicalInput = JSON.stringify({
          nss,
          motivo_consulta: motivo,
          signos_vitales: vitalSigns,
          expediente: record,
          catalogo_medicamentos: medicationCatalog,
        });
        const responseText = await runSpecialist(
          config.agents.medical,
          "Evalúa síntomas y signos vitales según tus instrucciones clínicas. " +
            "Revisa antecedentes y alergias del expediente y no prescribas si no " +
            "puedes validar seguridad. Responde exclusivamente un objeto JSON con " +
            "las claves notas_medicas (texto), diagnostico (texto) y recetas (lista " +
            "de objetos con medicamento, dosis_y_tiempo y cantidad positiva de " +
            "unidades de inventario; medicamento debe ser la clave oficial o el " +
            "nombre exacto del insumo del catálogo. La cantidad debe ser explícita " +
            "y corresponder a las unidades que se prescriben, no a una dosis aislada; " +
            "lista vacía si no aplica). " +
            "Usa el catálogo solo como referencia factual; no deduzcas una dosis ni " +
            "tratamiento personalizado a partir de él. No incluyas markdown ni claves distintas.\n" +
            `Datos recibidos:\n${clinicalInput}`,
        );
        const result = parseMedicalResult(responseText);
        const visit = await registrarAtencion({
          nss,
          motivo_consulta: motivo,
          signos_vitales: vitalSigns,
          notas_medicas: result.notas_medicas,
          diagnostico: result.diagnostico,
          recetas: result.recetas,
        });
        return JSON.stringify(
          { atencion: visit, resultado_medico: result },
          null,
          2,
        );
      }
      case "gestionar_farmacia": {
        return executePharmacyAction(args, userMessage);
      }
      case "consultar_catalogo_medicamentos": {
        return executeMedicationCatalogSearch(args);
      }
      default:
        throw new Error(`Herramienta no soportada: ${functionName}`);
    }
  }

  async function chat(
    messages: ChatMessage[],
    entraObjectId: string,
  ): Promise<{ response: string }> {
    if (!entraObjectId.trim()) {
      throw new PermissionError("Se requiere la identidad autenticada del empleado.");
    }
    const userMessage = messages.at(-1)?.content;
    if (!userMessage) {
      throw new TypeError("El historial debe terminar con un mensaje del usuario.");
    }
    const employee = await consultarEmpleadoPorEntraId(entraObjectId);
    if (!employee) {
      throw new PermissionError(
        "La cuenta ya no tiene un perfil activo en Vitalis.",
      );
    }

    const definition = await getOrchestratorDefinition();
    const instructions = [
      definition.instructions,
      `Contexto de acceso: rol activo del empleado = ${employee.rol}. Usa exclusivamente herramientas autorizadas para este rol.`,
      AUTHORIZATION_DENIAL_INSTRUCTION,
      MEDICATION_CATALOG_INSTRUCTION,
      "No valides formatos de NSS, cédulas ni identificadores por longitud o caracteres. Siempre invoca la herramienta de búsqueda con el valor extraído (incluyendo códigos de demostración tipo DEMO-XXXX) antes de dar una respuesta.",
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n");
    try {
      let response = await withContentPolicyHandling(() =>
        openAIClient.responses.create({
          model: definition.model,
          instructions,
          input: messages.map(({ role, content }) => ({ role, content })),
          tools: functionTools,
          tool_choice: "auto",
        }),
      );

      for (let roundIndex = 0; roundIndex <= MAX_TOOL_ROUNDS; roundIndex += 1) {
        if (isContentPolicyBlock(response)) {
          return { response: CONTENT_POLICY_RESPONSE };
        }
        const functionCalls = response.output.filter(
          (item): item is ResponseFunctionToolCall =>
            item.type === "function_call",
        );
        if (functionCalls.length === 0) {
          if (!response.output_text) {
            throw new Error("El Orquestador terminó sin producir una respuesta.");
          }
          return { response: response.output_text };
        }
        if (roundIndex === MAX_TOOL_ROUNDS) break;

        const outputs: Array<{
          type: "function_call_output";
          call_id: string;
          output: string;
        }> = [];
        for (const call of functionCalls) {
          const argumentsValue: unknown = JSON.parse(call.arguments);
          let output: string;
          try {
            output = await executeTool(
              call.name,
              argumentsValue,
              entraObjectId,
              userMessage,
            );
          } catch (error) {
            const denial = authorizationDenialResponse(error);
            if (denial) return { response: denial };
            throw error;
          }
          outputs.push({
            type: "function_call_output",
            call_id: call.call_id,
            output,
          });
        }
        response = await withContentPolicyHandling(() =>
          openAIClient.responses.create({
            model: definition.model,
            instructions,
            input: outputs,
            previous_response_id: response.id,
            tools: functionTools,
            tool_choice: "auto",
          }),
        );
      }

      throw new Error(
        `El Orquestador excedió el límite de ${MAX_TOOL_ROUNDS} rondas de herramientas.`,
      );
    } catch (error) {
      if (error instanceof ContentPolicyBlockedError) {
        return { response: CONTENT_POLICY_RESPONSE };
      }
      throw error;
    }
  }

  return { chat };
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}
