import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import type { Request, Response } from "express";
import type { EntraIdentity } from "./auth.js";

export interface AppSession {
  identity?: EntraIdentity;
  threadId?: string;
  oauthState?: string;
  oauthStateExpiresAt?: number;
  expiresAt: number;
}

const COOKIE_NAME = "vitalis_session";
const SESSION_TTL_SECONDS = 8 * 60 * 60;

function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 32) {
    throw new Error("SESSION_SECRET debe tener al menos 32 caracteres.");
  }
  return createHash("sha256").update(secret, "utf8").digest();
}

function encryptSession(session: AppSession): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(session), "utf8"),
    cipher.final(),
  ]);
  return [
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

function decryptSession(token: string): AppSession | undefined {
  const [encodedIv, encodedTag, encodedData, ...extra] = token.split(".");
  if (!encodedIv || !encodedTag || !encodedData || extra.length > 0) return undefined;
  if (
    !/^[A-Za-z\d_-]+$/.test(encodedIv) ||
    !/^[A-Za-z\d_-]+$/.test(encodedTag) ||
    !/^[A-Za-z\d_-]+$/.test(encodedData)
  ) {
    return undefined;
  }

  try {
    const iv = Buffer.from(encodedIv, "base64url");
    const tag = Buffer.from(encodedTag, "base64url");
    const ciphertext = Buffer.from(encodedData, "base64url");
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) {
      return undefined;
    }
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      iv,
    );
    decipher.setAuthTag(tag);
    const decrypted = decipher.update(ciphertext);
    let finalBlock: Buffer;
    try {
      finalBlock = decipher.final();
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "Unsupported state or unable to authenticate data"
      ) {
        return undefined;
      }
      throw error;
    }
    const plaintext = Buffer.concat([decrypted, finalBlock]).toString("utf8");
    const value: unknown = JSON.parse(plaintext);
    if (
      typeof value !== "object" ||
      value === null ||
      !("expiresAt" in value) ||
      typeof value.expiresAt !== "number" ||
      value.expiresAt <= Date.now()
    ) {
      return undefined;
    }
    return value as AppSession;
  } catch (error) {
    if (
      error instanceof SyntaxError ||
      error instanceof TypeError ||
      (error instanceof Error &&
        "code" in error &&
        typeof error.code === "string" &&
        (error.code === "ERR_OSSL_BAD_DECRYPT" ||
          error.code.startsWith("ERR_CRYPTO")))
    ) {
      return undefined;
    }
    throw error;
  }
}

function sessionCookie(req: Request): string | undefined {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) return undefined;

  for (const entry of cookieHeader.split(";")) {
    const separator = entry.indexOf("=");
    if (separator < 0 || entry.slice(0, separator).trim() !== COOKIE_NAME) continue;
    try {
      return decodeURIComponent(entry.slice(separator + 1).trim());
    } catch (error) {
      if (error instanceof URIError) return undefined;
      throw error;
    }
  }
  return undefined;
}

export function readSession(req: Request): AppSession | undefined {
  const token = sessionCookie(req);
  return token ? decryptSession(token) : undefined;
}

export function writeSession(
  req: Request,
  res: Response,
  session: Omit<AppSession, "expiresAt">,
): void {
  const value: AppSession = {
    ...session,
    expiresAt: Date.now() + SESSION_TTL_SECONDS * 1000,
  };
  const secure = req.secure || process.env.NODE_ENV === "production";
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=${encodeURIComponent(encryptSession(value))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_SECONDS}${secure ? "; Secure" : ""}`,
  );
}

export function clearSession(res: Response): void {
  const secure =
    process.env.NODE_ENV === "production" ||
    Boolean(process.env.WEBSITE_SITE_NAME);
  res.setHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
  );
}
