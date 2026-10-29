export interface HeartbeatPayload {
  name: string;
  version: string;
  location?: { label?: string; city?: string; lat?: number; lng?: number };
}

/** Diagnóstico pedido por el operador; el agente corre el script del catálogo local con ese id. */
export interface PendingCommand {
  commandId: string;
  scriptId: string;
}

/**
 * Devuelve los comandos que la nube tenía pendientes para este agente. Un
 * `204` (lo habitual, y lo único que responden los backends anteriores)
 * significa ninguno. Un cuerpo ilegible nunca hace fallar el heartbeat.
 */
export async function sendHeartbeat(url: string, apiKey: string, payload: HeartbeatPayload, timeoutMs: number): Promise<PendingCommand[]> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`heartbeat respondió HTTP ${response.status}`);
  if (response.status === 204) return [];
  try {
    const body = (await response.json()) as { commands?: unknown };
    if (!Array.isArray(body.commands)) return [];
    return body.commands.filter(
      (c): c is PendingCommand =>
        !!c && typeof (c as PendingCommand).commandId === "string" && typeof (c as PendingCommand).scriptId === "string",
    );
  } catch {
    return [];
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
