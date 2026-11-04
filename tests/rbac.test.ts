import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeTool, AuthorizationError } from "../src/rbac.js";

test("allows only roles assigned to each tool", () => {
  assert.doesNotThrow(() => authorizeTool("Farmacia", "gestionar_farmacia"));
  assert.doesNotThrow(() => authorizeTool("Finanzas", "validar_poliza"));
  assert.throws(
    () => authorizeTool("Farmacia", "evaluar_consulta_medica"),
    AuthorizationError,
  );
  assert.throws(
    () => authorizeTool("Admin", "herramienta_desconocida"),
    AuthorizationError,
  );
});
