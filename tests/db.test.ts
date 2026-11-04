import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAzureSqlConnectionString } from "../src/db.js";

test("parses Azure SQL connection strings and ODBC options", () => {
  const config = parseAzureSqlConnectionString(
    "Driver={ODBC Driver 18 for SQL Server};Server=tcp:sql.example.test,1433;" +
      "Database=VitalisDB;Uid=vitalis;Pwd={pass;word}}tail};Encrypt=yes;" +
      "TrustServerCertificate=no;Connection Timeout=45;",
  );

  assert.equal(config.server, "sql.example.test");
  assert.equal(config.port, 1433);
  assert.equal(config.database, "VitalisDB");
  assert.equal(config.user, "vitalis");
  assert.equal(config.password, "pass;word}tail");
  assert.equal(config.connectionTimeout, 45_000);
  assert.equal(config.options?.encrypt, true);
  assert.equal(config.options?.trustServerCertificate, false);
});

test("rejects incomplete or invalid SQL connection settings", () => {
  assert.throws(
    () =>
      parseAzureSqlConnectionString(
        "Server=sql.example.test;Database=VitalisDB;Uid=vitalis;",
      ),
    /contraseña/,
  );
  assert.throws(
    () =>
      parseAzureSqlConnectionString(
        "Server=sql.example.test;Database=VitalisDB;Uid=vitalis;Pwd=secret;" +
          "Encrypt=perhaps;",
      ),
    /encrypt/i,
  );
});
