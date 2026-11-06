import assert from "node:assert/strict";
import test from "node:test";

import {
  AiUnavailableError,
  executePharmacyAction,
  formatPharmacyConfirmationResult,
  isTransientAiError,
  runSpecialistResponse,
  withDeadline,
} from "../src/ai.js";
import { resolveAdminDomain } from "../src/config.js";
import { isConnectionError, LookupError, type Employee } from "../src/db.js";
import { isAdminDomainEmail, resolveEmployee } from "../src/employee.js";

const OID = "11111111-1111-1111-1111-111111111111";

function employee(overrides: Partial<Employee> = {}): Employee {
  return {
    id_empleado: "E-1",
    entra_object_id: OID,
    nombre: "Ana",
    correo: "ana@vitalis.com",
    rol: "Medico",
    estatus: "Activo",
    ...overrides,
  };
}

test("a corporate-domain email without an SQL row gets the Admin role", async () => {
  const result = await resolveEmployee(
    { oid: OID, name: "Max", email: "max@labmx.ai" },
    async () => null,
    "labmx.ai",
  );
  assert.equal(result?.rol, "Admin");
  assert.equal(result?.correo, "max@labmx.ai");
});

test("a registered corporate user keeps the assigned SQL role", async () => {
  const result = await resolveEmployee(
    { oid: OID, name: "Max", email: "max@labmx.ai" },
    async () => employee({ rol: "Farmacia" }),
    "labmx.ai",
  );
  assert.equal(result?.rol, "Farmacia");
});

test("outside or inactive accounts are denied cleanly without throwing", async () => {
  assert.equal(
    await resolveEmployee(
      { oid: OID, name: "X", email: "x@otro.com" },
      async () => null,
      "labmx.ai",
    ),
    null,
  );
  assert.equal(
    await resolveEmployee({ oid: OID, name: "X" }, async () => null, "labmx.ai"),
    null,
  );
  assert.equal(
    await resolveEmployee(
      { oid: OID, name: "X", email: "x@otro.com" },
      async () => employee({ estatus: "Inactivo" }),
      "labmx.ai",
    ),
    null,
  );
  // Un empleado corporativo dado de baja no recupera acceso por su dominio.
  assert.equal(
    await resolveEmployee(
      { oid: OID, name: "X", email: "x@labmx.ai" },
      async () => employee({ estatus: "Inactivo" }),
      "labmx.ai",
    ),
    null,
  );
});

test("the admin domain match is exact and configurable", () => {
  assert.equal(isAdminDomainEmail("a@labmx.ai", "labmx.ai"), true);
  assert.equal(isAdminDomainEmail("A@LabMX.AI", "labmx.ai"), true);
  assert.equal(isAdminDomainEmail("a@evil-labmx.ai", "labmx.ai"), false);
  assert.equal(isAdminDomainEmail("a@labmx.ai.evil.com", "labmx.ai"), false);
  assert.equal(isAdminDomainEmail("a@sub.labmx.ai", "labmx.ai"), false);
  assert.equal(isAdminDomainEmail(undefined, "labmx.ai"), false);
  assert.equal(resolveAdminDomain({}), "labmx.ai");
  assert.equal(resolveAdminDomain({ ALLOWED_ADMIN_DOMAIN: "@Hospital.mx" }), "hospital.mx");
  assert.throws(() => resolveAdminDomain({ ALLOWED_ADMIN_DOMAIN: "no valido" }));
});

test("a repeated delivery confirmation reports the recipe as already processed", async () => {
  let deliveries = 0;
  const operations = {
    async listPendingRecipes() {
      return [];
    },
    async findRecipeById() {
      return { id_receta: 3, nss: "P-1", estatus_farmacia: "Entregado" };
    },
    async markRecipeDelivered() {
      deliveries += 1;
      return { medicamento: "X", clave: "K", cantidad_entregada: 1, stock_restante: 1 };
    },
  };
  const args = {
    accion: "entregar",
    nss: "P-1",
    id_receta: 3,
    clave_medicamento: null,
    confirmar_entrega: true,
  };
  const output = await executePharmacyAction(args, "", operations, true);
  assert.equal(deliveries, 0);
  assert.equal(JSON.parse(output).ya_procesada, true);
  assert.match(formatPharmacyConfirmationResult(output), /ya fue entregada/);
});

test("a race that loses the update is also reported as already processed", async () => {
  const operations = {
    async listPendingRecipes() {
      return [];
    },
    async findRecipeById() {
      return { id_receta: 3, nss: "P-1", estatus_farmacia: "Entregado" };
    },
    async markRecipeDelivered() {
      throw new LookupError("ya no está pendiente");
    },
  };
  const output = await executePharmacyAction(
    { accion: "entregar", nss: "P-1", id_receta: 3, clave_medicamento: null, confirmar_entrega: true },
    "",
    operations,
    true,
  );
  assert.equal(JSON.parse(output).ya_procesada, true);
});

test("transient Foundry failures become a friendly retryable error", async () => {
  const timeout = Object.assign(new Error("timeout"), {
    name: "APIConnectionTimeoutError",
  });
  assert.equal(isTransientAiError(timeout), true);
  assert.equal(isTransientAiError(Object.assign(new Error("x"), { status: 503 })), true);
  assert.equal(isTransientAiError(Object.assign(new Error("x"), { status: 400 })), false);
  await assert.rejects(
    runSpecialistResponse(async () => {
      throw timeout;
    }),
    AiUnavailableError,
  );
});

test("withDeadline rejects slow operations instead of waiting forever", async () => {
  await assert.rejects(
    withDeadline(new Promise(() => undefined), 20),
    AiUnavailableError,
  );
  assert.equal(await withDeadline(Promise.resolve("ok"), 1000), "ok");
});

test("SQL connection-level errors are recognised for reconnection", () => {
  assert.equal(isConnectionError(Object.assign(new Error("lost"), { code: "ECONNCLOSED" })), true);
  assert.equal(isConnectionError(Object.assign(new Error("syntax"), { code: "EREQUEST" })), false);
  assert.equal(isConnectionError("boom"), false);
});
