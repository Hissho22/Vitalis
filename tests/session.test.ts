import assert from "node:assert/strict";
import type { Request, Response } from "express";
import { test } from "node:test";
import { readSession, writeSession } from "../src/session.js";

const identity = {
  oid: "d85b1407-351d-4694-9392-03acc5870eb1",
  tid: "799bd0cb-438c-4214-9abe-19ea0d669df8",
  name: "Usuario de prueba",
};

test("encrypts session state in an HttpOnly cookie and rejects tampering", () => {
  const originalSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "a-session-encryption-secret-long-enough";
  try {
    let cookieHeader = "";
    const response = {
      setHeader: (_name: string, value: string) => {
        cookieHeader = value;
      },
    } as unknown as Response;
    writeSession(
      { secure: false } as Request,
      response,
      { identity, threadId: "conv_test" },
    );
    assert.match(cookieHeader, /HttpOnly/);
    assert.match(cookieHeader, /SameSite=Lax/);

    const cookie = cookieHeader.split(";")[0]!;
    const request = {
      headers: { cookie },
    } as Request;
    assert.deepEqual(readSession(request)?.identity, identity);
    assert.equal(readSession(request)?.threadId, "conv_test");

    const [name, value] = cookie.split("=");
    const components = value!.split(".");
    const first = components[2]![0] === "A" ? "B" : "A";
    components[2] = `${first}${components[2]!.slice(1)}`;
    const tampered = `${name}=${components.join(".")}`;
    assert.equal(
      readSession({ headers: { cookie: tampered } } as Request),
      undefined,
    );
  } finally {
    if (originalSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = originalSecret;
  }
});
