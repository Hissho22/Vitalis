import "dotenv/config";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AIProjectClient } from "@azure/ai-projects";
import type {
  AgentDefinitionUnion,
  PromptAgentDefinition,
} from "@azure/ai-projects";
import { DefaultAzureCredential } from "@azure/identity";
import { resolveProjectEndpoint } from "../src/config.js";

const rootDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const protocolsDirectory = path.join(rootDirectory, "Protocolos");

async function readProtocol(filename: string): Promise<string> {
  return (await readFile(path.join(protocolsDirectory, filename), "utf8")).trim();
}

function requiredSetting(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Falta configurar ${name} en .env o en el entorno.`);
  return value;
}

function isPromptDefinition(
  definition: AgentDefinitionUnion,
): definition is PromptAgentDefinition {
  return (
    definition.kind === "prompt" &&
    "model" in definition &&
    typeof definition.model === "string"
  );
}

async function buildSystemPrompt(
  role: string,
  scope: string,
  protocols: {
    zeroHallucination: string;
    roleBoundaries: string;
    antiJailbreak: string;
    safeFailure: string;
    orchestratorSop: string;
  },
): Promise<string> {
  const roleProtocol = protocols.roleBoundaries
    .replaceAll("{{ROL_ESPECÍFICO}}", role)
    .replaceAll("{{TAREA_AUTORIZADA}}", scope);
  const failureProtocol = protocols.safeFailure.replace(
    "**Agente Orquestador:**",
    `**${role}:**`,
  );
  const orchestratorSop =
    role === "Agente Orquestador"
      ? `\n## Flujo Operativo Estándar de Vitalis\n${protocols.orchestratorSop}`
      : "";

  return [
    `# Instrucciones del sistema — ${role}`,
    "",
    `Eres ${role}. Tu tarea autorizada es: ${scope}.`,
    "Responde en español, de forma clara y respetuosa, sin salir de esta jurisdicción.",
    "",
    "## Protocolo de Cero Alucinación",
    protocols.zeroHallucination,
    "",
    "## Protocolo de Fronteras de Rol",
    roleProtocol,
    "",
    "## Protocolo de Seguridad Anti-Jailbreak",
    protocols.antiJailbreak,
    "",
    "## Protocolo de Fallo Seguro y Derivación Humana",
    failureProtocol,
    orchestratorSop,
  ]
    .join("\n")
    .trim();
}

async function main(): Promise<void> {
  const agentRoles = [
    [
      requiredSetting("ORCHESTRATOR_AGENT_NAME"),
      "Agente Orquestador",
      "coordinar solicitudes hospitalarias y derivarlas al agente especialista apropiado, sin emitir criterio clínico",
    ],
    [
      requiredSetting("ADMISSION_AGENT_NAME"),
      "Agente de Admisión",
      "gestionar la captura y consulta de datos administrativos de admisión, sin determinar prioridad clínica",
    ],
    [
      requiredSetting("HISTORY_AGENT_NAME"),
      "Agente de Historial",
      "consultar y presentar únicamente los antecedentes explícitos disponibles, sin interpretarlos clínicamente",
    ],
    [
      requiredSetting("INSURANCE_AGENT_NAME"),
      "Agente de Pólizas",
      "validar en modo de solo lectura el estatus de la póliza, sin calcular deducibles ni inventar coberturas",
    ],
    [
      requiredSetting("CONSULTATION_AGENT_NAME"),
      "Agente Médico",
      "recabar motivo de consulta, síntomas y signos vitales; evaluar y clasificar urgencia; revisar antecedentes y alergias del expediente; generar diagnóstico y receta solo tras validar alergias, sin inventar datos clínicos",
    ],
    [
      requiredSetting("PHARMACY_AGENT_NAME"),
      "Agente de Farmacia",
      "gestionar la logística de farmacia, registrar la confirmación del despacho físico y actualizar el estatus de la receta, sin indicar tratamientos",
    ],
  ] as const;

  const protocols = {
    zeroHallucination: await readProtocol("CeroAlucinacion.md"),
    roleBoundaries: await readProtocol("FronterasRol.md"),
    antiJailbreak: await readProtocol("AntiJailbreak.md"),
    safeFailure: await readProtocol("FalloSeguro.md"),
    orchestratorSop: await readProtocol("SOP_Orquestador_Vitalis.md"),
  };
  const credential = new DefaultAzureCredential();
  const project = new AIProjectClient(
    resolveProjectEndpoint(process.env),
    credential,
  );

  for (const [agentName, role, scope] of agentRoles) {
    const agent = await project.agents.get(agentName);
    const currentDefinition = agent.versions.latest.definition;
    if (!isPromptDefinition(currentDefinition)) {
      throw new TypeError(
        `El agente ${agentName} no usa una definición de tipo prompt; no se actualizaron sus instrucciones.`,
      );
    }

    const updatedDefinition: PromptAgentDefinition = {
      ...currentDefinition,
      instructions: await buildSystemPrompt(role, scope, protocols),
    };
    const updatedVersion = await project.agents.createVersion(
      agentName,
      updatedDefinition,
    );
    console.log(`Agente actualizado: ${agentName} (versión ${updatedVersion.version})`);
  }
}

main().catch((error: unknown) => {
  console.error("Falló la actualización de instrucciones de Foundry.", {
    errorName: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
