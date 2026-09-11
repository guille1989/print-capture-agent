export type FailureClass = "transient" | "delayed" | "permanent";

/**
 * - `transient`: red caída/DNS/timeout (sin `status`), 5xx, 408, 429 —
 *   reintentar rápido.
 * - `delayed`: **403**. Es ambiguo en API Gateway: una API key recién
 *   creada (agente recién activado) tarda minutos en propagar y devuelve
 *   403 mientras tanto; también lo devuelve una key deshabilitada. Se
 *   reintenta con un backoff medio — así el primer ticket de un agente
 *   recién activado sube apenas propaga la key, sin machacar cada 15s si
 *   la key de verdad quedó mal.
 * - `permanent`: el resto de los 4xx (400 payload rechazado, 404, 422…) —
 *   no cambia reintentando; backoff largo pero sin descartar el ticket.
 */
export function classifyFailure(status: number | undefined): FailureClass {
  if (status === undefined) return "transient";
  if (status === 408 || status === 429) return "transient";
  if (status === 403) return "delayed";
  if (status >= 400 && status < 500) return "permanent";
  return "transient";
}

const TRANSIENT_MAX_MS = 5 * 60 * 1000;
const DELAYED_BASE_MS = 60 * 1000;
const DELAYED_MAX_MS = 15 * 60 * 1000;
const PERMANENT_BASE_MS = 5 * 60 * 1000;
const PERMANENT_MAX_MS = 60 * 60 * 1000;
const MAX_EXPONENT = 10;
const JITTER_MIN = 0.8;
const JITTER_SPREAD = 0.4;

/**
 * Exponencial con jitter (±20%) — así muchos tickets fallando a la vez
 * (ej. se cayó internet) no reintentan todos en el mismo segundo exacto.
 *
 * Los errores permanentes arrancan en una base mucho más alta y llegan a
 * un techo de una hora: no tiene sentido machacar cada 15s un endpoint
 * que ya rechazó el pedido con un 403 (API key inválida) o un 400
 * (payload rechazado) — pero tampoco se descarta el ticket, para no
 * perder una venta si alguien corrige la config más tarde.
 */
export function computeBackoffMs(attempts: number, kind: FailureClass, baseMs: number): number {
  const base = kind === "permanent" ? PERMANENT_BASE_MS : kind === "delayed" ? DELAYED_BASE_MS : baseMs;
  const cap = kind === "permanent" ? PERMANENT_MAX_MS : kind === "delayed" ? DELAYED_MAX_MS : TRANSIENT_MAX_MS;
  const exponent = Math.min(Math.max(attempts - 1, 0), MAX_EXPONENT);
  const raw = Math.min(base * 2 ** exponent, cap);
  const jitter = JITTER_MIN + Math.random() * JITTER_SPREAD;
  return Math.round(raw * jitter);
}
