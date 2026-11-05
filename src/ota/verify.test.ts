import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { normalizeSha256, sha256File, verifyFileSha256 } from "./verify.js";

test("normalizeSha256: acepta hex de 64 y rechaza basura", () => {
  const ok = "a".repeat(64);
  assert.equal(normalizeSha256(ok), ok);
  assert.equal(normalizeSha256(ok.toUpperCase()), ok);
  assert.equal(normalizeSha256("abc"), undefined);
  assert.equal(normalizeSha256(`${"a".repeat(63)}g`), undefined);
});

test("verifyFileSha256: ok y mismatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ota-verify-"));
  const file = join(dir, "app.mjs");
  const body = Buffer.from("console.log('hi')\n");
  await writeFile(file, body);
  const hex = createHash("sha256").update(body).digest("hex");
  assert.equal(await sha256File(file), hex);
  await verifyFileSha256(file, hex);
  await assert.rejects(() => verifyFileSha256(file, "b".repeat(64)), /no coincide/);
});
