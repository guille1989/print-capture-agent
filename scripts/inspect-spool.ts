// Herramienta de diagnóstico standalone — NO toca la cola local, la subida
// a la nube, ni el pipe del viewer. Vigila la carpeta de spool de Windows y,
// por cada trabajo de impresión, guarda el `.SPL` crudo y dice si es
// capturable (RAW / ESC/POS) o gráfico (EMF, necesita OCR). Sirve para
// validar en la PC real del negocio que la captura de spool va a funcionar,
// antes de confiar en ella.
//
// IMPORTANTE: la carpeta de spool no la puede leer un usuario común —
// abrir esta consola "como administrador".
//
// Uso:
//   npx tsx scripts/inspect-spool.ts [--printer "EPSON TM-T20II Receipt"] [--seconds 120]
//
// Con el script corriendo, imprimir un ticket real desde el POS. Corta solo
// al llegar a --seconds, o antes con Ctrl+C.
//
// Salida en data/captures/:
//   spool-<timestamp>-<job>.bin   bytes exactos del `.SPL`
//   spool-<timestamp>-<job>.txt   hex dump + clasificación + tickets que saldrían
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { classifySpool, splitSpoolIntoTickets } from "../src/capture/spoolFile.js";

const execFileAsync = promisify(execFile);

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const SPOOL_DIR = `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\spool\\PRINTERS`;
const OUT_DIR = "data/captures";
const SPL_RE = /^(\d{5})\.SPL$/i;

async function ps(script: string): Promise<string> {
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 10_000,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout.trim();
}

function hexDump(buf: Buffer): string {
  const rows: string[] = [];
  for (let offset = 0; offset < Math.min(buf.length, 2048); offset += 16) {
    const slice = buf.subarray(offset, offset + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  if (buf.length > 2048) rows.push(`... (${buf.length - 2048} bytes más)`);
  return rows.join("\n");
}

async function jobMeta(jobId: number): Promise<{ printer?: string; datatype?: string; document?: string }> {
  try {
    const rows = JSON.parse(
      (await ps("Get-CimInstance Win32_PrintJob | Select-Object JobId,Name,DataType,Document | ConvertTo-Json -Compress")) || "[]",
    );
    for (const row of Array.isArray(rows) ? rows : [rows]) {
      if (Number(row.JobId) !== jobId) continue;
      const name: string = typeof row.Name === "string" ? row.Name : "";
      return {
        printer: name.includes(",") ? name.slice(0, name.lastIndexOf(",")).trim() : name,
        datatype: row.DataType,
        document: row.Document,
      };
    }
  } catch {
    /* el trabajo ya no está en la cola */
  }
  return {};
}

async function main(): Promise<void> {
  const onlyPrinter = arg("printer");
  const seconds = Number(arg("seconds") ?? 120);
  await mkdir(OUT_DIR, { recursive: true });

  // Guarda el estado de "conservar impresos" para restaurarlo al salir.
  const printersScript = onlyPrinter
    ? `Get-CimInstance Win32_Printer -Filter "Name='${onlyPrinter.replace(/'/g, "''")}'"`
    : "Get-CimInstance Win32_Printer | Where-Object { -not $_.Network }";
  const printers: Array<{ Name: string; KeepPrintedJobs: boolean }> = [];
  try {
    const rows = JSON.parse((await ps(`${printersScript} | Select-Object Name,KeepPrintedJobs | ConvertTo-Json -Compress`)) || "[]");
    for (const r of Array.isArray(rows) ? rows : [rows]) printers.push({ Name: r.Name, KeepPrintedJobs: !!r.KeepPrintedJobs });
  } catch (err) {
    console.error("No se pudieron enumerar impresoras (¿consola sin privilegios de admin?):", err);
  }

  for (const p of printers) {
    if (p.KeepPrintedJobs) continue;
    await ps(
      `$x = Get-CimInstance Win32_Printer -Filter "Name='${p.Name.replace(/'/g, "''")}'"; $x.KeepPrintedJobs = $true; Set-CimInstance -InputObject $x`,
    ).catch(() => console.error(`  (no se pudo activar "conservar impresos" en ${p.Name})`));
  }

  const restore = async (): Promise<void> => {
    for (const p of printers) {
      if (p.KeepPrintedJobs) continue; // ya estaba activo, se deja como estaba
      await ps(
        `$x = Get-CimInstance Win32_Printer -Filter "Name='${p.Name.replace(/'/g, "''")}'"; $x.KeepPrintedJobs = $false; Set-CimInstance -InputObject $x`,
      ).catch(() => {});
    }
  };

  console.log(`Vigilando ${SPOOL_DIR}`);
  console.log(`Impresoras: ${printers.map((p) => p.Name).join(", ") || "(ninguna)"}`);
  console.log(`Durante ${seconds}s. Imprimí un ticket real desde el POS ahora. (Ctrl+C para cortar antes)\n`);

  const seen = new Set<number>();

  const handle = async (jobId: number): Promise<void> => {
    if (seen.has(jobId)) return;
    seen.add(jobId);
    await new Promise((r) => setTimeout(r, 1000)); // que termine de escribirse

    const splPath = path.join(SPOOL_DIR, `${String(jobId).padStart(5, "0")}.SPL`);
    let content: Buffer;
    try {
      content = await readFile(splPath);
    } catch (err) {
      console.error(`[job ${jobId}] no se pudo leer ${splPath}:`, (err as Error).message);
      return;
    }

    const meta = await jobMeta(jobId);
    const decision = classifySpool({ datatype: meta.datatype, head: content.subarray(0, 4096) });
    const tickets = decision.kind === "raw" ? splitSpoolIntoTickets(content.toString("latin1")) : [];

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const base = `spool-${stamp}-job${jobId}`;
    await writeFile(path.join(OUT_DIR, `${base}.bin`), content);
    await writeFile(
      path.join(OUT_DIR, `${base}.txt`),
      [
        `job id:     ${jobId}`,
        `impresora:  ${meta.printer ?? "(desconocida)"}`,
        `documento:  ${meta.document ?? "(desconocido)"}`,
        `datatype:   ${meta.datatype ?? "(no disponible — trabajo ya fuera de la cola)"}`,
        `tamaño:     ${content.length} bytes`,
        `decisión:   ${decision.kind === "raw" ? "CAPTURABLE (RAW / ESC-POS)" : `IGNORAR — ${decision.reason}`}`,
        `tickets:    ${tickets.length}`,
        "",
        "=== hex dump (primeros 2 KB) ===",
        hexDump(content),
        "",
        ...tickets.flatMap((t, i) => [`=== ticket ${i + 1} (latin1) ===`, JSON.stringify(t), ""]),
      ].join("\n"),
    );

    console.log(
      `[job ${jobId}] ${meta.printer ?? "?"} · ${content.length} bytes · ` +
        `${decision.kind === "raw" ? `RAW → ${tickets.length} ticket(s)` : `IGNORADO (${decision.reason})`} · guardado ${base}.*`,
    );
  };

  const watcher = watch(SPOOL_DIR, (_e, filename) => {
    const m = filename && String(filename).match(SPL_RE);
    if (m) void handle(Number(m[1]));
  });
  watcher.on("error", (err) => console.error("watcher:", err.message));

  const finish = async (): Promise<void> => {
    watcher.close();
    await restore();
    console.log(`\nListo. ${seen.size} trabajo(s) visto(s). Revisá ${OUT_DIR}/spool-*.txt`);
    process.exit(0);
  };
  process.on("SIGINT", () => void finish());
  setTimeout(() => void finish(), seconds * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
