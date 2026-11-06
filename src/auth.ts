import type { Request } from "express";
import { readSession } from "./session.js";

export interface EntraIdentity {
  oid: string;
  tid: string;
  name: string;
  email?: string;
}

export class AuthenticationError extends Error {
  constructor(
    message = "Se requiere una identidad autenticada.",
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AuthenticationError";
  }
}

const objectIdClaim =
  "http://schemas.microsoft.com/identity/claims/objectidentifier";
const tenantIdClaim = "http://schemas.microsoft.com/identity/claims/tenantid";
const emailClaim =
  "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress";
const uuidPattern = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

export function decodeAppServicePrincipal(
  encodedPrincipal: string,
  displayName = "",
): EntraIdentity {
  if (
    !encodedPrincipal ||
    !/^[A-Za-z\d+/]*={0,2}$/.test(encodedPrincipal) ||
    encodedPrincipal.length % 4 !== 0
  ) {
    throw new AuthenticationError("El principal de App Service no tiene formato válido.");
  }

  let principal: unknown;
  try {
    const decoded = Buffer.from(encodedPrincipal, "base64");
    if (decoded.toString("base64") !== encodedPrincipal) {
      throw new Error("Invalid base64");
    }
    principal = JSON.parse(decoded.toString("utf8")) as unknown;
  } catch (error) {
    throw new AuthenticationError("El principal de App Service no tiene formato válido.", {
      cause: error,
    });
  }

  if (
    typeof principal !== "object" ||
    principal === null ||
    !("claims" in principal) ||
    !Array.isArray(principal.claims)
  ) {
    throw new AuthenticationError("El principal de App Service no contiene claims.");
  }

  const claims = new Map<string, string>();
  for (const claim of principal.claims) {
    if (
      typeof claim === "object" &&
      claim !== null &&
      "typ" in claim &&
      "val" in claim &&
      typeof claim.typ === "string" &&
      typeof claim.val === "string"
    ) {
      claims.set(claim.typ.toLowerCase(), claim.val);
    }
  }

  const oid =
    claims.get("oid") ?? claims.get(objectIdClaim) ?? "";
  const tid =
    claims.get("tid") ?? claims.get(tenantIdClaim) ?? "";
  const name = claims.get("name") ?? displayName;
  const email = (
    claims.get("preferred_username") ??
    claims.get("email") ??
    claims.get("upn") ??
    claims.get(emailClaim) ??
    displayName
  )
    .trim()
    .toLowerCase();

  if (!uuidPattern.test(oid) || !uuidPattern.test(tid)) {
    throw new AuthenticationError("El principal no contiene Object ID y Tenant ID válidos.");
  }

  return {
    oid: oid.toLowerCase(),
    tid: tid.toLowerCase(),
    name,
    ...(email.includes("@") ? { email } : {}),
  };
}

export function getIdentityFromRequest(req: Request): EntraIdentity {
  if (process.env.WEBSITE_SITE_NAME) {
    const encodedPrincipal = req.get("X-MS-CLIENT-PRINCIPAL");
    if (!encodedPrincipal) throw new AuthenticationError();
    return decodeAppServicePrincipal(
      encodedPrincipal,
      req.get("X-MS-CLIENT-PRINCIPAL-NAME") ?? "",
    );
  }

  const session = readSession(req);
  if (!session?.identity) throw new AuthenticationError();
  return session.identity;
}
