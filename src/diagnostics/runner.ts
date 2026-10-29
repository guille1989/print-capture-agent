import { spawn } from "node:child_process";

import { DIAGNOSTIC_SCRIPTS } from "./catalog.js";

export interface DiagnosticResult {
  exitCode: number;
  durationMs: number;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  /** Datos que el script lee de `$env:INNO_*` — nunca se interpolan en el código. */
  env: Record<string, string>;
  timeoutMs: number;
  maxOutputChars: number;
  /** Para tests; por defecto `powershell.exe`. */
  shell?: string;
}

// Última línea de defensa: aunque ningún script debería imprimir credenciales,
// un log podría traer una api-key (de API Gateway: 20+ caracteres alfanuméricos).
const SECRET_PATTERN = /(api[-_ ]?key["'\s:=]+)[A-Za-z0-9]{16,}/gi;

export function redact(text: string): string {
  return text.replace(SECRET_PATTERN, "$1[redactado]");
}

/** `Format-Table`/`Format-List` dejan 2-3 líneas en blanco seguidas; con una alcanza para leer. */
export function tidy(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n[...salida recortada a ${max} caracteres]` : text;
}

/**
 * `-EncodedCommand` (UTF-16LE en base64) evita todo problema de comillas, y
 * fuerza UTF-8 en la salida para que los acentos lleguen bien a la nube.
 */
export function encodeScript(script: string): string {
  const prelude = "$ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [System.Text.Encoding]::UTF8;\n";
  return Buffer.from(prelude + script, "utf16le").toString("base64");
}

export function isKnownScript(scriptId: string): boolean {
  return Object.prototype.hasOwnProperty.call(DIAGNOSTIC_SCRIPTS, scriptId);
}

export function runDiagnostic(scriptId: string, options: RunOptions): Promise<DiagnosticResult> {
  const started = Date.now();
  if (!isKnownScript(scriptId)) {
    return Promise.resolve({
      exitCode: -1,
      durationMs: 0,
      timedOut: false,
      stdout: "",
      stderr: `Diagnóstico "${scriptId}" desconocido para esta versión del agente`,
    });
  }

  return new Promise((resolve) => {
    const child = spawn(
      options.shell ?? "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encodeScript(DIAGNOSTIC_SCRIPTS[scriptId])],
      { env: { ...process.env, ...options.env }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );

    // Se frena de leer al pasar el tope (con margen para el recorte): un
    // script que se desborda no tiene que inflar la memoria del agente.
    const hardCap = options.maxOutputChars * 2;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => { if (stdout.length < hardCap) stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => { if (stderr.length < hardCap) stderr += chunk; });

    const finish = (exitCode: number, extraStderr = "") => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
        durationMs: Date.now() - started,
        timedOut,
        stdout: truncate(tidy(redact(stdout)), options.maxOutputChars),
        stderr: truncate(tidy(redact(stderr + extraStderr)), options.maxOutputChars),
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
      finish(-1, `\nTimeout: el diagnóstico superó ${Math.round(options.timeoutMs / 1000)}s y se canceló`);
    }, options.timeoutMs);

    child.on("error", (err) => finish(-1, `No se pudo lanzar PowerShell: ${err.message}`));
    child.on("close", (code) => finish(code ?? -1));
  });
}
