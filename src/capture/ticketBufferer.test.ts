import { test } from "node:test";
import assert from "node:assert/strict";

import { createTicketBufferer } from "./ticketBufferer.js";

const MARKER = "\x1dV"; // GS V

// Reproduce el bug real: antes solo se chequeaba si el buffer *contenía*
// el marcador en algún lado, se entregaba TODO el buffer como un ticket y
// se vaciaba — dos tickets en el mismo bloque de datos se mezclaban en
// un solo texto.
test("dos tickets en un mismo chunk se entregan por separado", () => {
  const delivered: string[] = [];
  const bufferer = createTicketBufferer({
    marker: MARKER,
    maxBufferBytes: 8192,
    silenceTimeoutMs: 60_000,
    onTicketText: (t) => delivered.push(t),
  });

  bufferer.feed(`TICKET UNO${MARKER}TICKET DOS${MARKER}`);
  assert.deepEqual(delivered, [`TICKET UNO${MARKER}`, `TICKET DOS${MARKER}`]);
  bufferer.dispose();
});

test("lo que sobra después del marcador se conserva para el próximo ticket", () => {
  const delivered: string[] = [];
  const bufferer = createTicketBufferer({
    marker: MARKER,
    maxBufferBytes: 8192,
    silenceTimeoutMs: 60_000,
    onTicketText: (t) => delivered.push(t),
  });

  bufferer.feed(`TICKET UNO${MARKER}TICKET D`);
  assert.deepEqual(delivered, [`TICKET UNO${MARKER}`], "el arranque del siguiente no se entrega todavía");

  bufferer.feed(`OS${MARKER}`);
  assert.deepEqual(delivered, [`TICKET UNO${MARKER}`, `TICKET DOS${MARKER}`], "se completa con el próximo chunk");
  bufferer.dispose();
});

test("tres tickets repartidos en chunks arbitrarios se entregan correctamente", () => {
  const delivered: string[] = [];
  const bufferer = createTicketBufferer({
    marker: MARKER,
    maxBufferBytes: 8192,
    silenceTimeoutMs: 60_000,
    onTicketText: (t) => delivered.push(t),
  });

  // partido de formas arbitrarias, sin relación con los límites de ticket
  bufferer.feed(`A${MARKER}B`);
  bufferer.feed(`${MARKER}C${MARKER}sobra`);
  assert.deepEqual(delivered, [`A${MARKER}`, `B${MARKER}`, `C${MARKER}`]);
  bufferer.dispose();
});

test("buffer que supera el máximo sin marcador se entrega igual", () => {
  const delivered: string[] = [];
  const warnings: string[] = [];
  const bufferer = createTicketBufferer({
    marker: MARKER,
    maxBufferBytes: 20,
    silenceTimeoutMs: 60_000,
    onTicketText: (t) => delivered.push(t),
    onWarning: (w) => warnings.push(w),
  });

  bufferer.feed("X".repeat(25));
  assert.equal(delivered.length, 1);
  assert.equal(delivered[0].length, 25);
  assert.equal(warnings.length, 1);
  bufferer.dispose();
});

test("silencio prolongado sin marcador entrega lo acumulado", async () => {
  const delivered: string[] = [];
  const bufferer = createTicketBufferer({
    marker: MARKER,
    maxBufferBytes: 8192,
    silenceTimeoutMs: 30,
    onTicketText: (t) => delivered.push(t),
  });

  bufferer.feed("TICKET SIN CIERRE");
  assert.deepEqual(delivered, [], "nada entregado todavía");

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(delivered, ["TICKET SIN CIERRE"]);
  bufferer.dispose();
});

test("dispose() cancela el timer de silencio pendiente", async () => {
  const delivered: string[] = [];
  const bufferer = createTicketBufferer({
    marker: MARKER,
    maxBufferBytes: 8192,
    silenceTimeoutMs: 20,
    onTicketText: (t) => delivered.push(t),
  });

  bufferer.feed("TICKET SIN CIERRE");
  bufferer.dispose();

  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(delivered, [], "no debería entregarse nada después de dispose()");
});
