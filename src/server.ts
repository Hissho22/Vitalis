import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ConfidentialClientApplication,
  type Configuration,
} from "@azure/msal-node";
import express, {
  type ErrorRequestHandler,
  type Request,
} from "express";
import { createAiService, PermissionError } from "./ai.js";
import type { ChatMessage } from "./ai.js";
import {
  AuthenticationError,
  getIdentityFromRequest,
  type EntraIdentity,
} from "./auth.js";
import { loadConfig } from "./config.js";
import {
  closeDatabase,
  type Employee,
} from "./db.js";
import { resolveEmployee, UNAUTHORIZED_ACCOUNT_MESSAGE } from "./employee.js";
import { AuthorizationError } from "./rbac.js";
import { renderSafeMarkdown } from "./markdown.js";
import { clearSession, readSession, writeSession } from "./session.js";

const config = loadConfig();
const runningInAppService = Boolean(process.env.WEBSITE_SITE_NAME);
if (
  runningInAppService &&
  !["true", "1"].includes(
    process.env.WEBSITE_AUTH_ENABLED?.trim().toLowerCase() ?? "",
  )
) {
  throw new Error(
    "Habilita y exige Microsoft Entra Authentication en App Service antes de iniciar Vitalis.",
  );
}
const aiService = createAiService(config);
const app = express();
const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const publicDirectory = path.resolve(currentDirectory, "../../public");

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(express.json({ limit: "384kb", strict: true }));
app.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

function isAppService(): boolean {
  return runningInAppService;
}

function getLocalMsalClient(): ConfidentialClientApplication {
  const clientId = process.env.MSAL_CLIENT_ID?.trim();
  const clientSecret = process.env.MSAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "Configura MSAL_CLIENT_ID y MSAL_CLIENT_SECRET para iniciar sesión localmente.",
    );
  }
  const msalConfig: Configuration = {
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${config.tenantId}`,
      clientSecret,
    },
  };
  return new ConfidentialClientApplication(msalConfig);
}

function getRedirectUri(): string {
  return (
    process.env.AUTH_REDIRECT_URI?.trim() ??
    `http://localhost:${config.port}/auth/callback`
  );
}

function queryString(req: Request, key: string): string | undefined {
  const value = req.query[key];
  return typeof value === "string" ? value : undefined;
}

function stringClaim(claims: object | undefined, name: string): string {
  if (!claims || !(name in claims)) return "";
  const value: unknown = Reflect.get(claims, name);
  return typeof value === "string" ? value : "";
}

function emailFromClaims(claims: object | undefined): string {
  const email = (
    stringClaim(claims, "preferred_username") ||
    stringClaim(claims, "email") ||
    stringClaim(claims, "upn")
  )
    .trim()
    .toLowerCase();
  return email.includes("@") ? email : "";
}

async function getActiveEmployee(req: Request): Promise<{
  identity: EntraIdentity;
  employee: Employee;
}> {
  const identity = getIdentityFromRequest(req);
  if (identity.tid !== config.tenantId) {
    throw new AuthorizationError(
      "Esta aplicación solo admite cuentas de la organización configurada.",
    );
  }
  const employee = await resolveEmployee(
    identity,
    undefined,
    config.adminDomain,
  );
  if (!employee) {
    throw new AuthorizationError(UNAUTHORIZED_ACCOUNT_MESSAGE);
  }
  if (!employee.rol.trim()) {
    throw new AuthorizationError("Tu perfil no tiene un rol asignado.");
  }
  return { identity, employee };
}

function enforceSameOrigin(req: Request): void {
  const origin = req.get("Origin");
  if (!origin) {
    throw new AuthorizationError("La solicitud no tiene un origen permitido.");
  }
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new AuthorizationError("El origen de la solicitud no es válido.");
    }
    throw error;
  }
  const expectedOrigin = `${req.protocol}://${req.get("host")}`;
  if (originUrl.origin !== expectedOrigin) {
    throw new AuthorizationError("La solicitud no tiene un origen permitido.");
  }
}

app.get("/healthz", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

app.get("/", (req, res) => {
  const session = readSession(req);
  if (session?.identity && session.threadId) {
    writeSession(req, res, { identity: session.identity });
  }
  res.sendFile(path.join(publicDirectory, "index.html"));
});

app.get("/auth/login", async (req, res) => {
  if (isAppService()) {
    res.redirect("/.auth/login/aad?post_login_redirect_uri=/");
    return;
  }

  const state = randomBytes(32).toString("base64url");
  const previousSession = readSession(req);
  writeSession(req, res, {
    ...(previousSession?.identity
      ? { identity: previousSession.identity }
      : {}),
    oauthState: state,
    oauthStateExpiresAt: Date.now() + 10 * 60 * 1000,
  });
  const url = await getLocalMsalClient().getAuthCodeUrl({
    scopes: ["openid", "profile", "email"],
    redirectUri: getRedirectUri(),
    state,
    prompt: "select_account",
  });
  res.redirect(url);
});

app.get("/auth/callback", async (req, res) => {
  const code = queryString(req, "code");
  const state = queryString(req, "state");
  const previousSession = readSession(req);
  if (
    !code ||
    !state ||
    !previousSession?.oauthState ||
    previousSession.oauthState !== state ||
    !previousSession.oauthStateExpiresAt ||
    previousSession.oauthStateExpiresAt <= Date.now()
  ) {
    clearSession(res);
    throw new AuthenticationError("La respuesta de inicio de sesión no es válida.");
  }

  const tokenResult = await getLocalMsalClient().acquireTokenByCode({
    code,
    scopes: ["openid", "profile", "email"],
    redirectUri: getRedirectUri(),
    state,
  });
  const claims = tokenResult.idTokenClaims;
  const identity = {
    oid: stringClaim(claims, "oid").toLowerCase(),
    tid: stringClaim(claims, "tid").toLowerCase(),
    name:
      stringClaim(claims, "name") ||
      stringClaim(claims, "preferred_username"),
    ...(emailFromClaims(claims) ? { email: emailFromClaims(claims) } : {}),
  };
  const uuidPattern =
    /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
  if (!uuidPattern.test(identity.oid) || !uuidPattern.test(identity.tid)) {
    throw new AuthenticationError(
      "Microsoft Entra no devolvió Object ID y Tenant ID.",
    );
  }
  if (identity.tid !== config.tenantId) {
    throw new AuthorizationError(
      "Esta aplicación solo admite cuentas de la organización configurada.",
    );
  }

  const employee = await resolveEmployee(
    identity,
    undefined,
    config.adminDomain,
  );
  if (!employee) {
    throw new AuthorizationError(UNAUTHORIZED_ACCOUNT_MESSAGE);
  }
  writeSession(req, res, { identity });
  res.redirect("/");
});

app.post("/auth/logout", (req, res) => {
  clearSession(res);
  res.redirect(isAppService() ? "/.auth/logout?post_logout_redirect_uri=/" : "/");
});

app.get("/api/me", async (req, res) => {
  try {
    const { identity, employee } = await getActiveEmployee(req);
    writeSession(req, res, { identity });
    res.json({
      name: employee.nombre,
      role: employee.rol.trim(),
      rol: employee.rol.trim(),
      autorizado: true,
    });
  } catch (error) {
    if (error instanceof AuthorizationError) {
      res.status(403).json({
        rol: null,
        autorizado: false,
        mensaje: error.message,
        error: error.message,
      });
      return;
    }
    throw error;
  }
});

app.post("/api/new-chat", async (req, res) => {
  enforceSameOrigin(req);
  const { identity } = await getActiveEmployee(req);
  writeSession(req, res, { identity });
  res.status(204).end();
});

app.post("/api/chat", async (req, res) => {
  enforceSameOrigin(req);
  const { identity } = await getActiveEmployee(req);
  if (req.body?.confirmation !== undefined) {
    const confirmed = await aiService.confirmAction(
      req.body.confirmation,
      identity,
    );
    writeSession(req, res, { identity });
    res.json({
      response: confirmed.response,
      html: await renderSafeMarkdown(confirmed.response),
    });
    return;
  }
  const rawMessages: unknown =
    req.body?.messages ??
    (typeof req.body?.message === "string"
      ? [{ role: "user", content: req.body.message }]
      : undefined);
  const maxMessages = 40;
  const maxMessageLength = 8000;
  const maxHistoryLength = 48_000;
  if (
    !Array.isArray(rawMessages) ||
    rawMessages.length === 0 ||
    rawMessages.length > maxMessages
  ) {
    res.status(400).json({
      error: "El historial de conversación no es válido.",
    });
    return;
  }

  const messages: ChatMessage[] = [];
  let historyLength = 0;
  for (let index = 0; index < rawMessages.length; index += 1) {
    const item: unknown = rawMessages[index];
    if (
      typeof item !== "object" ||
      item === null ||
      Array.isArray(item) ||
      !("role" in item) ||
      !("content" in item) ||
      (item.role !== "user" && item.role !== "assistant") ||
      typeof item.content !== "string" ||
      !item.content.trim() ||
      item.content.length > maxMessageLength ||
      item.role !== (index % 2 === 0 ? "user" : "assistant")
    ) {
      res.status(400).json({
        error: "El historial debe alternar mensajes válidos de usuario y asistente.",
      });
      return;
    }
    historyLength += item.content.length;
    if (historyLength > maxHistoryLength) {
      res.status(400).json({
        error: "El historial excede el límite permitido para esta conversación.",
      });
      return;
    }
    messages.push({ role: item.role, content: item.content.trim() });
  }
  if (messages.at(-1)?.role !== "user") {
    res.status(400).json({
      error: "El historial debe terminar con un mensaje del usuario.",
    });
    return;
  }

  const result = await aiService.chat(messages, identity);
  writeSession(req, res, { identity });
  const html = await renderSafeMarkdown(result.response);
  res.json({
    response: result.response,
    html,
    ...(result.confirmationRequest
      ? { confirmationRequest: result.confirmationRequest }
      : {}),
  });
});

app.use(express.static(publicDirectory, { index: false, maxAge: 0 }));

function redactDiagnosticText(value: string, requestMessages: unknown): string {
  let redacted = value;
  const messages = typeof requestMessages === "string"
    ? [requestMessages]
    : Array.isArray(requestMessages)
      ? requestMessages
        .filter(
          (item): item is { content: string } =>
            typeof item === "object" &&
            item !== null &&
            "content" in item &&
            typeof item.content === "string",
        )
        .map((item) => item.content)
      : [];
  for (const message of messages) {
    if (message) {
      redacted = redacted.split(message).join("[MENSAJE DE SOLICITUD OMITIDO]");
    }
  }
  for (const secret of [
    process.env.SESSION_SECRET,
    process.env.MSAL_CLIENT_SECRET,
    process.env.AZURE_SQL_CONNECTION_STRING,
  ]) {
    if (secret) redacted = redacted.split(secret).join("[SECRETO OMITIDO]");
  }
  return redacted
    .replace(/(Bearer\s+)[^\s"'`,;]+/gi, "$1[TOKEN OMITIDO]")
    .replace(
      /((?:password|pwd|client_secret|access_token|refresh_token|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^;\s,]+)/gi,
      "$1[SECRETO OMITIDO]",
    );
}

const errorHandler: ErrorRequestHandler = (error: unknown, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }

  if (error instanceof AuthenticationError) {
    res.status(401).json({ error: error.message });
    return;
  }
  if (error instanceof AuthorizationError || error instanceof PermissionError) {
    res.status(403).json({ error: error.message });
    return;
  }

  const errorName = error instanceof Error ? error.name : "UnknownError";
  if (process.env.NODE_ENV !== "production") {
    const errorMessage =
      error instanceof Error ? error.message : String(error);
    const errorCode =
      error instanceof Error &&
      "code" in error &&
      (typeof error.code === "string" || typeof error.code === "number")
        ? error.code
        : undefined;
    const errorStack = error instanceof Error ? error.stack : undefined;
    console.error("La solicitud de Vitalis falló.", {
      errorName,
      message: redactDiagnosticText(
        errorMessage,
        req.body?.messages ?? req.body?.message,
      ),
      ...(errorCode === undefined ? {} : { code: errorCode }),
      ...(errorStack
        ? {
            stack: redactDiagnosticText(
              errorStack,
              req.body?.messages ?? req.body?.message,
            ),
          }
        : {}),
    });
  }
  res.status(500).json({
    error:
      "No se pudo completar la solicitud por una intermitencia del sistema. " +
      "No se confirmó ningún cambio que no haya sido guardado.",
  });
};
app.use(errorHandler);

const server = createServer(app);
server.listen(config.port, "0.0.0.0", () => {
  console.log(`Vitalis escucha en el puerto ${config.port}.`);
});

async function shutdown(signal: string): Promise<void> {
  console.log(`Vitalis recibió ${signal}; cerrando recursos.`);
  server.close(async (error) => {
    if (error) {
      console.error("No se pudo cerrar el servidor HTTP.", {
        errorName: error.name,
      });
      process.exitCode = 1;
    }
    try {
      await closeDatabase();
    } catch (shutdownError) {
      console.error("No se pudieron cerrar todos los recursos.", {
        errorName:
          shutdownError instanceof Error ? shutdownError.name : "UnknownError",
      });
      process.exitCode = 1;
    }
  });
}

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
