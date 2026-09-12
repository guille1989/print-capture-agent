import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../config.js";
import { classifySpool, splitEscpos } from "./spoolFile.js";
import type { CaptureHandle } from "./types.js";

const execFileAsync = promisify(execFile);

/** `NNNNN.SPL` — el número es el job id global del spooler. */
const SPL_FILE_RE = /^(\d{5})\.SPL$/i;

/**
 * Cuánto esperar desde que aparece el `.SPL` hasta leerlo: el spooler
 * escribe el archivo entero antes de despachar a la impresora, pero la
 * escritura no es atómica. Con "conservar documentos impresos" activado no
 * hay apuro (el trabajo no se borra), así que se puede ser generoso.
 */
const SETTLE_MS = 1000;
const POWERSHELL_TIMEOUT_MS = 10_000;
/** Cuántos bytes del arranque alcanzan para detectar un `.SPL` gráfico. */
const HEAD_BYTES = 4096;
/**
 * Cada cuánto se vuelve a preguntar por WMI qué impresoras hay, mientras el
 * agente auto-detecta (no aplica si `SPOOL_PRINTERS` fija la lista a mano).
 * Sin este reintento periódico, una impresora que todavía no esté lista
 * para Windows justo cuando arranca el agente (ej. PC recién prendido, la
 * térmica tarda un poco más en enumerar por USB) lo deja ciego para
 * siempre — pasó en la práctica en el piloto de Empanadas Típicas: el
 * agente arrancó con 0 impresoras detectadas y se quedó así ~7 horas hasta
 * que alguien reinició el servicio a mano.
 */
const PRINTER_RESCAN_MS = 60_000;

interface JobMeta {
  printer: string;
  datatype?: string;
  document?: string;
}

interface SpoolCaptureResult {
  handle: CaptureHandle;
  /** Impresoras que se están vigilando — el agente las reporta como "puertos" al viewer. */
  printers: string[];
}

const VIRTUAL_PRINTER_HINTS = [
  "microsoft print to pdf",
  "microsoft xps document writer",
  "onenote",
  "fax",
  "adobe pdf",
  "pdf24",
  "bullzip",
  "pdfcreator",
];
const VIRTUAL_PORT_RE = /^(nul:|portprompt:|file:|xpsport:|onenote|nul\b)/i;

async function runPowershell(script: string): Promise<string> {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: POWERSHELL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function parseJsonRows(stdout: string): Array<Record<string, unknown>> {
  if (!stdout) return [];
  const parsed = JSON.parse(stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Enumera las impresoras locales (no las conexiones a `\\servidor\cola`), descartando las virtuales conocidas. */
async function listLocalPrinters(): Promise<string[]> {
  const script =
    "Get-CimInstance Win32_Printer | Where-Object { -not $_.Network } | " +
    "Select-Object Name,PortName | ConvertTo-Json -Compress";
  try {
    const rows = parseJsonRows(await runPowershell(script));
    return rows
      .map((row) => ({ name: String(row.Name ?? ""), port: String(row.PortName ?? "") }))
      .filter(({ name, port }) => {
        if (!name) return false;
        if (VIRTUAL_PRINTER_HINTS.some((hint) => name.toLowerCase().includes(hint))) return false;
        if (VIRTUAL_PORT_RE.test(port)) return false;
        return true;
      })
      .map(({ name }) => name);
  } catch (err) {
    console.error("[spool] no se pudieron enumerar las impresoras:", err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * Activa "conservar documentos impresos" en las impresoras vigiladas. Sin
 * esto el spooler borra el `.SPL` apenas termina de imprimir (1-2 s en una
 * térmica) y se pierde la carrera para leerlo. Es reversible y de bajo
 * riesgo; el único costo es que la carpeta de spool crece — por eso el
 * agente borra cada trabajo después de procesarlo (`removeJob`).
 */
async function enableKeepPrintedJobs(printers: string[]): Promise<void> {
  for (const name of printers) {
    const safe = name.replace(/'/g, "''");
    const script =
      `$p = Get-CimInstance Win32_Printer -Filter "Name='${safe}'"; ` +
      `if ($p -and -not $p.KeepPrintedJobs) { $p.KeepPrintedJobs = $true; Set-CimInstance -InputObject $p }`;
    try {
      await runPowershell(script);
    } catch (err) {
      console.error(`[spool] no se pudo activar "conservar impresos" en ${name}:`, err instanceof Error ? err.message : err);
    }
  }
}

async function fetchJobMeta(jobId: number): Promise<JobMeta | undefined> {
  const script =
    "Get-CimInstance Win32_PrintJob | Select-Object JobId,Name,DataType,Document | ConvertTo-Json -Compress";
  try {
    for (const row of parseJsonRows(await runPowershell(script))) {
      if (Number(row.JobId) !== jobId) continue;
      // `Name` viene como "NombreImpresora, 42".
      const rawName = typeof row.Name === "string" ? row.Name : "";
      const printer = rawName.includes(",") ? rawName.slice(0, rawName.lastIndexOf(",")).trim() : rawName.trim();
      return {
        printer: printer || "spool",
        datatype: typeof row.DataType === "string" ? row.DataType : undefined,
        document: typeof row.Document === "string" ? row.Document : undefined,
      };
    }
  } catch (err) {
    console.error(`[spool] no se pudo consultar el trabajo ${jobId}:`, err instanceof Error ? err.message : err);
  }
  return undefined;
}

async function removeJob(printer: string, jobId: number): Promise<void> {
  if (!config.spoolKeepPrintedJobs) return; // no hay nada retenido que borrar
  const safe = printer.replace(/'/g, "''");
  try {
    await runPowershell(`Remove-PrintJob -PrinterName '${safe}' -ID ${jobId} -ErrorAction SilentlyContinue`);
  } catch {
    // Si no se pudo borrar, el Set de vistos evita reprocesarlo mientras el agente siga vivo.
  }
}

/**
 * Se conecta al spooler de Windows: vigila `spool\PRINTERS`, y por cada
 * `.SPL` nuevo con datatype RAW extrae el texto del ticket y lo entrega por
 * `onTicketText`. Los `.SPL` gráficos (EMF/XPS — documentos de oficina) se
 * ignoran. Es el mecanismo de captura general: no depende de cómo esté
 * conectada la impresora (USB, serie, red), solo de que use una cola de
 * Windows. La captura serie/TCP queda como fallback para las POS que mandan
 * ESC/POS crudo a un puerto salteando el spooler.
 *
 * Requiere permiso de lectura sobre `spool\PRINTERS`, que por ACL default
 * un usuario común NO tiene — el agente necesita correr elevado o como
 * servicio bajo LocalSystem (ver PROYECTO.md sección 8).
 */
export async function startSpoolCapture(
  /**
   * `rawBase64` son los bytes ESC/POS crudos de un ticket, en base64. Se
   * suben sin interpretar — la nube decide si son texto o una imagen raster
   * a la que hay que hacerle OCR (Loggro y varios POS imprimen el ticket
   * entero como bitmap).
   */
  onTicket: (printerName: string, rawBase64: string) => void,
  /**
   * Se llama cada vez que cambia la lista de impresoras detectadas (al
   * arrancar, y después en cada `PRINTER_RESCAN_MS` si cambió algo) — así
   * quien reporta el estado al viewer no se queda con la foto del arranque.
   */
  onPrintersChanged: (printers: string[]) => void = () => {},
): Promise<SpoolCaptureResult> {
  const noop: SpoolCaptureResult = { handle: { close() {} }, printers: [] };

  if (process.platform !== "win32") {
    console.log("[spool] la captura de spool solo está disponible en Windows — omitida");
    return noop;
  }

  const manualPrinters = config.spoolPrinters;
  let printers: string[] = manualPrinters;
  let closed = false;

  /**
   * Detecta impresoras por WMI y activa "conservar impresos" en las que
   * sean nuevas. Se llama una vez antes de arrancar y después
   * periódicamente — nunca se da por vencida ni deja de intentarlo, y
   * siempre deja algo en el log (antes, 0 impresoras detectadas al
   * arrancar significaba quedar ciego en silencio, sin ningún error).
   */
  async function rescanPrinters(): Promise<void> {
    if (manualPrinters.length > 0) return; // lista fija a mano, no autodetectar

    const found = await listLocalPrinters();
    const isNew = found.filter((name) => !printers.includes(name));

    if (found.length === 0) {
      console.warn("[spool] no se detecta ninguna impresora local — reintentando en 60s");
      if (printers.length > 0) {
        printers = [];
        onPrintersChanged(printers);
      }
      return;
    }

    if (isNew.length > 0) {
      if (config.spoolKeepPrintedJobs) await enableKeepPrintedJobs(isNew);
      console.log(`[spool] impresora(s) detectada(s): ${isNew.join(", ")}`);
    }
    if (found.length !== printers.length || isNew.length > 0) {
      printers = found;
      onPrintersChanged(printers);
    }
  }

  function schedulePrinterRescan(): void {
    setTimeout(() => {
      if (closed) return;
      rescanPrinters()
        .catch((err) => console.error("[spool] error redetectando impresoras:", err instanceof Error ? err.message : err))
        .finally(schedulePrinterRescan);
    }, PRINTER_RESCAN_MS);
  }

  if (manualPrinters.length > 0 && config.spoolKeepPrintedJobs) {
    await enableKeepPrintedJobs(manualPrinters);
  } else {
    await rescanPrinters();
  }
  schedulePrinterRescan();

  // A diferencia de antes, no nos quedamos sin arrancar el watcher solo
  // porque todavía no se detectó ninguna impresora — la carpeta de spool se
  // vigila entera (no por impresora puntual), así que un trabajo real
  // igual se captura aunque `printers` esté vacío en este instante; lo
  // único que se pierde mientras tanto es "conservar impresos" en una
  // impresora que WMI no ve todavía, y eso se corrige solo en el próximo
  // `rescanPrinters()`.

  const processed = new Set<number>();
  const pending = new Map<number, NodeJS.Timeout>();

  async function processJob(jobId: number): Promise<void> {
    if (closed || processed.has(jobId)) return;

    const splPath = path.join(config.spoolDir, `${String(jobId).padStart(5, "0")}.SPL`);
    let content: Buffer;
    try {
      content = await readFile(splPath);
    } catch {
      // El `.SPL` ya no está: sin "conservar impresos" el spooler lo borró
      // antes de que llegáramos. No se marca como procesado por si reaparece.
      return;
    }
    processed.add(jobId);

    const meta = await fetchJobMeta(jobId);
    const printer = meta?.printer ?? "spool";

    if (config.spoolPrinters.length > 0 && !config.spoolPrinters.includes(printer)) {
      await removeJob(printer, jobId);
      return;
    }

    const decision = classifySpool({ datatype: meta?.datatype, head: content.subarray(0, HEAD_BYTES) });
    if (decision.kind === "skip") {
      console.log(`[spool] trabajo ${jobId} (${printer}) ignorado: ${decision.reason}`);
      await removeJob(printer, jobId);
      return;
    }

    // Cota de tamaño: un ticket con logo pesa ~200 KB; algo mucho más grande
    // es una impresión que no es un ticket (una foto, un PDF de varias
    // páginas). Subirlo igual chocaría contra el límite del `ingest`.
    if (content.length > config.spoolMaxJobBytes) {
      console.warn(
        `[spool] trabajo ${jobId} (${printer}) ignorado: ${content.length} bytes supera el máximo (${config.spoolMaxJobBytes})`,
      );
      await removeJob(printer, jobId);
      return;
    }

    const tickets = splitEscpos(content);
    for (const ticket of tickets) onTicket(printer, ticket.toString("base64"));
    console.log(
      tickets.length > 0
        ? `[spool] trabajo ${jobId} (${printer}): ${tickets.length} ticket(s) capturado(s), ${content.length} bytes`
        : `[spool] trabajo ${jobId} (${printer}): RAW pero sin contenido de ticket reconocible (${content.length} bytes)`,
    );

    await removeJob(printer, jobId);
  }

  function schedule(jobId: number): void {
    if (closed || processed.has(jobId)) return;
    const existing = pending.get(jobId);
    if (existing) clearTimeout(existing);
    pending.set(
      jobId,
      setTimeout(() => {
        pending.delete(jobId);
        void processJob(jobId).catch((err) =>
          console.error(`[spool] error procesando el trabajo ${jobId}:`, err instanceof Error ? err.message : err),
        );
      }, SETTLE_MS),
    );
  }

  // Trabajos que ya estaban en la carpeta (retenidos de una corrida
  // anterior del agente, o impresos mientras estaba caído).
  try {
    for (const entry of await readdir(config.spoolDir)) {
      const match = entry.match(SPL_FILE_RE);
      if (match) schedule(Number(match[1]));
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      console.error(
        `[spool] sin permiso para leer ${config.spoolDir} — el agente tiene que correr como administrador o servicio (LocalSystem). Captura de spool inactiva.`,
      );
      closed = true; // corta el reintento de impresoras: sin acceso a la carpeta no hay nada que vigilar
      return noop;
    }
    console.error("[spool] no se pudo listar la carpeta de spool:", err instanceof Error ? err.message : err);
  }

  let watcher: FSWatcher;
  try {
    watcher = watch(config.spoolDir, (_event, filename) => {
      if (!filename) return;
      const match = String(filename).match(SPL_FILE_RE);
      if (match) schedule(Number(match[1]));
    });
  } catch (err) {
    console.error("[spool] no se pudo vigilar la carpeta de spool:", err instanceof Error ? err.message : err);
    closed = true;
    return noop;
  }

  watcher.on("error", (err) => console.error("[spool] error del watcher:", err.message));

  console.log(
    printers.length > 0
      ? `[spool] vigilando ${config.spoolDir} — ${printers.length} impresora(s): ${printers.join(", ")}`
      : `[spool] vigilando ${config.spoolDir} — ninguna impresora detectada todavía (reintentando en segundo plano)`,
  );

  return {
    handle: {
      close() {
        closed = true;
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear();
        watcher.close();
      },
    },
    printers,
  };
}
