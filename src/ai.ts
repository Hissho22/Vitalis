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
  buscarAdmision,
  consultarEmpleadoPorEntraId,
  consultarSeguros,
  crearAdmision,
  listarRecetasPendientes,
  marcarRecetaEntregada,
  obtenerExpedienteMaster,
  registrarAtencion,
  type AdmissionInput,
  type Recipe,
} from "./db.js";
import { authorizeTool } from "./rbac.js";

const MAX_TOOL_ROUNDS = 8;
type JsonRecord = Record<string, unknown>;

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
  nss: stringParameter("NSS único del paciente"),
  nombre: stringParameter("Nombre completo confirmado"),
  datos_confirmados: { type: "boolean" },
};
for (const field of [
  "telefono",
  "contacto_emergencia",
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
    "Busca en Azure SQL por NSS o nombre exacto; no crea registros.",
    { identificador: stringParameter("NSS o nombre exacto") },
  ),
  functionTool(
    "registrar_admision",
    "Crea admisión e historial usando únicamente datos confirmados por Admisión.",
    admissionProperties,
  ),
  functionTool(
    "consultar_historico",
    "Consulta datos biológicos e históricos explícitos por NSS o nombre exacto.",
    { identificador: stringParameter("NSS o nombre exacto") },
  ),
  functionTool(
    "obtener_expediente_master",
    "Obtiene el expediente consolidado de dbo.master por NSS exacto.",
    { nss: stringParameter("NSS exacto") },
  ),
  functionTool(
    "validar_poliza",
    "Consulta el estatus de póliza; no calcula deducibles ni cobertura.",
    {
      identificador: stringParameter("NSS o nombre exacto"),
      motivo: stringParameter("Motivo de la consulta administrativa"),
    },
  ),
  functionTool(
    "evaluar_consulta_medica",
    "Delega la evaluación clínica al Agente Médico y registra su resultado.",
    {
      nss: stringParameter("NSS exacto"),
      motivo_consulta: stringParameter("Motivo proporcionado"),
      signos_vitales: stringParameter(
        "Signos vitales reportados; no inventar mediciones",
      ),
    },
  ),
  functionTool(
    "gestionar_farmacia",
    "Consulta pendientes o actualiza una receta tras confirmar entrega física.",
    {
      accion: { type: "string", enum: ["pendientes", "entregar"] },
      id_atencion: { type: ["integer", "null"] },
      id_receta: { type: ["integer", "null"] },
      confirmar_entrega: { type: "boolean" },
    },
  ),
];

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
      typeof recipe.medicamento !== "string" ||
      !recipe.medicamento.trim() ||
      typeof recipe.dosis_y_tiempo !== "string" ||
      !recipe.dosis_y_tiempo.trim()
    ) {
      throw new Error("La respuesta contiene una receta incompleta.");
    }
    return {
      medicamento: recipe.medicamento,
      dosis_y_tiempo: recipe.dosis_y_tiempo,
    };
  });

  return {
    notas_medicas: notes,
    diagnostico: diagnosis,
    recetas: validatedRecipes,
  };
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
    const response = await client.responses.create({ input: message });
    if (!response.output_text) {
      throw new Error(
        `El agente especialista ${agentName} terminó sin producir una respuesta.`,
      );
    }
    return response.output_text;
  }

  async function executeTool(
    functionName: string,
    rawArguments: unknown,
    entraObjectId: string,
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
        const identifier = stringArgument(args, "identificador")!;
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
          nss: stringArgument(args, "nss")!,
          nombre: stringArgument(args, "nombre")!,
          telefono: stringArgument(args, "telefono", true),
          contacto_emergencia: stringArgument(args, "contacto_emergencia", true),
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
        const nss = stringArgument(args, "nss")!;
        return JSON.stringify(await obtenerExpedienteMaster(nss), null, 2);
      }
      case "consultar_historico": {
        const patient = await buscarAdmision(
          stringArgument(args, "identificador")!,
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
          stringArgument(args, "identificador")!,
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
        const nss = stringArgument(args, "nss")!;
        const motivo = stringArgument(args, "motivo_consulta")!;
        const vitalSigns = stringArgument(args, "signos_vitales")!;
        const record = await obtenerExpedienteMaster(nss);
        const clinicalInput = JSON.stringify({
          nss,
          motivo_consulta: motivo,
          signos_vitales: vitalSigns,
          expediente: record,
        });
        const responseText = await runSpecialist(
          config.agents.medical,
          "Evalúa síntomas y signos vitales según tus instrucciones clínicas. " +
            "Revisa antecedentes y alergias del expediente y no prescribas si no " +
            "puedes validar seguridad. Responde exclusivamente un objeto JSON con " +
            "las claves notas_medicas (texto), diagnostico (texto) y recetas (lista " +
            "de objetos con medicamento y dosis_y_tiempo; lista vacía si no aplica). " +
            "No incluyas markdown ni claves distintas.\n" +
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
        const action = stringArgument(args, "accion")!;
        const visitId = integerArgument(args, "id_atencion");
        const recipeId = integerArgument(args, "id_receta");
        const confirmed = booleanArgument(args, "confirmar_entrega");
        if (action === "pendientes") {
          if (visitId === null) {
            throw new TypeError("Se requiere id_atencion para consultar pendientes.");
          }
          return JSON.stringify(await listarRecetasPendientes(visitId), null, 2);
        }
        if (action === "entregar") {
          if (recipeId === null) {
            throw new TypeError("Se requiere id_receta para confirmar la entrega.");
          }
          if (!confirmed) {
            throw new TypeError(
              "La entrega física debe ser confirmada por el empleado.",
            );
          }
          await marcarRecetaEntregada(recipeId);
          return JSON.stringify({
            id_receta: recipeId,
            estatus_farmacia: "Entregado",
          });
        }
        throw new TypeError("La acción debe ser 'pendientes' o 'entregar'.");
      }
      default:
        throw new Error(`Herramienta no soportada: ${functionName}`);
    }
  }

  async function chat(
    message: string,
    previousThreadId: string | undefined,
    entraObjectId: string,
  ): Promise<{ response: string; threadId: string }> {
    if (!entraObjectId.trim()) {
      throw new PermissionError("Se requiere la identidad autenticada del empleado.");
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
    ]
      .filter((value): value is string => Boolean(value?.trim()))
      .join("\n\n");
    const threadId =
      previousThreadId ?? (await openAIClient.conversations.create()).id;
    let response = await openAIClient.responses.create({
      model: definition.model,
      instructions,
      input: message,
      conversation: threadId,
      tools: functionTools,
      tool_choice: "auto",
    });

    for (let roundIndex = 0; roundIndex <= MAX_TOOL_ROUNDS; roundIndex += 1) {
      const functionCalls = response.output.filter(
        (item): item is ResponseFunctionToolCall =>
          item.type === "function_call",
      );
      if (functionCalls.length === 0) {
        if (!response.output_text) {
          throw new Error("El Orquestador terminó sin producir una respuesta.");
        }
        return { response: response.output_text, threadId };
      }
      if (roundIndex === MAX_TOOL_ROUNDS) break;

      const outputs: Array<{
        type: "function_call_output";
        call_id: string;
        output: string;
      }> = [];
      for (const call of functionCalls) {
        const argumentsValue: unknown = JSON.parse(call.arguments);
        const output = await executeTool(
          call.name,
          argumentsValue,
          entraObjectId,
        );
        outputs.push({
          type: "function_call_output",
          call_id: call.call_id,
          output,
        });
      }
      response = await openAIClient.responses.create({
        model: definition.model,
        instructions,
        input: outputs,
        conversation: threadId,
        tools: functionTools,
        tool_choice: "auto",
      });
    }

    throw new Error(
      `El Orquestador excedió el límite de ${MAX_TOOL_ROUNDS} rondas de herramientas.`,
    );
  }

  return { chat };
}

export class PermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PermissionError";
  }
}
