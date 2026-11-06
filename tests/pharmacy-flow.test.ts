import assert from "node:assert/strict";
import test from "node:test";

import { executePharmacyAction, extractConfirmationRequest } from "../src/ai.js";

function buildOperations(recipe: Record<string, unknown> | null) {
  const calls = { byNss: 0, global: 0, delivered: [] as string[] };
  return {
    calls,
    operations: {
      async listPendingRecipes() {
        calls.byNss += 1;
        return [];
      },
      async listAllPendingRecipes() {
        calls.global += 1;
        return [
          {
            id_receta: 3,
            nss: "P-1",
            medicamento: "PARACETAMOL",
            cantidad: 2,
            estatus_farmacia: "Pendiente",
          },
        ];
      },
      async findRecipeById() {
        return recipe;
      },
      async markRecipeDelivered(_id: number, nss: string) {
        calls.delivered.push(nss);
        return {
          medicamento: "PARACETAMOL",
          clave: "MED-1",
          cantidad_entregada: 2,
          stock_restante: 5,
        };
      },
    },
  };
}

test("pending recipes can be listed without NSS", async () => {
  const { operations, calls } = buildOperations(null);
  const output = await executePharmacyAction(
    { accion: "pendientes", nss: null },
    "¿Qué recetas están pendientes por surtir?",
    operations,
  );
  assert.equal(calls.global, 1);
  assert.equal(calls.byNss, 0);
  const list = JSON.parse(output);
  assert.equal(list[0].id_receta, 3);
  assert.equal(list[0].nss, "P-1");
});

test("a recipe can be queried by id_receta only", async () => {
  const { operations } = buildOperations({
    id_receta: 20,
    nss: "P-9",
    medicamento: "IBUPROFENO",
    cantidad: 1,
    estatus_farmacia: "Pendiente",
  });
  const found = JSON.parse(
    await executePharmacyAction(
      { accion: "consultar", nss: null, id_receta: 20 },
      "receta 20",
      operations,
    ),
  );
  assert.equal(found.encontrada, true);
  assert.equal(found.receta.nss, "P-9");

  const missing = buildOperations(null);
  const notFound = JSON.parse(
    await executePharmacyAction(
      { accion: "consultar", nss: null, id_receta: 99 },
      "receta 99",
      missing.operations,
    ),
  );
  assert.equal(notFound.encontrada, false);
});

test("delivery by id_receta resolves the patient and requests button confirmation", async () => {
  const { operations, calls } = buildOperations({
    id_receta: 3,
    nss: "P-1",
    estatus_farmacia: "Pendiente",
  });
  const args = {
    accion: "entregar",
    nss: null,
    id_receta: 3,
    clave_medicamento: null,
    confirmar_entrega: false,
  };
  const pending = await executePharmacyAction(args, "entrega la receta 3", operations);
  const request = extractConfirmationRequest(pending);
  assert.ok(request);
  assert.equal(request.confirmLabel, "Confirmar entrega");
  assert.deepEqual(request.actionPayload, {
    accion: "entregar_receta",
    nss: "P-1",
    id_receta: 3,
    clave_medicamento: null,
  });
  assert.equal(calls.delivered.length, 0);

  await executePharmacyAction(args, "", operations, true);
  assert.deepEqual(calls.delivered, ["P-1"]);
});

test("delivery by id_receta rejects missing or already delivered recipes", async () => {
  const args = {
    accion: "entregar",
    nss: null,
    id_receta: 4,
    clave_medicamento: null,
    confirmar_entrega: false,
  };
  const delivered = buildOperations({
    id_receta: 4,
    nss: "P-1",
    estatus_farmacia: "Entregado",
  });
  const out = JSON.parse(await executePharmacyAction(args, "", delivered.operations));
  assert.equal(out.entrega_registrada, false);
  assert.equal(extractConfirmationRequest(JSON.stringify(out)), undefined);

  const missing = buildOperations(null);
  const out2 = JSON.parse(await executePharmacyAction(args, "", missing.operations));
  assert.equal(out2.entrega_registrada, false);
});
