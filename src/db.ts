import sql from "mssql";

export interface Employee {
  id_empleado: string;
  entra_object_id: string;
  nombre: string;
  correo: string;
  rol: string;
  estatus: string;
}

export interface AdmissionInput {
  nss: string;
  nombre: string;
  telefono: string | null;
  contacto_emergencia: string | null;
  parentesco: string | null;
  telefono_emergencia: string | null;
  fecha_nacimiento: string | null;
  sexo: string | null;
  tipo_sangre: string | null;
  alergias: string | null;
  enfermedades_cronicas: string | null;
  cirugias_previas: string | null;
  antecedentes_familiares: string | null;
  habitos_toxicologias: string | null;
  discapacidades_dispositivos: string | null;
}

export interface Recipe {
  medicamento: string;
  dosis_y_tiempo: string;
  cantidad: number;
}

export interface PharmacyDeliveryResult {
  medicamento: string;
  clave: string;
  cantidad_entregada: number;
  stock_restante: number;
}

export interface PharmacyMedicationCandidate {
  clave: string;
  insumo: string | null;
  descripcion: string | null;
}

export type PharmacyInventoryErrorCode =
  | "quantity_missing"
  | "medication_not_found"
  | "medication_ambiguous"
  | "medication_selection_required"
  | "stock_unavailable"
  | "insufficient_stock";

export class PharmacyInventoryError extends Error {
  constructor(
    readonly code: PharmacyInventoryErrorCode,
    message: string,
    readonly candidates: PharmacyMedicationCandidate[] = [],
  ) {
    super(message);
    this.name = "PharmacyInventoryError";
  }
}

export function normalizeMedicationText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .toLocaleUpperCase("es-MX");
}

export interface MedicationCatalogItem {
  clave: string;
  insumo: string | null;
  descripcion: string | null;
  indicaciones: string | null;
  stock: number;
}

export interface VisitInput {
  nss: string;
  motivo_consulta: string;
  signos_vitales: string;
  notas_medicas: string;
  diagnostico: string;
  recetas: Recipe[];
}

export interface PatientRecord {
  [key: string]: unknown;
}

export interface MasterRecord {
  paciente: PatientRecord;
  historico: PatientRecord;
  seguros: PatientRecord[];
  atenciones: Array<PatientRecord & { farmacia: PatientRecord[] }>;
  recetas_sin_atencion?: PatientRecord[];
}

const stringType = sql.NVarChar(sql.MAX);

function parseConnectionString(connectionString: string): sql.config {
  const segments: string[] = [];
  let segment = "";
  let inBraces = false;
  for (let index = 0; index < connectionString.length; index += 1) {
    const character = connectionString[index]!;
    if (character === "{" && !inBraces) inBraces = true;
    else if (character === "}" && inBraces) {
      if (connectionString[index + 1] === "}") {
        segment += "}}";
        index += 1;
        continue;
      }
      inBraces = false;
    }
    if (character === ";" && !inBraces) {
      segments.push(segment);
      segment = "";
    } else {
      segment += character;
    }
  }
  if (inBraces) throw new Error("AZURE_SQL_CONNECTION_STRING tiene llaves incompletas.");
  segments.push(segment);

  const entries = segments
    .filter((entry) => entry.includes("="))
    .map((entry) => {
      const separator = entry.indexOf("=");
      const key = entry.slice(0, separator).trim().toLowerCase();
      const rawValue = entry.slice(separator + 1).trim();
      const value =
        rawValue.startsWith("{") && rawValue.endsWith("}")
          ? rawValue.slice(1, -1).replace(/}}/g, "}")
          : rawValue;
      return [key, value] as const;
    });
  const values = new Map(entries);
  const get = (...names: string[]) => {
    for (const name of names) {
      const value = values.get(name);
      if (value) return value;
    }
    return undefined;
  };

  const rawServer = get("server", "data source", "address", "addr", "network address");
  const database = get("database", "initial catalog");
  const user = get("uid", "user id", "user");
  const password = get("pwd", "password");
  if (!rawServer || !database || !user || !password) {
    throw new Error(
      "AZURE_SQL_CONNECTION_STRING debe especificar servidor, base de datos, usuario y contraseña.",
    );
  }

  const serverAddress = rawServer.replace(/^tcp:/i, "");
  const comma = serverAddress.lastIndexOf(",");
  let server = serverAddress;
  let port = 1433;
  if (comma > -1) {
    const portText = serverAddress.slice(comma + 1);
    if (!/^\d+$/.test(portText)) {
      throw new Error("El puerto de Azure SQL no es válido.");
    }
    port = Number(portText);
    server = serverAddress.slice(0, comma);
  }
  if (!server || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("El servidor o puerto de Azure SQL no es válido.");
  }

  const timeoutSeconds = Number(
    get("connection timeout", "connect timeout") ?? "30",
  );
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error("Connection Timeout debe ser un número positivo.");
  }
  const booleanSetting = (name: string, defaultValue: boolean): boolean => {
    const value = values.get(name)?.toLowerCase();
    if (value === undefined) return defaultValue;
    if (["yes", "true", "1"].includes(value)) return true;
    if (["no", "false", "0"].includes(value)) return false;
    throw new Error(`${name} debe ser yes o no.`);
  };

  return {
    server,
    port,
    database,
    user,
    password,
    connectionTimeout: Math.ceil(timeoutSeconds * 1000),
    requestTimeout: 30_000,
    // Las conexiones inactivas se liberan antes de que Azure SQL cierre el socket.
    pool: { max: 10, min: 0, idleTimeoutMillis: 30_000 },
    options: {
      encrypt: booleanSetting("encrypt", true),
      trustServerCertificate: booleanSetting("trustservercertificate", false),
      enableArithAbort: true,
    },
  };
}

let poolPromise: Promise<sql.ConnectionPool> | undefined;

async function getPool(): Promise<sql.ConnectionPool> {
  if (poolPromise) return poolPromise;

  const connectionString = process.env.AZURE_SQL_CONNECTION_STRING?.trim();
  if (!connectionString) {
    throw new Error("Falta configurar AZURE_SQL_CONNECTION_STRING.");
  }
  const pool = new sql.ConnectionPool(parseConnectionString(connectionString));
  // Un error del pool (socket perdido) invalida el pool para reconectar en la siguiente solicitud.
  pool.on("error", () => {
    if (poolPromise === tracked) poolPromise = undefined;
    pool.close().catch(() => undefined);
  });
  const pending = pool.connect();
  const tracked = pending.catch((error: unknown) => {
    if (poolPromise === tracked) poolPromise = undefined;
    throw error;
  });
  poolPromise = tracked;
  return tracked;
}

const CONNECTION_ERROR_CODES = new Set([
  "ECONNCLOSED",
  "ESOCKET",
  "ENOTOPEN",
  "ECONNRESET",
  "ETIMEDOUT",
  "ELOGIN",
]);

export function isConnectionError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = "code" in error ? error.code : undefined;
  return typeof code === "string" && CONNECTION_ERROR_CODES.has(code);
}

async function resetPool(): Promise<void> {
  const pending = poolPromise;
  poolPromise = undefined;
  if (!pending) return;
  try {
    await (await pending).close();
  } catch {
    // El pool ya estaba roto; se descarta sin propagar el error.
  }
}

export async function closeDatabase(): Promise<void> {
  const pending = poolPromise;
  poolPromise = undefined;
  if (pending) {
    const pool = await pending;
    await pool.close();
  }
}

async function rows<T extends object>(
  query: string,
  parameters: Record<string, string | number | null>,
): Promise<T[]> {
  const execute = async () => {
    const request = (await getPool()).request();
    for (const [name, value] of Object.entries(parameters)) {
      if (typeof value === "number") request.input(name, sql.Int, value);
      else request.input(name, stringType, value);
    }
    return request.query<T>(query);
  };
  let result: sql.IResult<T>;
  try {
    result = await execute();
  } catch (error) {
    // Solo las lecturas se reintentan: repetir una escritura podría duplicarla.
    if (!isConnectionError(error) || !/^\s*(SELECT|WITH)\b/i.test(query)) {
      throw error;
    }
    await resetPool();
    result = await execute();
  }
  return result.recordset.map((row) => {
    const normalized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      normalized[key] =
        key === "fecha_nacimiento" && value instanceof Date
          ? value.toISOString().slice(0, 10)
          : value instanceof Date
            ? value.toISOString()
            : value;
    }
    return normalized as T;
  });
}

async function runTransaction<T>(
  operation: (transaction: sql.Transaction) => Promise<T>,
): Promise<T> {
  let transaction = new sql.Transaction(await getPool());
  try {
    await transaction.begin();
  } catch (error) {
    // Aún no se ejecutó nada: es seguro reconectar y reiniciar.
    if (!isConnectionError(error)) throw error;
    await resetPool();
    transaction = new sql.Transaction(await getPool());
    await transaction.begin();
  }
  try {
    const result = await operation(transaction);
    await transaction.commit();
    return result;
  } catch (error) {
    try {
      await transaction.rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [error, rollbackError],
        "La operación SQL falló y tampoco se pudo revertir la transacción.",
      );
    }
    throw error;
  }
}

function requiredText(value: string, field: string): string {
  if (!value.trim()) throw new TypeError(`${field} no puede estar vacío.`);
  return value.trim();
}

export async function consultarEmpleadoPorEntraId(
  objectId: string,
  includeInactive = false,
): Promise<Employee | null> {
  const key = requiredText(objectId, "El Object ID de Entra ID");
  const result = await rows<Employee>(
    `
      SELECT id_empleado, entra_object_id, nombre, correo, rol, estatus
      FROM dbo.empleados
      WHERE entra_object_id = CONVERT(uniqueidentifier, @objectId)
        AND (@incluirInactivos = 1 OR LOWER(LTRIM(RTRIM(estatus))) = 'activo');
    `,
    { objectId: key, incluirInactivos: includeInactive ? 1 : 0 },
  );
  return result[0] ?? null;
}

export async function buscarCatalogoMedicamentos(
  termino: string,
  clave: string | null,
): Promise<MedicationCatalogItem[]> {
  const searchTerm = termino.trim();
  const exactKey = clave?.trim() || null;
  if (!searchTerm && !exactKey) {
    throw new TypeError("Proporciona un término de búsqueda o una clave.");
  }
  if (searchTerm.length > 500) {
    throw new TypeError("El término de búsqueda excede 500 caracteres.");
  }
  if (exactKey && exactKey.length > 255) {
    throw new TypeError("La clave excede 255 caracteres.");
  }

  return rows<MedicationCatalogItem>(
    `
      SELECT TOP (5)
        [Clave] AS clave,
        [Insumo] AS insumo,
        [Descripción] AS descripcion,
        [Indicaciones] AS indicaciones,
        [stock] AS stock
      FROM dbo.medicamentos
      WHERE (
          @termino = N''
          OR [Insumo] COLLATE Modern_Spanish_CI_AI LIKE
             (N'%' + @termino + N'%') COLLATE Modern_Spanish_CI_AI
          OR [Descripción] COLLATE Modern_Spanish_CI_AI LIKE
             (N'%' + @termino + N'%') COLLATE Modern_Spanish_CI_AI
          OR [Indicaciones] COLLATE Modern_Spanish_CI_AI LIKE
             (N'%' + @termino + N'%') COLLATE Modern_Spanish_CI_AI
        )
        AND (@clave IS NULL OR [Clave] = @clave)
      ORDER BY
        CASE WHEN @clave IS NOT NULL AND [Clave] = @clave THEN 0 ELSE 1 END,
        [Clave];
    `,
    { termino: searchTerm, clave: exactKey },
  );
}

export const STOCK_QUERY_MAX_LIMIT = 50;

export type StockCriterion = "menor" | "mayor";

export interface StockItem {
  clave: string;
  insumo: string | null;
  descripcion: string | null;
  stock: number;
}

export function parseStockQuery(
  criterio: unknown,
  limite: unknown,
): { criterio: StockCriterion; limite: number } {
  if (criterio !== "menor" && criterio !== "mayor") {
    throw new TypeError("El criterio debe ser 'menor' o 'mayor'.");
  }
  if (
    typeof limite !== "number" ||
    !Number.isInteger(limite) ||
    limite < 1 ||
    limite > STOCK_QUERY_MAX_LIMIT
  ) {
    throw new TypeError(
      `El límite debe ser un entero entre 1 y ${STOCK_QUERY_MAX_LIMIT}.`,
    );
  }
  return { criterio, limite };
}

export async function consultarInventarioStock(
  criterio: StockCriterion,
  limite: number,
): Promise<StockItem[]> {
  const parsed = parseStockQuery(criterio, limite);
  const direction = parsed.criterio === "menor" ? "ASC" : "DESC";
  return rows<StockItem>(
    `
      SELECT TOP (@limite)
        [Clave] AS clave,
        [Insumo] AS insumo,
        [Descripción] AS descripcion,
        [stock] AS stock
      FROM dbo.medicamentos
      WHERE [stock] IS NOT NULL
      ORDER BY [stock] ${direction}, [Clave];
    `,
    { limite: parsed.limite },
  );
}

export interface HistoricalInput {
  nss: string;
  fecha_nacimiento: string | null;
  sexo: string | null;
  tipo_sangre: string | null;
  alergias: string | null;
  enfermedades_cronicas: string | null;
  cirugias_previas: string | null;
  antecedentes_familiares: string | null;
  habitos_toxicologias: string | null;
  discapacidades_dispositivos: string | null;
}

export async function registrarOActualizarHistorico(
  input: HistoricalInput,
): Promise<{ nss: string; estatus: "Registrado" | "Actualizado" }> {
  const nss = requiredText(input.nss, "NSS");
  if (
    input.fecha_nacimiento !== null &&
    !/^\d{4}-\d{2}-\d{2}$/.test(input.fecha_nacimiento.trim())
  ) {
    throw new TypeError("La fecha de nacimiento debe tener formato AAAA-MM-DD.");
  }

  return runTransaction(async (transaction) => {
    const patient = transaction.request();
    patient.input("nss", stringType, nss);
    const found = await patient.query(
      "SELECT nss FROM dbo.admision WITH (UPDLOCK, HOLDLOCK) WHERE nss = @nss;",
    );
    if (found.recordset.length === 0) {
      throw new LookupError("No existe un paciente con ese NSS en admisión.");
    }

    const history = transaction.request();
    history.input("nss", stringType, nss);
    history.input("fechaNacimiento", stringType, input.fecha_nacimiento?.trim() ?? null);
    history.input("sexo", stringType, input.sexo);
    history.input("tipoSangre", stringType, input.tipo_sangre);
    history.input("alergias", stringType, input.alergias);
    history.input("enfermedadesCronicas", stringType, input.enfermedades_cronicas);
    history.input("cirugiasPrevias", stringType, input.cirugias_previas);
    history.input("antecedentesFamiliares", stringType, input.antecedentes_familiares);
    history.input("habitosToxicologias", stringType, input.habitos_toxicologias);
    history.input(
      "discapacidadesDispositivos",
      stringType,
      input.discapacidades_dispositivos,
    );
    // Los valores null conservan el dato existente al actualizar.
    const updated = await history.query(`
      UPDATE dbo.historicos
      SET fecha_nacimiento = COALESCE(CONVERT(date, @fechaNacimiento), fecha_nacimiento),
          sexo = COALESCE(@sexo, sexo),
          tipo_sangre = COALESCE(@tipoSangre, tipo_sangre),
          alergias = COALESCE(@alergias, alergias),
          enfermedades_cronicas = COALESCE(@enfermedadesCronicas, enfermedades_cronicas),
          cirugias_previas = COALESCE(@cirugiasPrevias, cirugias_previas),
          antecedentes_familiares = COALESCE(@antecedentesFamiliares, antecedentes_familiares),
          habitos_toxicologias = COALESCE(@habitosToxicologias, habitos_toxicologias),
          discapacidades_dispositivos = COALESCE(@discapacidadesDispositivos, discapacidades_dispositivos)
      WHERE nss = @nss;
    `);
    if ((updated.rowsAffected[0] ?? 0) > 0) {
      return { nss, estatus: "Actualizado" as const };
    }
    await history.query(`
      INSERT INTO dbo.historicos (
        nss, fecha_nacimiento, sexo, tipo_sangre, alergias,
        enfermedades_cronicas, cirugias_previas, antecedentes_familiares,
        habitos_toxicologias, discapacidades_dispositivos
      )
      VALUES (
        @nss, CONVERT(date, @fechaNacimiento), @sexo, @tipoSangre, @alergias,
        @enfermedadesCronicas, @cirugiasPrevias, @antecedentesFamiliares,
        @habitosToxicologias, @discapacidadesDispositivos
      );
    `);
    return { nss, estatus: "Registrado" as const };
  });
}

export async function buscarAdmision(
  identifier: string,
): Promise<PatientRecord> {
  const key = requiredText(identifier, "El NSS o nombre");
  const result = await rows<PatientRecord>(
    `
      SELECT nss, nombre, telefono, contacto_emergencia, parentesco,
             telefono_emergencia
      FROM dbo.admision
      WHERE nss = @identifier OR nombre = @identifier
      ORDER BY nss;
    `,
    { identifier: key },
  );
  if (result.length === 0) {
    throw new LookupError("No se encontró un paciente con ese NSS o nombre.");
  }
  if (result.length > 1) {
    throw new LookupError(
      "El nombre coincide con varios pacientes; proporciona un NSS exacto.",
    );
  }
  return result[0]!;
}

export class LookupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LookupError";
  }
}

export async function crearAdmision(
  input: AdmissionInput,
): Promise<{ nss: string; nombre: string; estatus: string }> {
  const nss = requiredText(input.nss, "NSS");
  const nombre = requiredText(input.nombre, "El nombre");

  await runTransaction(async (transaction) => {
    const admission = transaction.request();
    admission.input("nss", stringType, nss);
    admission.input("nombre", stringType, nombre);
    admission.input("telefono", stringType, input.telefono);
    admission.input("contactoEmergencia", stringType, input.contacto_emergencia);
    admission.input("parentesco", sql.NVarChar(50), input.parentesco);
    admission.input("telefonoEmergencia", stringType, input.telefono_emergencia);
    await admission.query(`
      INSERT INTO dbo.admision
        (nss, nombre, telefono, contacto_emergencia, parentesco,
         telefono_emergencia)
      VALUES
        (@nss, @nombre, @telefono, @contactoEmergencia, @parentesco,
         @telefonoEmergencia);
    `);

    const history = transaction.request();
    history.input("nss", stringType, nss);
    history.input("fechaNacimiento", stringType, input.fecha_nacimiento);
    history.input("sexo", stringType, input.sexo);
    history.input("tipoSangre", stringType, input.tipo_sangre);
    history.input("alergias", stringType, input.alergias);
    history.input("enfermedadesCronicas", stringType, input.enfermedades_cronicas);
    history.input("cirugiasPrevias", stringType, input.cirugias_previas);
    history.input("antecedentesFamiliares", stringType, input.antecedentes_familiares);
    history.input("habitosToxicologias", stringType, input.habitos_toxicologias);
    history.input(
      "discapacidadesDispositivos",
      stringType,
      input.discapacidades_dispositivos,
    );
    await history.query(`
      INSERT INTO dbo.historicos (
        nss, fecha_nacimiento, sexo, tipo_sangre, alergias,
        enfermedades_cronicas, cirugias_previas, antecedentes_familiares,
        habitos_toxicologias, discapacidades_dispositivos
      )
      VALUES (
        @nss, CONVERT(date, @fechaNacimiento), @sexo, @tipoSangre, @alergias,
        @enfermedadesCronicas, @cirugiasPrevias, @antecedentesFamiliares,
        @habitosToxicologias, @discapacidadesDispositivos
      );
    `);
  });

  return { nss, nombre, estatus: "Registrado" };
}

export async function obtenerExpedienteMaster(
  nss: string,
): Promise<MasterRecord> {
  const key = requiredText(nss, "El NSS");
  const records = await rows<PatientRecord>(
    "SELECT * FROM dbo.master WHERE nss = @nss;",
    { nss: key },
  );
  if (records.length === 0) {
    throw new LookupError("No se encontró expediente para el NSS indicado.");
  }

  const patientFields = new Set([
    "nss",
    "nombre",
    "telefono",
    "contacto_emergencia",
    "parentesco",
    "telefono_emergencia",
  ]);
  const historyFields = new Set([
    "fecha_nacimiento",
    "sexo",
    "tipo_sangre",
    "alergias",
    "enfermedades_cronicas",
    "cirugias_previas",
    "antecedentes_familiares",
    "habitos_toxicologias",
    "discapacidades_dispositivos",
  ]);
  const insuranceFields = new Set([
    "id_seguro",
    "aseguradora",
    "estatus",
    "estatus_seguro",
  ]);
  const visitFields = new Set([
    "id_atencion",
    "fecha_hora",
    "motivo_consulta",
    "signos_vitales",
    "notas_medicas",
    "diagnostico",
  ]);
  const recipeFields = new Set([
    "id_receta",
    "medicamento",
    "dosis_y_tiempo",
    "cantidad",
    "estatus_farmacia",
  ]);
  const project = (
    record: PatientRecord,
    fields: ReadonlySet<string>,
  ): PatientRecord =>
    Object.fromEntries(
      Object.entries(record).filter(([field]) => fields.has(field)),
    );

  const patient = project(records[0]!, patientFields);
  const history = project(records[0]!, historyFields);
  const insurances = new Map<unknown, PatientRecord>();
  const visits = new Map<unknown, PatientRecord>();
  const recipes = new Map<unknown, PatientRecord>();
  const recipeVisitIds = new Map<unknown, unknown>();
  for (const record of records) {
    const insuranceId = record.id_seguro;
    if (insuranceId !== null && insuranceId !== undefined) {
      insurances.set(insuranceId, project(record, insuranceFields));
    }
    const visitId = record.id_atencion;
    if (visitId !== null && visitId !== undefined) {
      visits.set(visitId, project(record, visitFields));
    }
    const recipeId = record.id_receta;
    if (recipeId !== null && recipeId !== undefined) {
      recipes.set(recipeId, project(record, recipeFields));
      recipeVisitIds.set(recipeId, visitId);
    }
  }

  const visitsById = new Map<unknown, PatientRecord & { farmacia: PatientRecord[] }>(
    [...visits].map(([id, visit]) => [id, { ...visit, farmacia: [] }]),
  );
  const unattachedRecipes: PatientRecord[] = [];
  for (const [recipeId, recipe] of recipes) {
    const visitId = recipeVisitIds.get(recipeId);
    const visit = visitsById.get(visitId);
    if (!visit) unattachedRecipes.push(recipe);
    else visit.farmacia.push(recipe);
  }

  const result: MasterRecord = {
    paciente: patient,
    historico: history,
    seguros: [...insurances.values()],
    atenciones: [...visitsById.values()],
  };
  if (unattachedRecipes.length > 0) {
    result.recetas_sin_atencion = unattachedRecipes;
  }
  return result;
}

export async function consultarSeguros(
  nss: string,
): Promise<PatientRecord[]> {
  const key = requiredText(nss, "El NSS");
  return rows<PatientRecord>(
    `
      SELECT id_seguro, nss, aseguradora, estatus
      FROM dbo.seguros
      WHERE nss = @nss
      ORDER BY id_seguro;
    `,
    { nss: key },
  );
}

export async function registrarAtencion(
  input: VisitInput,
): Promise<{ id_atencion: number; id_recetas: number[] }> {
  const requiredValues = [
    input.nss,
    input.motivo_consulta,
    input.signos_vitales,
    input.notas_medicas,
    input.diagnostico,
  ];
  if (requiredValues.some((value) => !value.trim())) {
    throw new TypeError("Los datos principales de la atención son obligatorios.");
  }
  if (!Array.isArray(input.recetas)) {
    throw new TypeError("Las recetas deben enviarse como una lista.");
  }
  for (const recipe of input.recetas) {
    if (
      !recipe.medicamento.trim() ||
      !recipe.dosis_y_tiempo.trim() ||
      !Number.isInteger(recipe.cantidad) ||
      recipe.cantidad <= 0 ||
      recipe.cantidad > 2_147_483_647
    ) {
      throw new TypeError(
        "Cada receta requiere medicamento, dosis/tiempo y una cantidad positiva en unidades de inventario.",
      );
    }
  }

  return runTransaction(async (transaction) => {
    const visit = transaction.request();
    visit.input("nss", stringType, input.nss.trim());
    visit.input("motivoConsulta", stringType, input.motivo_consulta.trim());
    visit.input("signosVitales", stringType, input.signos_vitales.trim());
    visit.input("notasMedicas", stringType, input.notas_medicas.trim());
    visit.input("diagnostico", stringType, input.diagnostico.trim());
    const visitResult = await visit.query<{ id_atencion: number }>(`
      INSERT INTO dbo.atencion
        (nss, motivo_consulta, signos_vitales, notas_medicas, diagnostico)
      OUTPUT INSERTED.id_atencion
      VALUES
        (@nss, @motivoConsulta, @signosVitales, @notasMedicas, @diagnostico);
    `);
    const visitId = visitResult.recordset[0]?.id_atencion;
    if (visitId === undefined) {
      throw new Error("SQL no devolvió el ID de la atención creada.");
    }

    const recipeIds: number[] = [];
    for (const recipe of input.recetas) {
      const request = transaction.request();
      request.input("visitId", sql.Int, visitId);
      request.input("medicamento", stringType, recipe.medicamento.trim());
      request.input("dosisTiempo", stringType, recipe.dosis_y_tiempo.trim());
      request.input("cantidad", sql.Int, recipe.cantidad);
      const recipeResult = await request.query<{ id_receta: number }>(`
        INSERT INTO dbo.farmacia
          (id_atencion, medicamento, dosis_y_tiempo, cantidad)
        OUTPUT INSERTED.id_receta
        VALUES (@visitId, @medicamento, @dosisTiempo, @cantidad);
      `);
      const recipeId = recipeResult.recordset[0]?.id_receta;
      if (recipeId === undefined) {
        throw new Error("SQL no devolvió el ID de una receta creada.");
      }
      recipeIds.push(recipeId);
    }
    return { id_atencion: visitId, id_recetas: recipeIds };
  });
}

export async function listarRecetasPendientes(
  nss: string,
): Promise<PatientRecord[]> {
  const key = requiredText(nss, "El NSS");
  return rows<PatientRecord>(
    `
      SELECT f.id_receta, f.id_atencion, f.medicamento, f.dosis_y_tiempo,
             f.cantidad, f.estatus_farmacia
      FROM dbo.farmacia AS f
      INNER JOIN dbo.atencion AS a ON a.id_atencion = f.id_atencion
      WHERE a.nss = @nss AND f.estatus_farmacia = 'Pendiente'
      ORDER BY f.id_atencion, f.id_receta;
    `,
    { nss: key },
  );
}

export const PENDING_RECIPES_MAX_LIMIT = 100;

// Bandeja general de recetas pendientes, sin exigir NSS.
export async function listarTodasRecetasPendientes(
  limit = 50,
): Promise<PatientRecord[]> {
  const safeLimit = Number.isInteger(limit)
    ? Math.min(Math.max(limit, 1), PENDING_RECIPES_MAX_LIMIT)
    : 50;
  return rows<PatientRecord>(
    `
      SELECT TOP (@limite) f.id_receta, f.id_atencion, a.nss, f.medicamento,
             f.dosis_y_tiempo, f.cantidad, f.estatus_farmacia
      FROM dbo.farmacia AS f
      INNER JOIN dbo.atencion AS a ON a.id_atencion = f.id_atencion
      WHERE f.estatus_farmacia = 'Pendiente'
      ORDER BY f.id_atencion, f.id_receta;
    `,
    { limite: safeLimit },
  );
}

export async function consultarRecetaPorId(
  idReceta: number,
): Promise<PatientRecord | null> {
  if (!Number.isInteger(idReceta) || idReceta <= 0) {
    throw new TypeError("El ID de receta debe ser positivo.");
  }
  const result = await rows<PatientRecord>(
    `
      SELECT f.id_receta, f.id_atencion, a.nss, f.medicamento,
             f.dosis_y_tiempo, f.cantidad, f.estatus_farmacia
      FROM dbo.farmacia AS f
      INNER JOIN dbo.atencion AS a ON a.id_atencion = f.id_atencion
      WHERE f.id_receta = @idReceta;
    `,
    { idReceta },
  );
  return result[0] ?? null;
}

export async function marcarRecetaEntregada(
  idReceta: number,
  nss: string,
  selectedMedicationKey: string | null = null,
): Promise<PharmacyDeliveryResult> {
  if (!Number.isInteger(idReceta) || idReceta <= 0) {
    throw new TypeError("El ID de receta debe ser positivo.");
  }
  const key = requiredText(nss, "El NSS");
  const medicationKey = selectedMedicationKey?.trim() || null;
  if (medicationKey && medicationKey.length > 255) {
    throw new TypeError("La clave del medicamento excede 255 caracteres.");
  }
  return runTransaction(async (transaction) => {
    const recipeRequest = transaction.request();
    recipeRequest.input("idReceta", sql.Int, idReceta);
    recipeRequest.input("nss", stringType, key);
    const recipeResult = await recipeRequest.query<{
      medicamento: string;
      cantidad: number | null;
    }>(`
      SELECT f.medicamento, f.cantidad
      FROM dbo.farmacia AS f WITH (UPDLOCK, HOLDLOCK)
      INNER JOIN dbo.atencion AS a ON a.id_atencion = f.id_atencion
      WHERE f.id_receta = @idReceta
        AND a.nss = @nss
        AND f.estatus_farmacia = 'Pendiente';
    `);
    const recipe = recipeResult.recordset[0];
    if (!recipe) {
      throw new LookupError(
        "La receta no existe o ya no está en estado Pendiente.",
      );
    }
    if (
      typeof recipe.cantidad !== "number" ||
      !Number.isInteger(recipe.cantidad) ||
      recipe.cantidad <= 0
    ) {
      throw new PharmacyInventoryError(
        "quantity_missing",
        "No se registró la entrega porque la receta no tiene una cantidad válida. Solicite que se actualice antes de surtirla.",
      );
    }
    if (!recipe.medicamento.trim() || recipe.medicamento.length > 500) {
      throw new PharmacyInventoryError(
        "medication_not_found",
        "No se registró la entrega porque el medicamento de la receta no es válido. Solicite revisión de la prescripción.",
      );
    }
    const medicationRequest = transaction.request();
    medicationRequest.input("medicamento", stringType, recipe.medicamento.trim());
    medicationRequest.input("selectedKey", stringType, medicationKey);
    const medicationResult = await medicationRequest.query<{
      id: number;
      clave: string;
      insumo: string | null;
      descripcion: string | null;
      stock: number | null;
    }>(`
      SELECT TOP (11)
        id,
        [Clave] AS clave,
        [Insumo] AS insumo,
        [Descripción] AS descripcion,
        [stock] AS stock
      FROM dbo.medicamentos WITH (UPDLOCK, HOLDLOCK)
      WHERE (
          [Clave] COLLATE Modern_Spanish_CI_AI =
             @medicamento COLLATE Modern_Spanish_CI_AI
          OR [Insumo] COLLATE Modern_Spanish_CI_AI LIKE
             (N'%' + @medicamento + N'%') COLLATE Modern_Spanish_CI_AI
          OR [Descripción] COLLATE Modern_Spanish_CI_AI LIKE
             (N'%' + @medicamento + N'%') COLLATE Modern_Spanish_CI_AI
        )
        AND (
          @selectedKey IS NULL
          OR [Clave] COLLATE Modern_Spanish_CI_AI =
             @selectedKey COLLATE Modern_Spanish_CI_AI
        )
      ORDER BY
        CASE WHEN [Clave] COLLATE Modern_Spanish_CI_AI =
          @medicamento COLLATE Modern_Spanish_CI_AI THEN 0 ELSE 1 END,
        [Clave];
    `);
    const inventoryRows = medicationResult.recordset;
    const candidateList = inventoryRows.map((item) => ({
      clave: item.clave,
      insumo: item.insumo,
      descripcion: item.descripcion,
    }));
    if (inventoryRows.length > 10) {
      throw new PharmacyInventoryError(
        "medication_ambiguous",
        "La búsqueda encontró demasiadas presentaciones para seleccionar con seguridad. No se registró la entrega; refine la búsqueda por la clave oficial o el nombre prescrito.",
        candidateList.slice(0, 10),
      );
    }
    if (!selectedMedicationKey && inventoryRows.length > 0) {
      const exactNameMatches = inventoryRows.filter(
        (item) =>
          normalizeMedicationText(item.insumo ?? "") ===
          normalizeMedicationText(recipe.medicamento),
      );
      if (inventoryRows.length !== 1 || exactNameMatches.length !== 1) {
        throw new PharmacyInventoryError(
          "medication_selection_required",
          "La receta coincide con más de una presentación o no identifica exactamente un insumo. No se registró la entrega. Revise las opciones y confirme la clave que coincide exactamente con la prescripción médica.",
          candidateList,
        );
      }
    }
    const medication = inventoryRows[0];
    if (!medication) {
      throw new PharmacyInventoryError(
        "medication_not_found",
        "No se registró la entrega porque el medicamento no coincide con un insumo del catálogo. Verifique su clave o nombre.",
      );
    }
    if (
      selectedMedicationKey &&
      normalizeMedicationText(medication.clave) !==
        normalizeMedicationText(selectedMedicationKey)
    ) {
      throw new PharmacyInventoryError(
        "medication_not_found",
        "La clave seleccionada no coincide con un insumo candidato de esta receta. No se registró la entrega.",
      );
    }
    if (
      typeof medication.stock !== "number" ||
      !Number.isInteger(medication.stock) ||
      medication.stock < 0
    ) {
      throw new PharmacyInventoryError(
        "stock_unavailable",
        "No se registró la entrega porque el stock del insumo no está disponible para validación. Solicite apoyo al área de Farmacia.",
      );
    }
    if (medication.stock < recipe.cantidad) {
      throw new PharmacyInventoryError(
        "insufficient_stock",
        `No hay existencias suficientes: hay ${medication.stock} unidades disponibles y la receta requiere ${recipe.cantidad}. No se registró la entrega.`,
      );
    }

    const stockRequest = transaction.request();
    stockRequest.input("id", sql.Int, medication.id);
    stockRequest.input("cantidad", sql.Int, recipe.cantidad);
    const stockResult = await stockRequest.query<{ stock_restante: number }>(`
      UPDATE dbo.medicamentos
      SET [stock] = [stock] - @cantidad
      OUTPUT INSERTED.[stock] AS stock_restante
      WHERE id = @id
        AND [stock] >= @cantidad;
    `);
    const stockRestante = stockResult.recordset[0]?.stock_restante;
    if (stockRestante === undefined) {
      throw new PharmacyInventoryError(
        "insufficient_stock",
        "No hay existencias suficientes para surtir la receta. No se registró la entrega.",
      );
    }

    const updateRequest = transaction.request();
    updateRequest.input("idReceta", sql.Int, idReceta);
    updateRequest.input("nss", stringType, key);
    const updateResult = await updateRequest.query<{ id_receta: number }>(`
      UPDATE f
      SET estatus_farmacia = 'Entregado'
      OUTPUT INSERTED.id_receta
      FROM dbo.farmacia AS f
      INNER JOIN dbo.atencion AS a ON a.id_atencion = f.id_atencion
      WHERE f.id_receta = @idReceta
        AND a.nss = @nss
        AND f.estatus_farmacia = 'Pendiente';
    `);
    if (!updateResult.recordset[0]) {
      throw new LookupError(
        "La receta no existe o ya no está en estado Pendiente.",
      );
    }

    return {
      medicamento: medication.insumo?.trim() || medication.clave,
      clave: medication.clave,
      cantidad_entregada: recipe.cantidad,
      stock_restante: stockRestante,
    };
  });
}

export function parseAzureSqlConnectionString(
  connectionString: string,
): sql.config {
  return parseConnectionString(connectionString);
}
