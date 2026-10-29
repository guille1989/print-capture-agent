import type { CommandResultPayload, PendingCommand } from "../cloud/heartbeatClient.js";
import type { DiagnosticResult } from "./runner.js";

export interface CommandWorkerDeps {
  run: (scriptId: string) => Promise<DiagnosticResult>;
  report: (commandId: string, result: CommandResultPayload) => Promise<void>;
  /** Pausa entre reintentos de `report`; se inyecta para que los tests no esperen. */
  sleep?: (ms: number) => Promise<void>;
}

const REPORT_RETRY_DELAYS_MS = [0, 2_000, 10_000];

/**
 * Corre los diagnósticos pedidos por la nube, de a uno, y devuelve la salida.
 * Cada comando se corre una sola vez aunque el heartbeat lo repita (`seen`);
 * la nube ya los entrega una vez, esto cubre el reintento tras un error de red
 * a mitad de la respuesta. Un fallo no tira abajo el agente: se loguea y sigue.
 */
export function createCommandWorker(deps: CommandWorkerDeps) {
  const seen = new Set<string>();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let chain: Promise<void> = Promise.resolve();

  async function processOne(command: PendingCommand): Promise<void> {
    console.log(`[diagnostics] corriendo "${command.scriptId}" (${command.commandId})`);
    const result = await deps.run(command.scriptId);

    let lastError: unknown;
    for (const delayMs of REPORT_RETRY_DELAYS_MS) {
      if (delayMs > 0) await sleep(delayMs);
      try {
        await deps.report(command.commandId, result);
        console.log(`[diagnostics] "${command.scriptId}" terminó (exit ${result.exitCode}, ${result.durationMs} ms)`);
        return;
      } catch (err) {
        lastError = err;
      }
    }
    console.error(`[diagnostics] no se pudo informar el resultado de ${command.commandId}:`, lastError);
  }

  return {
    /** Encadena el trabajo: dos heartbeats seguidos nunca corren dos PowerShell a la vez. */
    enqueue(commands: PendingCommand[]): Promise<void> {
      for (const command of commands) {
        if (seen.has(command.commandId)) continue;
        seen.add(command.commandId);
        chain = chain.then(() =>
          processOne(command).catch((err) => console.error(`[diagnostics] error inesperado en ${command.commandId}:`, err)),
        );
      }
      return chain;
    },
  };
}
