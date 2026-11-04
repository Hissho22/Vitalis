import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMedicalResult } from "../src/ai.js";

test("validates the medical response before it can be written to SQL", () => {
  assert.deepEqual(
    parseMedicalResult(
      JSON.stringify({
        notas_medicas: "Nota registrada",
        diagnostico: "Evaluación pendiente",
        recetas: [
          { medicamento: "Medicamento", dosis_y_tiempo: "Según indicación" },
        ],
      }),
    ),
    {
      notas_medicas: "Nota registrada",
      diagnostico: "Evaluación pendiente",
      recetas: [
        { medicamento: "Medicamento", dosis_y_tiempo: "Según indicación" },
      ],
    },
  );
});

test("rejects malformed medical JSON, missing fields, and incomplete recipes", () => {
  assert.throws(() => parseMedicalResult("not-json"), /JSON requerido/);
  assert.throws(() => parseMedicalResult("{}"), /campos inválidos/);
  assert.throws(
    () =>
      parseMedicalResult(
        JSON.stringify({
          notas_medicas: "Nota",
          diagnostico: "Diagnóstico",
          recetas: [{ medicamento: "Medicamento" }],
        }),
      ),
    /receta incompleta/,
  );
});
