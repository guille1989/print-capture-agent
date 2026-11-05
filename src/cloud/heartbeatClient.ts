import type { UpdateSignal, UpdateStatus } from "../ota/types.js";

export interface HeartbeatPayload {
  name: string;
  version: string;
  location?: { label?: string; city?: string; lat?: number; lng?: number };
  updateStatus?: UpdateStatus;
  updateError?: string;
}

/** Diagnóstico pedido por el operador; el agente corre el script del catálogo local con ese id. */
export interface PendingCommand {
  commandId: string;
  scriptId: string;
}

export interface HeartbeatResult {
  commands: PendingCommand[];
  update?: UpdateSignal;
}

function parseUpdate(raw: unknown): UpdateSignal | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const u = raw as Record<string, unknown>;
  if (typeof u.desiredVersion !== "string" || !u.desiredVersion.trim()) return undefined;
  if (typeof u.url !== "string" || !u.url.trim()) return undefined;
  if (typeof u.sha256 !== "string" || !u.sha256.trim()) return undefined;
  return {
    desiredVersion: u.desiredVersion.trim(),
    url: u.url.trim(),
    sha256: u.sha256.trim(),
  };
}

/**
 * Devuelve comandos pendientes y, si la nube lo pide, una señal OTA.
 * Un `204` (lo habitual, y lo único que responden los backends anteriores)
 * significa ninguno. Un cuerpo ilegible nunca hace fallar el heartbeat.
 */
export async function sendHeartbeat(
  url: string,
  apiKey: string,
  payload: HeartbeatPayload,
  timeoutMs: number,
): Promise<HeartbeatResult> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`heartbeat respondió HTTP ${response.status}`);
  if (response.status === 204) return { commands: [] };
  try {
    const body = (await response.json()) as { commands?: unknown; update?: unknown };
    const commands = Array.isArray(body.commands)
      ? body.commands.filter(
          (c): c is PendingCommand =>
            !!c && typeof (c as PendingCommand).commandId === "string" && typeof (c as PendingCommand).scriptId === "string",
        )
      : [];
    return { commands, update: parseUpdate(body.update) };
  } catch {
    return { commands: [] };
  }
}

export interface CommandResultPayload {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export async function sendCommandResult(
  baseUrl: string,
  apiKey: string,
  commandId: string,
  result: CommandResultPayload,
  timeoutMs: number,
): Promise<void> {
  const response = await fetch(`${baseUrl}/${encodeURIComponent(commandId)}/result`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(result),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`resultado del comando respondió HTTP ${response.status}`);
}
