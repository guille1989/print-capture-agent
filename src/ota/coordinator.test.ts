import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createOtaCoordinator } from "./coordinator.js";

test("coordinator: download + verify + pending-apply + restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-coord-"));
  const body = Buffer.from("// bundle v0.5.1\n");
  const sha256 = createHash("sha256").update(body).digest("hex");

  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/javascript" });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const statuses: string[] = [];
  let restarted = false;
  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0",
    downloadTimeoutMs: 5_000,
    onStatus: (s) => statuses.push(s),
    requestRestart: () => {
      restarted = true;
    },
  });

  await ota.applySignal({
    desiredVersion: "0.5.1",
    url: `http://127.0.0.1:${port}/app.mjs`,
    sha256,
  });

  server.close();
  assert.ok(restarted);
  assert.deepEqual(statuses, ["downloading", "verifying", "pending_apply"]);
  const marker = JSON.parse(await readFile(join(dataDir, "updates", "pending-apply.json"), "utf8"));
  assert.equal(marker.version, "0.5.1");
  assert.equal(marker.sha256, sha256);
  const staged = await readFile(join(dataDir, "updates", "staging", "app.mjs"));
  assert.deepEqual(staged, body);
});

test("coordinator: sha mismatch reporta error y no pide restart", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-coord-bad-"));
  const body = Buffer.from("bad\n");
  const server = createServer((_req, res) => {
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };

  const statuses: string[] = [];
  let restarted = false;
  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0",
    downloadTimeoutMs: 5_000,
    onStatus: (s) => statuses.push(s),
    requestRestart: () => {
      restarted = true;
    },
  });

  await ota.applySignal({
    desiredVersion: "0.5.1",
    url: `http://127.0.0.1:${port}/app.mjs`,
    sha256: "a".repeat(64),
  });
  server.close();
  assert.equal(restarted, false);
  assert.ok(statuses.includes("error"));
});

test("coordinator: arrancar NO confirma el update; solo confirmBoot() borra boot-check", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-boot-"));
  await mkdir(join(dataDir, "updates"), { recursive: true });
  await writeFile(
    join(dataDir, "updates", "boot-check.json"),
    JSON.stringify({ version: "0.5.1", appliedAt: new Date().toISOString() }),
  );

  const statuses: string[] = [];
  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.5.1",
    downloadTimeoutMs: 1_000,
    onStatus: (s) => statuses.push(s),
    requestRestart: () => undefined,
  });

  // Al arrancar el marker debe seguir ahí: el agente aún no probó estar sano,
  // y si muere ahora el servicio tiene que poder revertir.
  await ota.consumeStartupMarkers();
  assert.deepEqual(statuses, []);
  await readFile(join(dataDir, "updates", "boot-check.json"));

  await ota.confirmBoot();
  assert.deepEqual(statuses, ["ok"]);
  await assert.rejects(readFile(join(dataDir, "updates", "boot-check.json")), /ENOENT/);

  // Idempotente: otro heartbeat no vuelve a reportar.
  await ota.confirmBoot();
  assert.deepEqual(statuses, ["ok"]);
});

test("coordinator: confirmBoot no confirma si el bundle corre con otra versión", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-boot-mismatch-"));
  await mkdir(join(dataDir, "updates"), { recursive: true });
  await writeFile(
    join(dataDir, "updates", "boot-check.json"),
    JSON.stringify({ version: "0.6.1", appliedAt: new Date().toISOString() }),
  );

  const statuses: string[] = [];
  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0", // el bundle publicado como 0.6.1 declara 0.6.0
    downloadTimeoutMs: 1_000,
    onStatus: (s) => statuses.push(s),
    requestRestart: () => undefined,
  });

  await ota.confirmBoot();
  assert.deepEqual(statuses, []);
  await readFile(join(dataDir, "updates", "boot-check.json")); // sigue: el servicio revertirá
});

test("coordinator: confirmBoot sin boot-check no hace nada", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-boot-none-"));
  const statuses: string[] = [];
  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0",
    downloadTimeoutMs: 1_000,
    onStatus: (s) => statuses.push(s),
    requestRestart: () => undefined,
  });
  await ota.confirmBoot();
  assert.deepEqual(statuses, []);
});

async function countingServer(body: Buffer) {
  const state = { hits: 0 };
  const server = createServer((_req, res) => {
    state.hits += 1;
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as { port: number };
  return { state, url: `http://127.0.0.1:${port}/app.mjs`, close: () => server.close() };
}

function sha(body: Buffer): string {
  return createHash("sha256").update(body).digest("hex");
}

async function writeRolledBack(dataDir: string, fromVersion: string): Promise<void> {
  await mkdir(join(dataDir, "updates"), { recursive: true });
  await writeFile(
    join(dataDir, "updates", "rolled-back.json"),
    JSON.stringify({ fromVersion, toVersion: null, reason: "agent did not confirm OTA boot in time", at: "t+1" }),
  );
}

test("coordinator: una versión revertida no se vuelve a descargar (corta el bucle de rollback)", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-block-"));
  const body = Buffer.from("// bundle\n");
  const srv = await countingServer(body);
  await writeRolledBack(dataDir, "0.6.1");

  const statuses: string[] = [];
  let restarts = 0;
  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0",
    downloadTimeoutMs: 5_000,
    onStatus: (s) => statuses.push(s),
    requestRestart: () => {
      restarts += 1;
    },
  });

  await ota.consumeStartupMarkers();
  assert.deepEqual(statuses, ["rolled_back"]);

  // El cloud sigue pidiendo 0.6.1 en cada heartbeat: no se toca la red.
  const signal = { desiredVersion: "0.6.1", url: srv.url, sha256: sha(body) };
  await ota.applySignal(signal);
  await ota.applySignal(signal);
  assert.equal(srv.state.hits, 0);
  assert.equal(restarts, 0);

  // Sobrevive a un reinicio del proceso (el bloqueo está en disco).
  const restarted = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0",
    downloadTimeoutMs: 5_000,
    requestRestart: () => undefined,
  });
  await restarted.applySignal(signal);
  assert.equal(srv.state.hits, 0);

  // Otra versión distinta sí se instala.
  await ota.applySignal({ ...signal, desiredVersion: "0.6.2" });
  assert.equal(srv.state.hits, 1);
  assert.equal(restarts, 1);
  srv.close();
});

test("coordinator: el bloqueo de una versión revertida vence", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-block-exp-"));
  const body = Buffer.from("// bundle\n");
  const srv = await countingServer(body);
  await writeRolledBack(dataDir, "0.6.1");

  let clock = 1_000_000;
  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0",
    downloadTimeoutMs: 5_000,
    now: () => clock,
    blockMs: 60 * 60_000,
    requestRestart: () => undefined,
  });
  await ota.consumeStartupMarkers();

  const signal = { desiredVersion: "0.6.1", url: srv.url, sha256: sha(body) };
  clock += 30 * 60_000;
  await ota.applySignal(signal);
  assert.equal(srv.state.hits, 0);

  clock += 31 * 60_000;
  await ota.applySignal(signal);
  assert.equal(srv.state.hits, 1);
  srv.close();
});

test("coordinator: rolled-back sin versión conocida no bloquea nada", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-block-unk-"));
  const body = Buffer.from("// bundle\n");
  const srv = await countingServer(body);
  await writeRolledBack(dataDir, "unknown");

  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0",
    downloadTimeoutMs: 5_000,
    requestRestart: () => undefined,
  });
  await ota.consumeStartupMarkers();
  await ota.applySignal({ desiredVersion: "0.6.1", url: srv.url, sha256: sha(body) });
  assert.equal(srv.state.hits, 1);
  srv.close();
});

test("coordinator: un fallo repetido (sha256) reintenta con backoff creciente, no en cada heartbeat", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "ota-backoff-"));
  const srv = await countingServer(Buffer.from("contenido distinto al hash\n"));
  let clock = 5_000_000;
  const ota = createOtaCoordinator({
    dataDir,
    agentVersion: "0.6.0",
    downloadTimeoutMs: 5_000,
    now: () => clock,
    requestRestart: () => undefined,
  });
  const signal = { desiredVersion: "0.6.1", url: srv.url, sha256: "a".repeat(64) };

  await ota.applySignal(signal); // 1er intento
  assert.equal(srv.state.hits, 1);

  clock += 30_000; // heartbeat siguiente: dentro de 1 min
  await ota.applySignal(signal);
  assert.equal(srv.state.hits, 1);

  clock += 31_000; // pasó el minuto
  await ota.applySignal(signal);
  assert.equal(srv.state.hits, 2);

  clock += 61_000; // ahora hay que esperar 5 min
  await ota.applySignal(signal);
  assert.equal(srv.state.hits, 2);

  clock += 5 * 60_000;
  await ota.applySignal(signal);
  assert.equal(srv.state.hits, 3);

  // Un hash distinto para la misma versión (re-publicada) reintenta ya.
  await ota.applySignal({ ...signal, sha256: "b".repeat(64) });
  assert.equal(srv.state.hits, 4);
  srv.close();
});
