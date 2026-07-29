/**
 * Contrato común para cualquier mecanismo de captura (serie, TCP, y lo que
 * haga falta después) — así el resto del agente no necesita saber cómo
 * llegan los bytes, solo que en algún momento onData() trae texto crudo.
 */
export interface CaptureHandle {
  close(): void;
}
