export interface TicketBuffererOptions {
  /** Marca el fin de un ticket dentro del texto acumulado (ej. GS V). */
  marker: string;
  /** Si el buffer supera esto sin encontrar `marker`, se entrega igual. */
  maxBufferBytes: number;
  /** Si no llega nada nuevo en este tiempo y hay algo sin cerrar, se entrega por silencio. */
  silenceTimeoutMs: number;
  onTicketText: (rawText: string) => void;
  onWarning?: (message: string) => void;
}

export interface TicketBufferer {
  /** Agrega texto crudo recién llegado — entrega cero, uno o varios tickets si corresponde. */
  feed(text: string): void;
  /** Cancela el timer de silencio pendiente, si hay uno. */
  dispose(): void;
}

/**
 * Junta texto crudo hasta encontrar `marker`, sacado de `portCapture.ts`
 * para poder probarlo con chunks de texto sintéticos, sin necesitar un
 * puerto serie real ni mockear `SerialPort`.
 *
 * Un mismo `feed()` puede traer más de un ticket (o el resto de uno viejo
 * más el arranque del siguiente) si el driver agrupa varios envíos — por
 * eso se busca `marker` repetidamente y se entrega un ticket por cada
 * aparición, conservando lo que sobra después del último para el próximo
 * `feed()`, en vez de asumir que todo el buffer es un solo ticket.
 */
export function createTicketBufferer(options: TicketBuffererOptions): TicketBufferer {
  const { marker, maxBufferBytes, silenceTimeoutMs, onTicketText, onWarning } = options;
  let buffer = "";
  let silenceTimer: NodeJS.Timeout | null = null;

  function clearSilenceTimer(): void {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  function rearmSilenceTimer(): void {
    clearSilenceTimer();
    if (buffer.length === 0) return;
    silenceTimer = setTimeout(() => {
      onWarning?.(`silencio de ${silenceTimeoutMs}ms sin marcador, se entrega igual (${buffer.length} bytes)`);
      const text = buffer;
      buffer = "";
      onTicketText(text);
    }, silenceTimeoutMs);
  }

  return {
    feed(text: string): void {
      buffer += text;

      let markerIndex = buffer.indexOf(marker);
      while (markerIndex !== -1) {
        const ticketEnd = markerIndex + marker.length;
        onTicketText(buffer.slice(0, ticketEnd));
        buffer = buffer.slice(ticketEnd);
        markerIndex = buffer.indexOf(marker);
      }

      if (buffer.length > maxBufferBytes) {
        onWarning?.(`buffer superó ${maxBufferBytes} bytes sin marcador, se entrega igual`);
        onTicketText(buffer);
        buffer = "";
      }

      rearmSilenceTimer();
    },
    dispose(): void {
      clearSilenceTimer();
    },
  };
}
