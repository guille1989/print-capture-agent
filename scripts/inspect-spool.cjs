/*
 * Diagnóstico de captura de spool — VERSIÓN AUTOCONTENIDA (CommonJS).
 *
 * Un solo archivo, sin dependencias, sin npm install, sin TypeScript.
 * Pensado para correr en la PC del negocio usando el node.exe que ya trae
 * el instalador de InnoApp Agent.
 *
 * NO toca la cola local, la subida a la nube, ni el pipe del viewer. Solo
 * mira la carpeta de spool de Windows y, por cada trabajo de impresión,
 * guarda el .SPL crudo y dice si es capturable (RAW / ESC-POS) o gráfico
 * (EMF — necesitaría OCR).
 *
 * IMPORTANTE: la carpeta de spool no la puede leer un usuario común —
 * abrir PowerShell "como administrador".
 *
 * Uso (desde PowerShell admin, ajustá la ruta del usuario si hace falta):
 *
 *   & "C:\Users\Hewlett Packard\AppData\Local\InnoApp Agent\resources\agent\node.exe" `
 *     "$env:USERPROFILE\Desktop\inspect-spool.cjs" --printer "EPSON TM-T20II Receipt" --seconds 120
 *
 * Con el script corriendo, imprimí un ticket real desde el POS. Corta solo
 * al llegar a --seconds, o antes con Ctrl+C.
 *
 * Salida: una carpeta "inspect-spool-<fecha>" en el Escritorio con, por
 * cada trabajo: el .SPL crudo (.bin) y un .txt con hex dump, clasificación
 * y los tickets que saldrían. Restaura "conservar impresos" al salir.
 */
"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ---------- args ----------
function arg(name) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const ONLY_PRINTER = arg("printer");
const SECONDS = Number(arg("seconds") || 120);

const SPOOL_DIR = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "spool", "PRINTERS");
const SPL_RE = /^(\d{5})\.SPL$/i;
const OUT_DIR = path.join(
  os.homedir(),
  "Desktop",
  "inspect-spool-" + new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19),
);

// ---------- lógica pura (copiada de src/capture/spoolFile.ts) ----------
const CUT = "\x1dV"; // GS V

function isGraphicDatatype(dt) {
  if (!dt) return false;
  const n = String(dt).trim().toUpperCase();
  return ["EMF", "NT EMF", "XPS", "XPS_PASS", "XPS2GDI"].some((p) => n.startsWith(p));
}
function isRawDatatype(dt) {
  if (!dt) return false;
  return ["RAW", "RAW [FF APPENDED]", "RAW [FF AUTO]", "RAW [FF NONE]", "TEXT"].includes(String(dt).trim().toUpperCase());
}
function looksLikeEmf(head) {
  return head.subarray(0, 4096).includes(Buffer.from(" EMF", "latin1"));
}
function classifySpool(datatype, head) {
  if (isGraphicDatatype(datatype)) return { kind: "skip", reason: "datatype gráfico (" + String(datatype).trim() + ")" };
  if (looksLikeEmf(head)) return { kind: "skip", reason: "contenido EMF (documento gráfico, no ticket)" };
  if (datatype && !isRawDatatype(datatype)) return { kind: "skip", reason: "datatype no soportado (" + String(datatype).trim() + ")" };
  return { kind: "raw" };
}
function splitSpoolIntoTickets(content) {
  const out = [];
  let rest = content;
  let idx = rest.indexOf(CUT);
  while (idx !== -1) {
    out.push(rest.slice(0, idx + CUT.length));
    rest = rest.slice(idx + CUT.length);
    idx = rest.indexOf(CUT);
  }
  if (rest.length > 0) out.push(rest);
  return out.filter((t) => (t.match(/[\p{L}\p{N}]/gu) || []).length >= 3);
}

// ---------- powershell ----------
function ps(script) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 16 * 1024 * 1024,
    encoding: "utf8",
  }).trim();
}
function psJson(script) {
  const out = ps(script);
  if (!out) return [];
  const parsed = JSON.parse(out);
  return Array.isArray(parsed) ? parsed : [parsed];
}

function hexDump(buf) {
  const rows = [];
  const max = Math.min(buf.length, 2048);
  for (let o = 0; o < max; o += 16) {
    const s = buf.subarray(o, o + 16);
    const hex = Array.from(s, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(s, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    rows.push(o.toString(16).padStart(8, "0") + "  " + hex.padEnd(47) + "  " + ascii);
  }
  if (buf.length > 2048) rows.push("... (" + (buf.length - 2048) + " bytes más)");
  return rows.join("\n");
}

function jobMeta(jobId) {
  try {
    const rows = psJson("Get-CimInstance Win32_PrintJob | Select-Object JobId,Name,DataType,Document | ConvertTo-Json -Compress");
    for (const r of rows) {
      if (Number(r.JobId) !== jobId) continue;
      const name = typeof r.Name === "string" ? r.Name : "";
      return {
        printer: name.includes(",") ? name.slice(0, name.lastIndexOf(",")).trim() : name,
        datatype: r.DataType,
        document: r.Document,
      };
    }
  } catch (e) {
    /* el trabajo ya no está en la cola */
  }
  return {};
}

// ---------- main ----------
function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Chequeo de permisos temprano.
  try {
    fs.readdirSync(SPOOL_DIR);
  } catch (e) {
    if (e && (e.code === "EPERM" || e.code === "EACCES")) {
      console.error("\nSIN PERMISO para leer " + SPOOL_DIR);
      console.error("Abrí PowerShell haciendo clic derecho > 'Ejecutar como administrador' y volvé a correr esto.\n");
      process.exit(1);
    }
    throw e;
  }

  const filter = ONLY_PRINTER
    ? "Get-CimInstance Win32_Printer -Filter \"Name='" + ONLY_PRINTER.replace(/'/g, "''") + "'\""
    : "Get-CimInstance Win32_Printer | Where-Object { -not $_.Network }";

  let printers = [];
  try {
    printers = psJson(filter + " | Select-Object Name,KeepPrintedJobs | ConvertTo-Json -Compress").map((r) => ({
      name: r.Name,
      keep: !!r.KeepPrintedJobs,
    }));
  } catch (e) {
    console.error("No se pudieron enumerar impresoras:", e.message);
  }

  for (const p of printers) {
    if (p.keep) continue;
    try {
      ps(
        "$x = Get-CimInstance Win32_Printer -Filter \"Name='" +
          p.name.replace(/'/g, "''") +
          "'\"; $x.KeepPrintedJobs = $true; Set-CimInstance -InputObject $x",
      );
    } catch (e) {
      console.error('  (no se pudo activar "conservar impresos" en ' + p.name + ")");
    }
  }

  function restore() {
    for (const p of printers) {
      if (p.keep) continue;
      try {
        ps(
          "$x = Get-CimInstance Win32_Printer -Filter \"Name='" +
            p.name.replace(/'/g, "''") +
            "'\"; $x.KeepPrintedJobs = $false; Set-CimInstance -InputObject $x",
        );
      } catch (e) {
        /* nada */
      }
    }
  }

  console.log("Vigilando " + SPOOL_DIR);
  console.log("Impresoras: " + (printers.map((p) => p.name).join(", ") || "(ninguna)"));
  console.log("Salida en: " + OUT_DIR);
  console.log("Durante " + SECONDS + "s. Imprimí un ticket real desde el POS ahora. (Ctrl+C para cortar antes)\n");

  const seen = new Set();

  function handle(jobId) {
    if (seen.has(jobId)) return;
    seen.add(jobId);
    setTimeout(() => {
      const splPath = path.join(SPOOL_DIR, String(jobId).padStart(5, "0") + ".SPL");
      let content;
      try {
        content = fs.readFileSync(splPath);
      } catch (e) {
        console.error("[job " + jobId + "] no se pudo leer " + splPath + ": " + e.message);
        return;
      }
      const meta = jobMeta(jobId);
      const decision = classifySpool(meta.datatype, content.subarray(0, 4096));
      const tickets = decision.kind === "raw" ? splitSpoolIntoTickets(content.toString("latin1")) : [];

      const base = "job" + jobId;
      fs.writeFileSync(path.join(OUT_DIR, base + ".bin"), content);
      fs.writeFileSync(
        path.join(OUT_DIR, base + ".txt"),
        [
          "job id:     " + jobId,
          "impresora:  " + (meta.printer || "(desconocida)"),
          "documento:  " + (meta.document || "(desconocido)"),
          "datatype:   " + (meta.datatype || "(no disponible - trabajo ya fuera de la cola)"),
          "tamaño:     " + content.length + " bytes",
          "decisión:   " + (decision.kind === "raw" ? "CAPTURABLE (RAW / ESC-POS)" : "IGNORAR - " + decision.reason),
          "tickets:    " + tickets.length,
          "",
          "=== hex dump (primeros 2 KB) ===",
          hexDump(content),
          "",
        ]
          .concat(tickets.flatMap((t, i) => ["=== ticket " + (i + 1) + " (latin1) ===", JSON.stringify(t), ""]))
          .join("\n"),
      );

      console.log(
        "[job " +
          jobId +
          "] " +
          (meta.printer || "?") +
          " · " +
          content.length +
          " bytes · " +
          (decision.kind === "raw" ? "RAW -> " + tickets.length + " ticket(s)" : "IGNORADO (" + decision.reason + ")") +
          " · guardado " +
          base +
          ".*",
      );
    }, 1200);
  }

  const watcher = fs.watch(SPOOL_DIR, (_e, filename) => {
    const m = filename && String(filename).match(SPL_RE);
    if (m) handle(Number(m[1]));
  });
  watcher.on("error", (err) => console.error("watcher:", err.message));

  function finish() {
    watcher.close();
    restore();
    console.log("\nListo. " + seen.size + " trabajo(s) visto(s). Revisá la carpeta:\n  " + OUT_DIR);
    process.exit(0);
  }
  process.on("SIGINT", finish);
  setTimeout(finish, SECONDS * 1000);
}

main();
