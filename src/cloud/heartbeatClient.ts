export interface HeartbeatPayload {
  name: string;
  version: string;
  location?: { label?: string; city?: string; lat?: number; lng?: number };
}

export async function sendHeartbeat(url: string, apiKey: string, payload: HeartbeatPayload, timeoutMs: number): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw new Error(`heartbeat respondió HTTP ${response.status}`);
}
