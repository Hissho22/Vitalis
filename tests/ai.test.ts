import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizationDenialResponse,
  executeMedicationCatalogSearch,
  executePharmacyAction,
  isContentPolicyBlock,
  parseMedicalResult,
  runSpecialistResponse,
} from "../src/ai.js";
import { LookupError, PharmacyInventoryError } from "../src/db.js";
import { AuthorizationError, authorizeTool } from "../src/rbac.js";

test("recognizes Azure content-policy blocks without masking other errors", () => {
  assert.equal(
    isContentPolicyBlock({
      status: 400,
      error: { code: "ResponsibleAIPolicyViolation" },
    }),
    true,
  );
  assert.equal(isContentPolicyBlock({ code: "content_filter" }), true);
  assert.equal(
    isContentPolicyBlock({ incomplete_details: { reason: "content_filter" } }),
    true,
  );
  assert.equal(
    isContentPolicyBlock({ status: 400, code: "invalid_request_error" }),
    false,
  );
  assert.equal(isContentPolicyBlock(new Error("Service unavailable")), false);
});

test("replaces RBAC details with a professional message without internal names", () => {
  const message = authorizationDenialResponse(
    new AuthorizationError(
      "El rol Farmacia no está autorizado para obtener_expediente_master.",
    ),
  );

  assert.equal(
    message,
    "Su rol actual no cuenta con autorización para acceder a esta información o realizar esta acción clínica. Por favor, remítase a las tareas correspondientes a su área asignada.",
  );
  assert.doesNotMatch(
    message!,
    /obtener_expediente_master|validar_poliza|Farmacia|AuthorizationError/i,
  );
  assert.equal(
    authorizationDenialResponse(new Error("Error de base de datos")),
    undefined,
  );
});

test("returns the institutional denial when a non-authorized role requests the catalog", () => {
  let denial: unknown;
  try {
    authorizeTool("Seguros", "consultar_catalogo_medicamentos");
  } catch (error) {
    denial = error;
  }

  assert.ok(denial instanceof AuthorizationError);
  const message = authorizationDenialResponse(denial);
  assert.match(message ?? "", /Su rol actual no cuenta con autorización/);
  assert.doesNotMatch(
    message ?? "",
    /consultar_catalogo_medicamentos|obtener_expediente_master|Seguros/i,
  );
});

test("turns specialist content-policy blocks into the controlled chat error", async () => {
  await assert.rejects(
    runSpecialistResponse(async () => {
      throw { status: 400, error: { code: "ResponsibleAIPolicyViolation" } };
    }),
    /No puedo procesar esa solicitud por políticas de seguridad/,
  );
  await assert.rejects(
    runSpecialistResponse(async () => ({
      incomplete_details: { reason: "content_filter" },
    })),
    /No puedo procesar esa solicitud por políticas de seguridad/,
  );
  await assert.rejects(
    runSpecialistResponse(async () => {
      throw new Error("Service unavailable");
    }),
    /Service unavailable/,
  );
});

test("returns pending pharmacy recipes without requiring delivery-only arguments", async () => {
  let queriedNss: string | undefined;
  const result = await executePharmacyAction(
    { accion: "pendientes", nss: "DEMO-0001" },
    "",
    {
      async listPendingRecipes(nss) {
        queriedNss = nss;
        return [];
      },
      async markRecipeDelivered() {
        assert.fail("No debe registrar una entrega al consultar pendientes.");
      },
    },
  );

  assert.equal(queriedNss, "DEMO-0001");
  assert.deepEqual(JSON.parse(result), []);
});

test("returns a controlled result when a pharmacy recipe cannot be delivered", async () => {
  let markedRecipe: number | undefined;
  const result = await executePharmacyAction(
    {
      accion: "entregar",
      nss: "DEMO-0001",
      id_receta: 42,
      confirmar_entrega: true,
    },
    "Confirmo que la entrega física de la receta 42 ya fue realizada.",
    {
      async listPendingRecipes() {
        return [];
      },
      async markRecipeDelivered(idReceta) {
        markedRecipe = idReceta;
        throw new LookupError("La receta no existe o ya fue procesada.");
      },
    },
  );
  const response = JSON.parse(result) as {
    entrega_registrada: boolean;
    mensaje: string;
  };

  assert.equal(markedRecipe, 42);
  assert.equal(response.entrega_registrada, false);
  assert.match(response.mensaje, /No se registró la entrega/);
});

test("deducts the dispensed quantity from stock when a pharmacy delivery succeeds", async () => {
  let stock = 8;
  let delivered = false;
  const result = await executePharmacyAction(
    {
      accion: "entregar",
      nss: "DEMO-0001",
      id_receta: 42,
      confirmar_entrega: true,
    },
    "Confirmo que la entrega física de la receta 42 ya fue realizada.",
    {
      async listPendingRecipes() {
        return [];
      },
      async markRecipeDelivered(idReceta, nss) {
        assert.equal(idReceta, 42);
        assert.equal(nss, "DEMO-0001");
        const quantity = 3;
        if (stock < quantity) {
          throw new PharmacyInventoryError(
            "insufficient_stock",
            "No hay existencias suficientes.",
          );
        }
        stock -= quantity;
        delivered = true;
        return {
          medicamento: "Paracetamol 500 mg",
          cantidad_entregada: quantity,
          stock_restante: stock,
        };
      },
    },
  );
  const response = JSON.parse(result) as {
    estatus_farmacia: string;
    cantidad_entregada: number;
    stock_restante: number;
  };

  assert.equal(delivered, true);
  assert.equal(stock, 5);
  assert.equal(response.estatus_farmacia, "Entregado");
  assert.equal(response.cantidad_entregada, 3);
  assert.equal(response.stock_restante, 5);
});

test("does not register or deduct stock when inventory is insufficient", async () => {
  let stock = 2;
  let delivered = false;
  const result = await executePharmacyAction(
    {
      accion: "entregar",
      nss: "DEMO-0001",
      id_receta: 42,
      confirmar_entrega: true,
    },
    "Confirmo que la entrega física de la receta 42 ya fue realizada.",
    {
      async listPendingRecipes() {
        return [];
      },
      async markRecipeDelivered() {
        const quantityRequired = 3;
        if (stock < quantityRequired) {
          throw new PharmacyInventoryError(
            "insufficient_stock",
            "No hay existencias suficientes: hay 2 unidades disponibles y la receta requiere 3. No se registró la entrega.",
          );
        }
        stock -= quantityRequired;
        delivered = true;
        return {
          medicamento: "Paracetamol 500 mg",
          cantidad_entregada: quantityRequired,
          stock_restante: stock,
        };
      },
    },
  );
  const response = JSON.parse(result) as {
    entrega_registrada: boolean;
    mensaje: string;
  };

  assert.equal(delivered, false);
  assert.equal(stock, 2);
  assert.equal(response.entrega_registrada, false);
  assert.match(response.mensaje, /2 unidades disponibles/);
  assert.match(response.mensaje, /No se registró la entrega/);
});

test("does not hide unexpected pharmacy database errors", async () => {
  const databaseError = new Error("SQL connection failed");
  await assert.rejects(
    executePharmacyAction(
      {
        accion: "entregar",
        nss: "DEMO-0001",
        id_receta: 42,
        confirmar_entrega: true,
      },
      "Confirmo que la entrega física de la receta 42 ya fue realizada.",
      {
        async listPendingRecipes() {
          return [];
        },
        async markRecipeDelivered() {
          throw databaseError;
        },
      },
    ),
    (error: unknown) => error === databaseError,
  );
});

test("searches the medication catalog with a trimmed term and optional exact key", async () => {
  let received: { term: string; key: string | null } | undefined;
  const result = await executeMedicationCatalogSearch(
    { termino: "  analgesico  ", clave: "MED-123" },
    async (term, key) => {
      received = { term, key };
      return [
        {
          clave: "MED-123",
          insumo: "Insumo de prueba",
          descripcion: "Descripción de prueba",
          indicaciones: "Indicación registrada",
          stock: 10,
        },
      ];
    },
  );

  assert.deepEqual(received, { term: "analgesico", key: "MED-123" });
  assert.deepEqual(JSON.parse(result), [
    {
      clave: "MED-123",
      insumo: "Insumo de prueba",
      descripcion: "Descripción de prueba",
      indicaciones: "Indicación registrada",
      stock: 10,
    },
  ]);
});

test("allows catalog lookup by key alone and rejects empty or oversized searches", async () => {
  let received: { term: string; key: string | null } | undefined;
  await executeMedicationCatalogSearch(
    { termino: "", clave: "MED-123" },
    async (term, key) => {
      received = { term, key };
      return [];
    },
  );
  assert.deepEqual(received, { term: "", key: "MED-123" });

  await assert.rejects(
    executeMedicationCatalogSearch({ termino: "  ", clave: null }),
    /Proporciona un término de búsqueda o una clave/,
  );
  await assert.rejects(
    executeMedicationCatalogSearch({ termino: "x".repeat(501), clave: null }),
    /excede 500 caracteres/,
  );
});

test("validates the medical response before it can be written to SQL", () => {
  assert.deepEqual(
    parseMedicalResult(
      JSON.stringify({
        notas_medicas: "Nota registrada",
        diagnostico: "Evaluación pendiente",
        recetas: [
          {
            medicamento: "MED-123",
            dosis_y_tiempo: "Una tableta cada 8 horas por 3 días",
            cantidad: 9,
          },
        ],
      }),
    ),
    {
      notas_medicas: "Nota registrada",
      diagnostico: "Evaluación pendiente",
      recetas: [
        {
          medicamento: "MED-123",
          dosis_y_tiempo: "Una tableta cada 8 horas por 3 días",
          cantidad: 9,
        },
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
          recetas: [
            {
              medicamento: "MED-123",
              dosis_y_tiempo: "Una tableta",
            },
          ],
        }),
      ),
    /receta incompleta/,
  );
  for (const cantidad of [0, -1, 1.5, "2", null]) {
    assert.throws(
      () =>
        parseMedicalResult(
          JSON.stringify({
            notas_medicas: "Nota",
            diagnostico: "Diagnóstico",
            recetas: [
              {
                medicamento: "MED-123",
                dosis_y_tiempo: "Una tableta",
                cantidad,
              },
            ],
          }),
        ),
      /receta incompleta/,
    );
  }
});
