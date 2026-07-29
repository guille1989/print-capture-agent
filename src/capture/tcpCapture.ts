import net from "node:net";

import { config } from "../config.js";
import { createTicketBufferer } from "./ticketBufferer.js";
import type { CaptureHandle } from "./types.js";

const RECONNECT_DELAY_MS = 5000;

export interface TcpPeripheral {
  /** Identificador lógico (no es un COM real) — ej. "datafono-caja1". Se usa como "port" en el resto del pipeline. */
  id: string;
  description: string;
  host: string;
  port: number;
}

/**
 * Se conecta como CLIENTE TCP a un periférico moderno (TPV/datáfono con
 * integración por socket o JSON API) — el mecanismo más común hoy en día
 * para terminales de pago según los TPVs relevados. Reintenta la conexión
 * indefinidamente si se cae.
 *
 * SUPUESTOS SIN VALIDAR CONTRA HARDWARE REAL:
 *  - El agente inicia la conexión (el periférico actúa de servidor TCP).
 *    Si en la práctica es al revés (el periférico se conecta a nosotros),
 *    esto hay que invertirlo a un net.createServer().
 *  - El delimitador entre mensajes es un salto de línea (`\n`) — típico en
 *    integraciones JSON-por-línea, pero si el TPV real usa otro framing
 *    (longitud-prefijo, STX/ETX, etc.) hay que reemplazar esta heurística.
 *
 * Reutiliza `createTicketBufferer` (la misma protección que usa la captura
 * serie) con `\n` como marcador: sin un límite de tamaño ni un timeout de
 * silencio, un periférico mal configurado, desconectado a mitad de mensaje
 * o con un framing distinto haría crecer `buffer` sin límite.
 */
export function captureTcp(
  peripheral: TcpPeripheral,
  onData: (rawText: string) => void,
): CaptureHandle {
  let socket: net.Socket | null = null;
  let closed = false;
  let reconnectTimer: NodeJS.Timeout | null = null;

  const bufferer = createTicketBufferer({
    marker: "\n",
    maxBufferBytes: config.ticketBufferMaxBytes,
    silenceTimeoutMs: config.ticketSilenceTimeoutMs,
    onTicketText: (rawText) => {
      const message = rawText.endsWith("\n") ? rawText.slice(0, -1) : rawText;
      if (message.trim()) onData(message);
    },
    onWarning: (message) => console.warn(`[capture-tcp] ${peripheral.id}: ${message}`),
  });

  function connect(): void {
    if (closed) return;

    socket = net.createConnection({ host: peripheral.host, port: peripheral.port });

    socket.on("connect", () => {
      console.log(`[capture-tcp] conectado a ${peripheral.id} (${peripheral.host}:${peripheral.port})`);
    });

    socket.on("data", (chunk: Buffer) => {
      bufferer.feed(chunk.toString("utf-8"));
    });

    socket.on("error", (err) => {
      console.error(`[capture-tcp] error en ${peripheral.id}:`, err.message);
    });

    socket.on("close", () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }

  connect();

  return {
    close: () => {
      closed = true;
      bufferer.dispose();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.destroy();
    },
  };
}
