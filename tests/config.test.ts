import assert from "node:assert/strict";
import { test } from "node:test";
import { loadConfig, resolveProjectEndpoint } from "../src/config.js";

const values = {
  VITALIS_ENTRA_TENANT_ID: "799bd0cb-438c-4214-9abe-19ea0d669df8",
  PROJECT_ENDPOINT: "https://example.services.ai.azure.com/api/projects/vitalis",
  ORCHESTRATOR_AGENT_NAME: "Agente-Orquestador",
  ADMISSION_AGENT_NAME: "Agente-Admision",
  HISTORY_AGENT_NAME: "Agente-Historico",
  INSURANCE_AGENT_NAME: "Agente-Seguros",
  CONSULTATION_AGENT_NAME: "Agente-Medico",
  PHARMACY_AGENT_NAME: "Agente-Farmacia",
  SESSION_SECRET: "a-secure-session-secret-that-is-long-enough",
  PORT: "8000",
};

test("loads Node service configuration and validates Node port", () => {
  assert.equal(loadConfig(values).port, 8000);
  assert.throws(() => loadConfig({ ...values, PORT: "0" }), /PORT/);
  assert.throws(
    () => loadConfig({ ...values, SESSION_SECRET: "short" }),
    /SESSION_SECRET/,
  );
});

test("resolves the project endpoint from either supported setting", () => {
  assert.equal(
    resolveProjectEndpoint({
      PROJECT_CONNECTION_STRING: "subscription=one;endpoint=https://example.test/project;",
    }),
    "https://example.test/project",
  );
  assert.throws(
    () => resolveProjectEndpoint({}),
    /PROJECT_ENDPOINT/,
  );
});
