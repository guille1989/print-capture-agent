import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { CaptureHandle } from "./types.js";

/**
 * Captura de facturas electrónicas (XML UBL de la DIAN) desde una carpeta, para
 * los negocios cuyo ERP las deja ahí en vez de imprimir un ticket (caso Alamo,
 * UNO/Siesa). Es un sondeo y no `fs.watch`: los eventos de una carpeta de red
 * (SMB) se pierden o no llegan, y un `readdir` cada pocos segundos es barato.
 *
 * No interpreta montos — igual que el resto del agente solo captura y sube; el
 * parseo vive en la nube. Lo único que mira es lo mínimo para NO subir lo que
 * no es una venta (compras, notas, XML ajenos), que además deja fuera datos de
 * terceros que el negocio no necesita en la nube.
 */

/**
 * `InvoiceTypeCode` de las facturas de venta (01 venta, 02 exportación, 03 y 04
 * contingencia). Debe coincidir con `SALE_TYPE_CODES` de
 * `ticket-parsing-cloud/src/parsing/ubl.ts`, que vuelve a validarlo del lado de
 * la nube. El 05 es documento soporte: una compra, no un ingreso.
 */
const SALE_TYPE_CODES = new Set(["01", "02", "03", "04"]);

/**
 * El ERP escribe el archivo en el momento de facturar y lo puede reescribir al
 * firmarlo; no se lee hasta que lleve este rato sin tocarse.
 */
const DEFAULT_SETTLE_MS = 3_000;
/** Intentos con un archivo a medio escribir antes de darlo por inservible. */
const MAX_INCOMPLETE_ATTEMPTS = 20;

export type InvoiceVerdict = { kind: "sale" } | { kind: "ignore"; reason: string } | { kind: "incomplete" };

/**
 * Decide, con regex sobre el texto (latin1: los bytes se preservan 1:1 y los
 * nombres de etiqueta son ASCII), si un XML es una factura de venta completa.
 */
export function classifyInvoiceXml(text: string): InvoiceVerdict {
  const root = /<(?![?!])\s*(?:[\w.-]+:)?([\w.-]+)/.exec(text)?.[1];
  if (!root) return { kind: "incomplete" };
  if (root !== "Invoice") return { kind: "ignore", reason: `no es una factura (raíz <${root}>)` };
  if (!/<\/(?:[\w.-]+:)?Invoice\s*>\s*$/.test(text)) return { kind: "incomplete" };

  const typeCode = /<(?:[\w.-]+:)?InvoiceTypeCode\b[^>]*>\s*(\d+)\s*</.exec(text)?.[1];
  if (!typeCode || !SALE_TYPE_CODES.has(typeCode)) {
    return { kind: "ignore", reason: `no es una venta (InvoiceTypeCode ${typeCode ?? "ausente"})` };
  }
  return { kind: "sale" };
}

/**
 * Quita los bloques `<cac:Contact>` (teléfono y correo del cliente): son datos
 * personales que el análisis de ventas no usa. El resto del documento — y sus
 * bytes — queda igual.
 */
export function stripContactBlocks(text: string): string {
  return text.replace(/<((?:[\w.-]+:)?)Contact\b[^>]*>[\s\S]*?<\/\1Contact\s*>/g, "");
}

interface FolderState {
  version: 1;
  folders: Record<string, { known: string[] }>;
}

async function loadState(file: string): Promise<FolderState> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf-8")) as Partial<FolderState>;
    if (parsed.version === 1 && parsed.folders && typeof parsed.folders === "object") return parsed as FolderState;
  } catch {
    // Sin archivo (primera corrida) o ilegible: se arranca de cero.
  }
  return { version: 1, folders: {} };
}

async function saveState(file: string, state: FolderState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(state), "utf-8");
  await rename(tmp, file);
}

export interface FolderCaptureOptions {
  dir: string;
  /** Nombre con el que la nube y el visor identifican la fuente. */
  port: string;
  stateFile: string;
  /** Ver `config.folderBackfillSinceMs`. */
  backfillSinceMs?: number;
  settleMs?: number;
  /** `rawBase64` es el XML (sin los bloques de contacto) y `capturedAt` la fecha de modificación del archivo. */
  onInvoice: (port: string, rawBase64: string, capturedAt: string) => void;
}

export interface FolderPoller {
  pollOnce(): Promise<void>;
}

/** La lógica de un sondeo, separada del temporizador para poder probarla. */
export function createFolderPoller(options: FolderCaptureOptions): FolderPoller {
  const { dir, port, stateFile, backfillSinceMs, onInvoice } = options;
  const settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
  const incompleteAttempts = new Map<string, number>();
  const warned = new Set<string>();
  let state: FolderState | undefined;

  function warnOnce(key: string, message: string): void {
    if (warned.has(key)) return;
    warned.add(key);
    console.warn(message);
  }

  async function pollOnce(): Promise<void> {
    let names: string[];
    try {
      names = (await readdir(dir)).filter((name) => /\.xml$/i.test(name)).sort();
    } catch (err) {
      // Una carpeta de red que no responde no es motivo para tirar nada abajo:
      // se reintenta en el próximo sondeo.
      warnOnce(`readdir:${(err as NodeJS.ErrnoException).code}`, `[folder] no se pudo leer ${dir}: ${err instanceof Error ? err.message : err}`);
      return;
    }

    state ??= await loadState(stateFile);
    const isFirstRun = state.folders[dir] === undefined;
    const known = new Set(state.folders[dir]?.known ?? []);

    if (isFirstRun) {
      // Lo que ya hay es historia: se marca como visto sin subirlo, salvo lo que
      // el operador pidió recuperar con `FOLDER_BACKFILL_SINCE`.
      let skipped = 0;
      for (const name of names) {
        const keep =
          backfillSinceMs !== undefined && (await stat(path.join(dir, name)).then((s) => s.mtimeMs >= backfillSinceMs, () => false));
        if (!keep) {
          known.add(name);
          skipped++;
        }
      }
      console.log(
        `[folder] ${dir}: primera vigilancia — ${skipped} archivo(s) existente(s) tomados como historial` +
          (backfillSinceMs !== undefined ? `, ${names.length - skipped} reciente(s) a subir` : ""),
      );
      state.folders[dir] = { known: [...known] };
      await saveState(stateFile, state);
    }

    let changed = false;
    for (const name of names) {
      if (known.has(name)) continue;
      const file = path.join(dir, name);
      try {
        const info = await stat(file);
        if (settleMs > 0 && Date.now() - info.mtimeMs < settleMs) continue; // puede estar escribiéndose todavía

        const text = (await readFile(file)).toString("latin1");
        const verdict = classifyInvoiceXml(text);

        if (verdict.kind === "incomplete") {
          const attempts = (incompleteAttempts.get(name) ?? 0) + 1;
          incompleteAttempts.set(name, attempts);
          if (attempts < MAX_INCOMPLETE_ATTEMPTS) continue;
          console.warn(`[folder] ${name}: sigue incompleto tras ${attempts} intentos, se descarta`);
        } else if (verdict.kind === "ignore") {
          console.log(`[folder] ${name} ignorado: ${verdict.reason}`);
        } else {
          onInvoice(port, Buffer.from(stripContactBlocks(text), "latin1").toString("base64"), info.mtime.toISOString());
          console.log(`[folder] ${name}: factura capturada`);
        }
        known.add(name);
        changed = true;
      } catch (err) {
        // Archivo bloqueado por el ERP, permisos, red intermitente: se reintenta.
        warnOnce(`${name}:${(err as NodeJS.ErrnoException).code}`, `[folder] no se pudo leer ${name}: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (changed) {
      state.folders[dir] = { known: [...known] };
      await saveState(stateFile, state);
    }
  }

  return { pollOnce };
}

/**
 * Sondea la carpeta cada `pollMs`. Igual que el resto de los bucles del agente,
 * recién programa la vuelta siguiente cuando termina la actual, así dos
 * sondeos nunca se solapan aunque la red tarde.
 */
export function startFolderCapture(options: FolderCaptureOptions & { pollMs: number }): CaptureHandle {
  if (!existsSync(options.dir)) {
    console.warn(`[folder] ${options.dir} no existe o no es accesible desde este proceso — se reintenta en cada sondeo`);
  }
  const poller = createFolderPoller(options);
  let closed = false;
  let timer: NodeJS.Timeout | undefined;

  const schedule = (): void => {
    if (closed) return;
    timer = setTimeout(() => {
      poller
        .pollOnce()
        .catch((err) => console.error(`[folder] error inesperado vigilando ${options.dir}:`, err))
        .finally(schedule);
    }, options.pollMs);
  };

  // El primer sondeo es inmediato; el resto, por temporizador.
  poller
    .pollOnce()
    .catch((err) => console.error(`[folder] error inesperado vigilando ${options.dir}:`, err))
    .finally(schedule);

  return {
    close() {
      closed = true;
      if (timer) clearTimeout(timer);
    },
  };
}
