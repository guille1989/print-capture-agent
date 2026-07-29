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

export const config = {
  agentName: "print-capture-agent",
  agentVersion: "0.1.0",
  cloudUploadUrl: process.env.CLOUD_UPLOAD_URL ?? "https://example.invalid/api/tickets",
  cloudApiKey: process.env.CLOUD_API_KEY,
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
