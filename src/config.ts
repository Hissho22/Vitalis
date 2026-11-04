import { randomBytes } from "node:crypto";

export interface AppConfig {
  tenantId: string;
  projectEndpoint: string;
  agents: {
    orchestrator: string;
    admission: string;
    history: string;
    insurance: string;
    medical: string;
    pharmacy: string;
  };
  sessionSecret: string;
  port: number;
}

function requiredSetting(env: NodeJS.ProcessEnv, ...names: string[]): string {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  throw new Error(`Falta configurar una de estas variables: ${names.join(", ")}`);
}

export function resolveProjectEndpoint(env: NodeJS.ProcessEnv): string {
  const endpoint = env.PROJECT_ENDPOINT?.trim();
  if (endpoint) return endpoint;

  const connectionString = env.PROJECT_CONNECTION_STRING ?? "";
  const values = new Map(
    connectionString
      .split(";")
      .filter((entry) => entry.includes("="))
      .map((entry) => {
        const separator = entry.indexOf("=");
        return [
          entry.slice(0, separator).trim().toLowerCase(),
          entry.slice(separator + 1).trim(),
        ];
      }),
  );
  const resolved = values.get("endpoint") ?? values.get("projectendpoint");
  if (resolved) return resolved;

  throw new Error(
    "Configura PROJECT_ENDPOINT o PROJECT_CONNECTION_STRING con endpoint=<URL del proyecto>.",
  );
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const tenantId = requiredSetting(env, "VITALIS_ENTRA_TENANT_ID").toLowerCase();
  if (!/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(tenantId)) {
    throw new Error("VITALIS_ENTRA_TENANT_ID no es un GUID válido.");
  }

  const sessionSecret = requiredSetting(env, "SESSION_SECRET");
  if (sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET debe tener al menos 32 caracteres.");
  }

  const port = Number(env.PORT ?? "8000");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT debe ser un puerto TCP válido.");
  }

  return {
    tenantId,
    projectEndpoint: resolveProjectEndpoint(env),
    agents: {
      orchestrator: requiredSetting(env, "ORCHESTRATOR_AGENT_NAME"),
      admission: requiredSetting(env, "ADMISSION_AGENT_NAME"),
      history: requiredSetting(env, "HISTORY_AGENT_NAME"),
      insurance: requiredSetting(env, "INSURANCE_AGENT_NAME"),
      medical: requiredSetting(env, "CONSULTATION_AGENT_NAME"),
      pharmacy: requiredSetting(env, "PHARMACY_AGENT_NAME"),
    },
    sessionSecret,
    port,
  };
}

export function createLocalSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}
