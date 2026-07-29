import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";

import { LocalQueue } from "./localQueue.js";

function tmpQueuePath(): string {
  return `./data/test-queue-${randomUUID()}.json`;
}

test("enqueue/getPending/markSent: ciclo básico", async () => {
  const path = tmpQueuePath();
  const queue = new LocalQueue<{ n: number }>(path);
  await queue.load();

  await queue.enqueue("a", { n: 1 });
  assert.deepEqual(
    queue.getPending().map((r) => r.id),
    ["a"],
  );

  await queue.markSent("a");
  assert.deepEqual(queue.getPending(), []);

  await rm(path, { force: true });
});

test("markFailed incrementa attempts y persiste nextRetryAt", async () => {
  const path = tmpQueuePath();
  const queue = new LocalQueue<{ n: number }>(path);
  await queue.load();

  await queue.enqueue("a", { n: 1 });
  const future = new Date(Date.now() + 60_000).toISOString();
  await queue.markFailed("a", future);

  const item = queue.getPending().find((r) => r.id === "a");
  assert.equal(item?.attempts, 1);
  assert.equal(item?.nextRetryAt, future);

  await rm(path, { force: true });
});

test("getDue excluye lo que sigue en backoff, incluye lo vencido y lo nuevo", async () => {
  const path = tmpQueuePath();
  const queue = new LocalQueue<{ n: number }>(path);
  await queue.load();

  await queue.enqueue("en-backoff", { n: 1 });
  await queue.enqueue("vencido", { n: 2 });
  await queue.enqueue("nunca-fallo", { n: 3 });

  await queue.markFailed("en-backoff", new Date(Date.now() + 5 * 60_000).toISOString());
  await queue.markFailed("vencido", new Date(Date.now() - 1_000).toISOString());

  const due = queue.getDue().map((r) => r.id).sort();
  assert.deepEqual(due, ["nunca-fallo", "vencido"]);

  await rm(path, { force: true });
});

test("persistencia sobrevive un reload desde disco", async () => {
  const path = tmpQueuePath();
  const queue = new LocalQueue<{ n: number }>(path);
  await queue.load();
  await queue.enqueue("a", { n: 42 });

  const reloaded = new LocalQueue<{ n: number }>(path);
  await reloaded.load();
  assert.deepEqual(
    reloaded.getPending().map((r) => r.payload),
    [{ n: 42 }],
  );

  await rm(path, { force: true });
});

// Reproduce el bug real: el agente dispara capturas y el sync sin
// esperarse entre sí (`void handleTicketText(...)` en index.ts), así que
// enqueue/markSent/markFailed pueden llamarse en paralelo. Antes del fix,
// dos `writeFile` concurrentes sobre el mismo archivo podían pisarse o
// corromper el JSON.
test("operaciones concurrentes no pierden datos ni corrompen el archivo", async () => {
  const path = tmpQueuePath();
  const queue = new LocalQueue<{ n: number }>(path);
  await queue.load();

  const N = 200;
  const ids = Array.from({ length: N }, (_, i) => `id-${i}`);

  await Promise.all(ids.map((id, i) => queue.enqueue(id, { n: i })));
  assert.equal(queue.getPending().length, N, "todos los enqueue en paralelo deberían sobrevivir");

  await Promise.all([
    ...ids.slice(0, 100).map((id) => queue.markSent(id)),
    ...ids.slice(100).map((id) => queue.markFailed(id, new Date().toISOString())),
    ...Array.from({ length: 20 }, (_, i) => queue.enqueue(`extra-${i}`, { n: 1000 + i })),
  ]);

  const final = queue.getPending();
  assert.equal(final.length, 120, "100 marcados sent + 100 failed + 20 extra = 120 sobrevivientes");

  const onDisk = JSON.parse(await readFile(path, "utf-8"));
  assert.equal(onDisk.length, final.length, "el archivo en disco debe coincidir con el estado en memoria");

  await rm(path, { force: true });
});
