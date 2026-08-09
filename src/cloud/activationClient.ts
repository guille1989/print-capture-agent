export interface ActivatedAgent {
  agentId: string;
  name: string;
  apiKey: string;
}

export async function activateAgent(
  url: string,
  code: string,
  name: string,
  timeoutMs: number,
): Promise<ActivatedAgent> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim().toUpperCase(), name: name.trim() }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = (await response.json().catch(() => ({}))) as Partial<ActivatedAgent> & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `la activación respondió HTTP ${response.status}`);
  if (!body.agentId || !body.name || !body.apiKey) throw new Error("la activación devolvió una respuesta incompleta");
  return body as ActivatedAgent;
}
