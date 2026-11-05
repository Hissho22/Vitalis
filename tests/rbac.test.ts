import assert from "node:assert/strict";
import { test } from "node:test";
import { authorizeTool, AuthorizationError } from "../src/rbac.js";

const accessByRole: Record<string, string[]> = {
  Admin: [
    "buscar_paciente_admision",
    "registrar_admision",
    "consultar_historico",
    "obtener_expediente_master",
    "validar_poliza",
    "evaluar_consulta_medica",
    "gestionar_farmacia",
    "consultar_catalogo_medicamentos",
  ],
  Medico: [
    "consultar_historico",
    "obtener_expediente_master",
    "evaluar_consulta_medica",
    "consultar_catalogo_medicamentos",
  ],
  Admision: [
    "buscar_paciente_admision",
    "registrar_admision",
    "consultar_historico",
    "obtener_expediente_master",
  ],
  Farmacia: ["gestionar_farmacia", "consultar_catalogo_medicamentos"],
  Seguros: ["validar_poliza"],
  Finanzas: ["validar_poliza"],
};

const allTools = [
  "buscar_paciente_admision",
  "registrar_admision",
  "consultar_historico",
  "obtener_expediente_master",
  "validar_poliza",
  "evaluar_consulta_medica",
  "gestionar_farmacia",
  "consultar_catalogo_medicamentos",
];

test("enforces the complete role-to-tool permission matrix", () => {
  for (const [role, allowedTools] of Object.entries(accessByRole)) {
    for (const tool of allTools) {
      if (allowedTools.includes(tool)) {
        assert.doesNotThrow(() => authorizeTool(role, tool), `${role}: ${tool}`);
      } else {
        assert.throws(
          () => authorizeTool(role, tool),
          AuthorizationError,
          `${role} must not use ${tool}`,
        );
      }
    }
  }
});

test("rejects unsupported aliases, nursing, case variants, and unknown tools", () => {
  for (const role of ["recepcion", "enfermeria", "admin", "medico", "farmacia"]) {
    assert.throws(
      () => authorizeTool(role, "gestionar_farmacia"),
      AuthorizationError,
    );
  }
  assert.throws(
    () => authorizeTool("Farmacia", "herramienta_desconocida"),
    AuthorizationError,
  );
});

test("allows catalog lookup for Admin, Medico, and Farmacia only", () => {
  for (const role of ["Admin", "Medico", "Farmacia"]) {
    assert.doesNotThrow(() =>
      authorizeTool(role, "consultar_catalogo_medicamentos"),
    );
  }
  for (const role of ["Admision", "Seguros", "Finanzas"]) {
    assert.throws(
      () => authorizeTool(role, "consultar_catalogo_medicamentos"),
      AuthorizationError,
    );
  }
});
