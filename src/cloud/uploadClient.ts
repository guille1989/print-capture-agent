export interface CloudUploadResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface CloudUploadClientOptions {
  url: string;
  apiKey?: string;
  timeoutMs: number;
}

/**
 * Cliente de subida a la nube. Hoy no hay backend real todavía — esto
 * queda listo para apuntar a la URL que se defina, con manejo de error
 * de red separado del de status HTTP para que el llamador pueda decidir
 * si reintentar o no.
 */
export async function uploadTicket(
  options: CloudUploadClientOptions,
  record: unknown,
): Promise<CloudUploadResult> {
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(options.apiKey ? { "x-api-key": options.apiKey } : {}),
      },
      body: JSON.stringify(record),
      // Sin esto, una conexión que se queda abierta sin responder nunca
      // resuelve ni rechaza — `syncQueueToCloud` queda colgado para
      // siempre y ningún ticket posterior en la cola llega a subirse.
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
