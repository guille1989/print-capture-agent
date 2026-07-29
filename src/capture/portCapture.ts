import { SerialPort } from "serialport";

import { config } from "../config.js";
import { createTicketBufferer } from "./ticketBufferer.js";
import type { CaptureHandle } from "./types.js";

const CUT_PAPER_MARKER = "\x1dV"; // GS V — comando ESC/POS de corte de papel

/**
 * Abre un puerto y junta los bytes que le llegan hasta detectar el fin de
 * un ticket, momento en el que llama a onTicketText con el texto crudo
 * acumulado (todavía sin limpiar de códigos de control — eso lo hace el
 * parser). La lógica de acumulación en sí vive en `ticketBufferer.ts`
 * (separada para poder probarla con chunks sintéticos, sin necesitar un
 * puerto serie real).
 *
 * SUPUESTOS SIN VALIDAR CONTRA HARDWARE REAL (ajustar apenas haya una
 * captura real de la PC del negocio):
 *  - baudRate: 9600 — puede no importar en un puerto virtual, pero si el
 *    driver de redirección lo exige, hay que setearlo igual que la
 *    impresora que reemplaza.
 *  - Delimitador de fin de ticket: el comando ESC/POS de corte de papel
 *    (GS V). Si el software del POS no manda ese comando, o el driver lo
 *    filtra, esta heurística no dispara nunca por sí sola — por eso hay
 *    un timeout de silencio (`config.ticketSilenceTimeoutMs`) y un límite
 *    de tamaño (`config.ticketBufferMaxBytes`) como red de contención,
 *    para no perder el ticket en un buffer que crece para siempre. Si
 *    alguno de los dos se dispara seguido contra hardware real, es señal
 *    de que hay que ajustar el valor o buscar otra señal de corte.
 */
export function capturePort(
  path: string,
  onTicketText: (rawText: string) => void,
  options: { baudRate?: number } = {},
): CaptureHandle {
  const port = new SerialPort({ path, baudRate: options.baudRate ?? 9600, autoOpen: true });

  const bufferer = createTicketBufferer({
    marker: CUT_PAPER_MARKER,
    maxBufferBytes: config.ticketBufferMaxBytes,
    silenceTimeoutMs: config.ticketSilenceTimeoutMs,
    onTicketText,
    onWarning: (message) => console.warn(`[capture] ${path}: ${message}`),
  });

  port.on("data", (chunk: Buffer) => bufferer.feed(chunk.toString("latin1")));

  port.on("error", (err) => {
    console.error(`[capture] error en ${path}:`, err.message);
  });

  return {
    close: () => {
      bufferer.dispose();
      if (port.isOpen) port.close();
    },
  };
}
