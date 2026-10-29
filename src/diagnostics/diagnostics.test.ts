import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DIAGNOSTIC_SCRIPTS } from "./catalog.js";
import { createCommandWorker } from "./commandWorker.js";
import { encodeScript, redact, runDiagnostic, tidy, type DiagnosticResult } from "./runner.js";

const okResult: DiagnosticResult = { exitCode: 0, durationMs: 5, timedOut: false, stdout: "ok", stderr: "" };

test("catálogo: ningún script modifica nada ni toca las credenciales", () => {
  // Cmdlets que escriben, arrancan/paran cosas o ejecutan texto. Los de
  // `allowed` son de solo lectura pese al verbo.
  const allowed = new Set(["New-Object", "Invoke-WebRequest", "Add-Type"]);
  for (const [id, script] of Object.entries(DIAGNOSTIC_SCRIPTS)) {
    const verbs = script.match(/\b(Set|Remove|Restart|Stop|Start|New|Clear|Out|Invoke|Add|Copy|Move|Rename)-[A-Za-z]+/g) ?? [];
    const offending = verbs.filter((v) => !allowed.has(v));
    assert.deepEqual(offending, [], `${id} usa cmdlets que escriben o ejecutan: ${offending.join(", ")}`);
    assert.doesNotMatch(script, /Get-Content[^\n]*credentials/i, `${id} lee credentials.json`);
    assert.doesNotMatch(script, /rawBase64|rawText/, `${id} imprime contenido de tickets`);
  }
});

test("catálogo: los ids coinciden con los de la nube", () => {
  let cloud: string;
  try {
    cloud = readFileSync(new URL("../../../ticket-parsing-cloud/src/agents/commandCatalog.ts", import.meta.url), "utf8");
  } catch {
    return; // el agente puede testearse fuera del monorepo
  }
  const cloudIds = [...cloud.matchAll(/^\s+"?([a-z-]+)"?: "/gm)].map((m) => m[1]).sort();
  assert.deepEqual(Object.keys(DIAGNOSTIC_SCRIPTS).sort(), cloudIds);
});

test("redact: tapa api-keys y deja el resto", () => {
  assert.equal(redact('{"apiKey":"abcdEFGH12345678ijkl"}'), '{"apiKey":"[redactado]"}');
  assert.equal(redact("x-api-key: ZZZZZZZZZZZZZZZZZZZZ"), "x-api-key: [redactado]");
  assert.equal(redact("Spooler Running"), "Spooler Running");
});

test("tidy: compacta líneas en blanco y normaliza saltos de línea", () => {
  assert.equal(tidy("a\r\n\r\n\r\n\r\nb\r\n\r\n"), "a\n\nb");
});

test("encodeScript: UTF-16LE en base64 que fuerza salida UTF-8", () => {
  const decoded = Buffer.from(encodeScript("Get-Date"), "base64").toString("utf16le");
  assert.match(decoded, /OutputEncoding = \[System\.Text\.Encoding\]::UTF8/);
  assert.ok(decoded.endsWith("Get-Date"));
});

test("runDiagnostic: un id desconocido no ejecuta nada", async () => {
  const result = await runDiagnostic("Remove-Item C:\\ -Recurse", { env: {}, timeoutMs: 1000, maxOutputChars: 100 });
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /desconocido/);
});

test("runDiagnostic: si no se puede lanzar el shell, informa el error", async () => {
  const result = await runDiagnostic("printers", { env: {}, timeoutMs: 1000, maxOutputChars: 100, shell: "no-existe-este-binario.exe" });
  assert.equal(result.exitCode, -1);
  assert.match(result.stderr, /No se pudo lanzar PowerShell/);
});

test("worker: corre cada comando una sola vez y en orden", async () => {
  const ran: string[] = [];
  const reported: string[] = [];
  const worker = createCommandWorker({
    run: async (scriptId) => { ran.push(scriptId); return okResult; },
    report: async (commandId) => { reported.push(commandId); },
  });

  await worker.enqueue([{ commandId: "c1", scriptId: "printers" }, { commandId: "c2", scriptId: "network" }]);
  await worker.enqueue([{ commandId: "c1", scriptId: "printers" }]); // repetido por un heartbeat

  assert.deepEqual(ran, ["printers", "network"]);
  assert.deepEqual(reported, ["c1", "c2"]);
});

test("worker: reintenta informar el resultado y no se cae si nunca puede", async () => {
  const originalError = console.error;
  console.error = () => undefined;
  try {
    let attempts = 0;
    const flaky = createCommandWorker({
      run: async () => okResult,
      report: async () => { attempts++; if (attempts < 3) throw new Error("red caída"); },
      sleep: async () => undefined,
    });
    await flaky.enqueue([{ commandId: "c1", scriptId: "printers" }]);
    assert.equal(attempts, 3);

    let failures = 0;
    const failing = createCommandWorker({
      run: async () => okResult,
      report: async () => { failures++; throw new Error("sin red"); },
      sleep: async () => undefined,
    });
    await failing.enqueue([{ commandId: "c9", scriptId: "printers" }]);
    assert.equal(failures, 3);
  } finally {
    console.error = originalError;
  }
});

test("worker: un run que revienta no frena los comandos siguientes", async () => {
  const originalError = console.error;
  console.error = () => undefined;
  const reported: string[] = [];
  try {
    const worker = createCommandWorker({
      run: async (scriptId) => { if (scriptId === "printers") throw new Error("boom"); return okResult; },
      report: async (commandId) => { reported.push(commandId); },
    });
    await worker.enqueue([{ commandId: "c1", scriptId: "printers" }, { commandId: "c2", scriptId: "network" }]);
  } finally {
    console.error = originalError;
  }
  assert.deepEqual(reported, ["c2"]);
});
