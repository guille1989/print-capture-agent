import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { stdin, stdout } from "node:process";

import { activateAgent } from "./activationClient.js";

export interface AgentCredentials {
  agentId?: string;
  name: string;
  apiKey: string;
}

export async function loadCredentials(path: string): Promise<AgentCredentials | undefined> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as AgentCredentials;
    return value?.apiKey && value?.name ? value : undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    throw new Error(`no se pudieron leer las credenciales de ${path}`, { cause: err });
  }
}

async function saveCredentials(path: string, value: AgentCredentials): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

export async function ensureCredentials(options: {
  path: string;
  envApiKey?: string;
  activationUrl: string;
  timeoutMs: number;
}): Promise<AgentCredentials> {
  if (options.envApiKey) return { name: process.env.AGENT_NAME?.trim() || hostname(), apiKey: options.envApiKey };
  const stored = await loadCredentials(options.path);
  if (stored) return stored;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`el agente todavía no está activado; ejecútalo una vez en una consola interactiva o define CLOUD_API_KEY`);
  }

  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log("[activation] Este robot todavía no está vinculado a un negocio.");
    const code = await prompt.question("Código de activación (XXXXX-XXXXX): ");
    const suggestedName = process.env.AGENT_NAME?.trim() || hostname();
    const name = (await prompt.question(`Nombre del robot [${suggestedName}]: `)).trim() || suggestedName;
    const activated = await activateAgent(options.activationUrl, code, name, options.timeoutMs);
    const credentials = { agentId: activated.agentId, name: activated.name, apiKey: activated.apiKey };
    await saveCredentials(options.path, credentials);
    console.log(`[activation] Robot "${activated.name}" activado. La credencial quedó guardada en ${options.path}.`);
    return credentials;
  } finally {
    prompt.close();
  }
}
