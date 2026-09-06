import type { TcpPeripheral } from "./capture/tcpCapture.js";

/**
 * A diferencia de los puertos serie (que se descubren solos con
 * SerialPort.list()), un periférico TCP (ej. un TPV moderno con API JSON)
 * no se puede "detectar" — hay que decirle la IP. Se configura como JSON
 * en TCP_PERIPHERALS, ej.:
 *   TCP_PERIPHERALS='[{"id":"datafono-caja1","description":"TPV caja 1","host":"192.168.1.50","port":9000}]'
 */
function parseTcpPeripherals(): TcpPeripheral[] {
  const raw = process.env.TCP_PERIPHERALS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[config] TCP_PERIPHERALS no es JSON válido, se ignora:", err);
    return [];
  }
}

function apiSibling(path: string): string {
  try {
    const url = new URL(process.env.CLOUD_UPLOAD_URL ?? "https://example.invalid/api/tickets");
    // Sin la barra inicial en el patrón, la reemplazada se come el "/" que
    // separaba "/tickets" del resto — "/prod/tickets" quedaba
    // "/prodagents/activate" en vez de "/prod/agents/activate". API
    // Gateway responde 403 "Forbidden" para una ruta que no existe (nunca
    // llega a invocar el Lambda), así que este bug se manifestaba como un
    // 403 en la activación/heartbeat sin ninguna pista en el body.
    url.pathname = url.pathname.replace(/tickets\/?$/, path);
    return url.toString();
  } catch {
    return `https://example.invalid/api/${path}`;
  }
}

function optionalNumber(name: string): number | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export const config = {
  agentName: "print-capture-agent",
  agentVersion: "0.2.0",
  cloudUploadUrl: process.env.CLOUD_UPLOAD_URL ?? "https://example.invalid/api/tickets",
  cloudApiKey: process.env.CLOUD_API_KEY,
  activationUrl: process.env.CLOUD_ACTIVATION_URL ?? apiSibling("agents/activate"),
  heartbeatUrl: process.env.CLOUD_HEARTBEAT_URL ?? apiSibling("agents/heartbeat"),
  credentialsFilePath: process.env.AGENT_CREDENTIALS_FILE ?? "./data/credentials.json",
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS) || 60 * 1000,
  // La ubicación se administra normalmente desde InnoApp Web. Si esta
  // instalación no declara ninguna variable, se omite del heartbeat para
  // no borrar la ubicación persistida por el negocio con un objeto vacío.
  location: (() => {
    const value = {
      label: process.env.AGENT_LOCATION_LABEL,
      city: process.env.AGENT_CITY,
      lat: optionalNumber("AGENT_LAT"),
      lng: optionalNumber("AGENT_LNG"),
    };
    return Object.values(value).some((item) => item !== undefined) ? value : undefined;
  })(),
  queueFilePath: process.env.QUEUE_FILE ?? "./data/queue.json",
  idleThresholdMs: 5 * 60 * 1000,
  portScanIntervalMs: 10 * 1000,
  cloudSyncIntervalMs: 15 * 1000,
  /**
   * Si el backend no responde dentro de este tiempo, se aborta la subida y
   * se trata como falla transitoria (reintenta por backoff) — sin esto, un
   * `fetch` colgado bloquea `syncQueueToCloud` para siempre y ningún
   * ticket posterior en la cola llega a subirse.
   */
  cloudUploadTimeoutMs: Number(process.env.CLOUD_UPLOAD_TIMEOUT_MS) || 20 * 1000,
  /**
   * Si no aparece el marcador de corte de papel (GS V) y el buffer de un
   * puerto serie supera esto, se entrega igual en vez de acumular para
   * siempre — valor generoso para un ticket de texto plano (varios KB de
   * margen), pero sin validar contra hardware real todavía.
   */
  ticketBufferMaxBytes: 8 * 1024,
  /**
   * Si no llega nada nuevo en un puerto serie durante este tiempo y hay
   * algo sin cerrar en el buffer, se entrega por silencio — cubre el caso
   * de un POS que nunca manda GS V. Sin validar contra hardware real: si
   * en la práctica una impresora real hace pausas más largas que esto
   * entre líneas de un mismo ticket, hay que subir este valor.
   */
  ticketSilenceTimeoutMs: 3 * 1000,
  /**
   * Mientras esto sea false, el agente detecta y reporta todos los puertos
   * pero no abre ninguno para leer datos — etapa deliberada mientras los
   * supuestos de captura (marcador de fin de ticket, baud rate, encoding)
   * siguen sin validar contra hardware real. Poner ENABLE_CAPTURE=true
   * cuando se quiera prender la lectura.
   */
  captureEnabled: process.env.ENABLE_CAPTURE === "true",
  tcpPeripherals: parseTcpPeripherals(),
};
