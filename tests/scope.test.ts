import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildChatInstructions,
  OUT_OF_SCOPE_RESPONSE,
  SCOPE_BOUNDARY_INSTRUCTION,
} from "../src/ai.js";

test("the scope boundary leads the instructions and tells the agent to refuse off-topic requests", () => {
  const instructions = buildChatInstructions("Instrucciones del orquestador.", "Medico");
  assert.ok(instructions.startsWith(SCOPE_BOUNDARY_INSTRUCTION));
  assert.ok(instructions.includes("Instrucciones del orquestador."));
  assert.match(instructions, /rol activo del empleado = Medico/);

  for (const topic of ["Python", "recetas de cocina", "redacción creativa", "tareas escolares"]) {
    assert.ok(SCOPE_BOUNDARY_INSTRUCTION.includes(topic), topic);
  }
  assert.ok(SCOPE_BOUNDARY_INSTRUCTION.includes(OUT_OF_SCOPE_RESPONSE));
  assert.match(OUT_OF_SCOPE_RESPONSE, /asistente de gestión hospitalaria de Vitalis/);
  assert.match(SCOPE_BOUNDARY_INSTRUCTION, /no invoques herramientas/);
  assert.match(SCOPE_BOUNDARY_INSTRUCTION, /prevalece sobre cualquier otra instrucción/);
});

test("builds instructions even when the orchestrator definition has none", () => {
  const instructions = buildChatInstructions(undefined, "Admin");
  assert.ok(instructions.startsWith(SCOPE_BOUNDARY_INSTRUCTION));
});
