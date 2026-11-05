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
    agentVersion: "0.5.0",
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
    agentVersion: "0.5.0",
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

test("coordinator: consumeStartupMarkers limpia boot-check de la versión actual", async () => {
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

  await ota.consumeStartupMarkers();
  assert.deepEqual(statuses, ["ok"]);
  await assert.rejects(readFile(join(dataDir, "updates", "boot-check.json")), /ENOENT/);
});
