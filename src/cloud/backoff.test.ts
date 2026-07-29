import { test } from "node:test";
import assert from "node:assert/strict";

import { classifyFailure, computeBackoffMs } from "./backoff.js";

test("classifyFailure: 4xx (salvo 408/429) es permanente", () => {
  assert.equal(classifyFailure(400), "permanent");
  assert.equal(classifyFailure(401), "permanent");
  assert.equal(classifyFailure(403), "permanent");
  assert.equal(classifyFailure(404), "permanent");
  assert.equal(classifyFailure(422), "permanent");
});

test("classifyFailure: 408/429/5xx/sin status son transitorios", () => {
  assert.equal(classifyFailure(408), "transient");
  assert.equal(classifyFailure(429), "transient");
  assert.equal(classifyFailure(500), "transient");
  assert.equal(classifyFailure(503), "transient");
  assert.equal(classifyFailure(undefined), "transient", "sin status = falló el fetch (red caída)");
});

test("computeBackoffMs: crece con los intentos y respeta el techo transitorio", () => {
  const baseMs = 15_000;
  const first = computeBackoffMs(1, "transient", baseMs);
  const later = computeBackoffMs(6, "transient", baseMs);
  const capped = computeBackoffMs(20, "transient", baseMs);

  // primer intento: cerca del intervalo base (con jitter ±20%)
  assert.ok(first >= baseMs * 0.8 && first <= baseMs * 1.2, `first=${first} fuera de rango`);
  // crece con los intentos
  assert.ok(later > first, `later=${later} debería ser mayor que first=${first}`);
  // nunca supera el techo transitorio (5 min) + jitter
  assert.ok(capped <= 5 * 60_000 * 1.2, `capped=${capped} superó el techo esperado`);
});

test("computeBackoffMs: los permanentes arrancan mucho más arriba que los transitorios", () => {
  const baseMs = 15_000;
  const transient = computeBackoffMs(1, "transient", baseMs);
  const permanent = computeBackoffMs(1, "permanent", baseMs);

  assert.ok(permanent > transient * 5, "un error permanente no debería reintentarse casi al toque");
  // techo de una hora + jitter
  const cappedPermanent = computeBackoffMs(20, "permanent", baseMs);
  assert.ok(cappedPermanent <= 60 * 60_000 * 1.2, `cappedPermanent=${cappedPermanent} superó el techo esperado`);
});
