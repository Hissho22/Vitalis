import assert from "node:assert/strict";
import { test } from "node:test";
import {
  executeHistoricalRecord,
  executePharmacyAction,
  executeStockQuery,
  extractConfirmationRequest,
  formatPharmacyConfirmationResult,
} from "../src/ai.js";
import { LookupError, parseStockQuery } from "../src/db.js";

test("validates stock criteria and limits", () => {
  assert.deepEqual(parseStockQuery("menor", 5), { criterio: "menor", limite: 5 });
  assert.throws(() => parseStockQuery("otro", 5), TypeError);
  assert.throws(() => parseStockQuery("mayor", 0), TypeError);
  assert.throws(() => parseStockQuery("mayor", 51), TypeError);
  assert.throws(() => parseStockQuery("mayor", 2.5), TypeError);
});

test("executes the stock query with validated arguments", async () => {
  const calls: unknown[] = [];
  const output = await executeStockQuery(
    { criterio: "menor", limite: 3 },
    async (criterio, limite) => {
      calls.push([criterio, limite]);
      return [{ clave: "A1", insumo: "X", descripcion: "Y", stock: 0 }];
    },
  );
  assert.deepEqual(calls, [["menor", 3]]);
  assert.equal(JSON.parse(output)[0].clave, "A1");
  await assert.rejects(
    executeStockQuery({ criterio: "menor", limite: "3" }, async () => []),
    TypeError,
  );
});

const historicalArgs = {
  nss: "NSS 123",
  fecha_nacimiento: "1990-02-03",
  sexo: "F",
  tipo_sangre: "O+",
  alergias: null,
  enfermedades_cronicas: null,
  cirugias_previas: null,
  antecedentes_familiares: null,
  habitos_toxicologias: null,
  discapacidades_dispositivos: null,
};

test("saves historical records and reports unknown patients without throwing", async () => {
  const saved: unknown[] = [];
  const ok = await executeHistoricalRecord(historicalArgs, async (input) => {
    saved.push(input);
    return { nss: input.nss, estatus: "Registrado" };
  });
  assert.equal((saved[0] as { nss: string }).nss, "123");
  assert.equal(JSON.parse(ok).estatus, "Registrado");

  const missing = await executeHistoricalRecord(historicalArgs, async () => {
    throw new LookupError("No existe un paciente con ese NSS en admisión.");
  });
  assert.equal(JSON.parse(missing).registrado, false);

  await assert.rejects(
    executeHistoricalRecord({ ...historicalArgs, sexo: 1 }, async () => {
      throw new Error("no debe ejecutarse");
    }),
    TypeError,
  );
});

test("pharmacy delivery asks for button confirmation and completes once confirmed", async () => {
  let deliveries = 0;
  const operations = {
    async listPendingRecipes() {
      return [];
    },
    async markRecipeDelivered() {
      deliveries += 1;
      return {
        medicamento: "PARACETAMOL",
        clave: "MED-9",
        cantidad_entregada: 2,
        stock_restante: 8,
      };
    },
  };
  const args = {
    accion: "entregar",
    nss: "DEMO-1",
    id_receta: 7,
    clave_medicamento: null,
    confirmar_entrega: true,
  };

  const pending = await executePharmacyAction(args, "entrega la receta 7", operations);
  const request = extractConfirmationRequest(pending);
  assert.ok(request);
  assert.equal(request.confirmLabel, "Confirmar entrega");
  assert.equal(request.cancelLabel, "Cancelar");
  assert.deepEqual(request.actionPayload, {
    accion: "entregar_receta",
    nss: "DEMO-1",
    id_receta: 7,
    clave_medicamento: null,
  });
  assert.equal(deliveries, 0);

  const done = await executePharmacyAction(args, "", operations, true);
  assert.equal(deliveries, 1);
  assert.match(formatPharmacyConfirmationResult(done), /Entrega registrada: receta 7/);
});

test("extractConfirmationRequest ignores outputs without a valid request", () => {
  assert.equal(extractConfirmationRequest("texto"), undefined);
  assert.equal(extractConfirmationRequest('{"confirmationRequest":{"title":1}}'), undefined);
});
