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
  const pending = pool.connect();
  const tracked = pending.catch((error: unknown) => {
    if (poolPromise === tracked) poolPromise = undefined;
    throw error;
  });
  poolPromise = tracked;
  return tracked;
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
  const request = (await getPool()).request();
  for (const [name, value] of Object.entries(parameters)) {
    if (typeof value === "number") request.input(name, sql.Int, value);
    else request.input(name, stringType, value);
  }
  const result = await request.query<T>(query);
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
  const transaction = new sql.Transaction(await getPool());
  await transaction.begin();
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
): Promise<Employee | null> {
  const key = requiredText(objectId, "El Object ID de Entra ID");
  const result = await rows<Employee>(
    `
      SELECT id_empleado, entra_object_id, nombre, correo, rol, estatus
      FROM dbo.empleados
      WHERE entra_object_id = CONVERT(uniqueidentifier, @objectId)
        AND LOWER(LTRIM(RTRIM(estatus))) = 'activo';
    `,
    { objectId: key },
  );
  return result[0] ?? null;
}

export async function buscarAdmision(
  identifier: string,
): Promise<PatientRecord> {
  const key = requiredText(identifier, "El NSS o nombre");
  const result = await rows<PatientRecord>(
    `
      SELECT nss, nombre, telefono, contacto_emergencia, telefono_emergencia
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
    admission.input("telefonoEmergencia", stringType, input.telefono_emergencia);
    await admission.query(`
      INSERT INTO dbo.admision
        (nss, nombre, telefono, contacto_emergencia, telefono_emergencia)
      VALUES
        (@nss, @nombre, @telefono, @contactoEmergencia, @telefonoEmergencia);
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
    if (!recipe.medicamento.trim() || !recipe.dosis_y_tiempo.trim()) {
      throw new TypeError("Cada receta requiere medicamento y dosis/tiempo.");
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
      const recipeResult = await request.query<{ id_receta: number }>(`
        INSERT INTO dbo.farmacia (id_atencion, medicamento, dosis_y_tiempo)
        OUTPUT INSERTED.id_receta
        VALUES (@visitId, @medicamento, @dosisTiempo);
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
  idAtencion: number,
): Promise<PatientRecord[]> {
  if (!Number.isInteger(idAtencion) || idAtencion <= 0) {
    throw new TypeError("El ID de atención debe ser positivo.");
  }
  return rows<PatientRecord>(
    `
      SELECT id_receta, id_atencion, medicamento, dosis_y_tiempo,
             estatus_farmacia
      FROM dbo.farmacia
      WHERE id_atencion = @idAtencion AND estatus_farmacia = 'Pendiente'
      ORDER BY id_receta;
    `,
    { idAtencion },
  );
}

export async function marcarRecetaEntregada(idReceta: number): Promise<void> {
  if (!Number.isInteger(idReceta) || idReceta <= 0) {
    throw new TypeError("El ID de receta debe ser positivo.");
  }
  await runTransaction(async (transaction) => {
    const request = transaction.request();
    request.input("idReceta", sql.Int, idReceta);
    const result = await request.query<{ id_receta: number }>(`
      UPDATE dbo.farmacia
      SET estatus_farmacia = 'Entregado'
      OUTPUT INSERTED.id_receta
      WHERE id_receta = @idReceta AND estatus_farmacia = 'Pendiente';
    `);
    if (!result.recordset[0]) {
      throw new LookupError(
        "La receta no existe o ya no está en estado Pendiente.",
      );
    }
  });
}

export function parseAzureSqlConnectionString(
  connectionString: string,
): sql.config {
  return parseConnectionString(connectionString);
}
