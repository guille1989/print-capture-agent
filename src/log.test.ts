import { test } from "node:test";
import assert from "node:assert/strict";

import { installTimestampedLogging } from "./log.js";

test("installTimestampedLogging antepone un timestamp ISO a console.log/error/warn", () => {
  const original = { log: console.log, error: console.error, warn: console.warn };
  const captured: unknown[][] = [];
  console.log = (...args: unknown[]) => captured.push(["log", ...args]);
  console.error = (...args: unknown[]) => captured.push(["error", ...args]);
  console.warn = (...args: unknown[]) => captured.push(["warn", ...args]);

  try {
    installTimestampedLogging();
    console.log("hola", 1);
    console.error("fallo");
    console.warn("cuidado");
  } finally {
    console.log = original.log;
    console.error = original.error;
    console.warn = original.warn;
  }

  assert.equal(captured.length, 3);
  const isoPrefix = /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]$/;
  assert.match(String(captured[0][1]), isoPrefix, "log trae timestamp");
  assert.deepEqual(captured[0].slice(2), ["hola", 1]);
  assert.match(String(captured[1][1]), isoPrefix, "error trae timestamp");
  assert.deepEqual(captured[1].slice(2), ["fallo"]);
  assert.match(String(captured[2][1]), isoPrefix, "warn trae timestamp");
  assert.deepEqual(captured[2].slice(2), ["cuidado"]);
});
