import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeAppServicePrincipal } from "../src/auth.js";

const objectId = "d85b1407-351d-4694-9392-03acc5870eb1";
const tenantId = "799bd0cb-438c-4214-9abe-19ea0d669df8";

test("decodes App Service principal claims", () => {
  const principal = {
    auth_typ: "aad",
    claims: [
      {
        typ: "http://schemas.microsoft.com/identity/claims/objectidentifier",
        val: objectId,
      },
      {
        typ: "http://schemas.microsoft.com/identity/claims/tenantid",
        val: tenantId,
      },
      { typ: "name", val: "Usuario de prueba" },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(principal)).toString("base64");

  assert.deepEqual(decodeAppServicePrincipal(encoded), {
    oid: objectId,
    tid: tenantId,
    name: "Usuario de prueba",
  });
});

test("supports short OID/TID claims and display-name fallback", () => {
  const principal = {
    claims: [
      { typ: "oid", val: objectId },
      { typ: "tid", val: tenantId },
    ],
  };
  const encoded = Buffer.from(JSON.stringify(principal)).toString("base64");

  assert.equal(
    decodeAppServicePrincipal(encoded, "usuario@organizacion.test").name,
    "usuario@organizacion.test",
  );
});

test("rejects malformed, incomplete, and non-GUID principals", () => {
  assert.throws(() => decodeAppServicePrincipal("not-base64"));
  const missingTenant = Buffer.from(
    JSON.stringify({ claims: [{ typ: "oid", val: objectId }] }),
  ).toString("base64");
  assert.throws(() => decodeAppServicePrincipal(missingTenant), /Tenant ID/);
  const invalidObjectId = Buffer.from(
    JSON.stringify({
      claims: [
        { typ: "oid", val: "user" },
        { typ: "tid", val: tenantId },
      ],
    }),
  ).toString("base64");
  assert.throws(() => decodeAppServicePrincipal(invalidObjectId), /válidos/);
});
