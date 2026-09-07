import { execFile } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { config } from "../config.js";
import { classifySpool, splitSpoolIntoTickets } from "./spoolFile.js";
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
  onTicketText: (printerName: string, rawText: string) => void,
): Promise<SpoolCaptureResult> {
  const noop: SpoolCaptureResult = { handle: { close() {} }, printers: [] };

  if (process.platform !== "win32") {
    console.log("[spool] la captura de spool solo está disponible en Windows — omitida");
    return noop;
  }

  const printers = config.spoolPrinters.length > 0 ? config.spoolPrinters : await listLocalPrinters();
  if (printers.length === 0) {
    console.warn("[spool] no hay impresoras locales para vigilar — captura de spool inactiva");
    return noop;
  }

  if (config.spoolKeepPrintedJobs) await enableKeepPrintedJobs(printers);

  const processed = new Set<number>();
  const pending = new Map<number, NodeJS.Timeout>();
  let closed = false;

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

    const tickets = splitSpoolIntoTickets(content.toString("latin1"));
    for (const ticket of tickets) onTicketText(printer, ticket);
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
    return noop;
  }

  watcher.on("error", (err) => console.error("[spool] error del watcher:", err.message));

  console.log(`[spool] vigilando ${config.spoolDir} — ${printers.length} impresora(s): ${printers.join(", ")}`);

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
