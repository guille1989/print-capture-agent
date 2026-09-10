import { test } from "node:test";
import assert from "node:assert/strict";

import { classifySpool, isGraphicDatatype, isRawDatatype, looksLikeEmf, splitEscpos } from "./spoolFile.js";

const CUT = "\x1dV";
/** helper: string latin1 → Buffer (los `.SPL` de test se escriben como texto). */
const b = (s: string): Buffer => Buffer.from(s, "latin1");

test("isRawDatatype reconoce las variantes RAW y TEXT", () => {
  for (const dt of ["RAW", "raw", " RAW [FF appended] ", "TEXT"]) {
    assert.equal(isRawDatatype(dt), true, dt);
  }
  for (const dt of ["EMF", "NT EMF 1.008", "XPS_PASS", "", null, undefined]) {
    assert.equal(isRawDatatype(dt), false, String(dt));
  }
});

test("isGraphicDatatype reconoce la familia EMF/XPS (incluye 'NT EMF 1.00x')", () => {
  for (const dt of ["EMF", "NT EMF 1.006", "nt emf 1.008", "XPS", "XPS_PASS"]) {
    assert.equal(isGraphicDatatype(dt), true, dt);
  }
  for (const dt of ["RAW", "TEXT", "", null]) {
    assert.equal(isGraphicDatatype(dt), false, String(dt));
  }
});

test("looksLikeEmf detecta la firma ' EMF' en el header", () => {
  const emfHeader = Buffer.concat([Buffer.alloc(40, 0), Buffer.from(" EMF"), Buffer.alloc(100, 0)]);
  assert.equal(looksLikeEmf(emfHeader), true);
  assert.equal(looksLikeEmf(Buffer.from("\x1b@   VENTA   $1.000\n\x1dV")), false);
});

test("classifySpool: datatype gráfico se descarta aunque el contenido no se haya podido mirar", () => {
  const decision = classifySpool({ datatype: "NT EMF 1.008", head: Buffer.alloc(0) });
  assert.equal(decision.kind, "skip");
});

test("classifySpool: sin datatype pero con contenido EMF se descarta", () => {
  const head = Buffer.concat([Buffer.alloc(40, 0), Buffer.from(" EMF")]);
  assert.equal(classifySpool({ head }).kind, "skip");
});

test("classifySpool: RAW explícito se captura", () => {
  assert.deepEqual(classifySpool({ datatype: "RAW", head: Buffer.from("VENTA") }), { kind: "raw" });
});

test("classifySpool: datatype desconocido y sin pinta de EMF se intenta igual", () => {
  assert.deepEqual(classifySpool({ datatype: undefined, head: Buffer.from("\x1b@VENTA\x1dV") }), { kind: "raw" });
});

test("splitEscpos: un trabajo con una sola copia", () => {
  const tickets = splitEscpos(b(`\x1b@EMPANADAS TIPICAS\n2 x Empanada  $6.000\nTOTAL $6.000\n${CUT}\x00`));
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0].subarray(-3), b(`${CUT}\x00`), "incluye el comando GS V m completo");
});

test("splitEscpos: comanda de cocina + ticket de cliente en el mismo trabajo", () => {
  const tickets = splitEscpos(b(`COCINA - 2 Empanada de pollo${CUT}\x00\x1b@CLIENTE\nTOTAL A PAGAR $6.000${CUT}\x00`));
  assert.equal(tickets.length, 2);
  assert.ok(tickets[0].toString("latin1").startsWith("COCINA"));
  assert.ok(tickets[1].toString("latin1").includes("CLIENTE"));
});

test("splitEscpos: `GS V m n` (corte con avance, 4 bytes) se incluye entero", () => {
  // GS V 66 10  → modo 'B' con n=10
  const tickets = splitEscpos(Buffer.concat([b("VENTA MOSTRADOR TOTAL 3000"), Buffer.from([0x1d, 0x56, 0x42, 0x0a])]));
  assert.equal(tickets.length, 1);
  assert.deepEqual(tickets[0].subarray(-4), Buffer.from([0x1d, 0x56, 0x42, 0x0a]));
});

test("splitEscpos: sin comando de corte, el trabajo entero es un ticket", () => {
  const buf = b("VENTA MOSTRADOR\nTOTAL $3.000\n");
  assert.deepEqual(splitEscpos(buf), [buf]);
});

test("splitEscpos: el avance de papel después del último corte no cuenta como ticket", () => {
  // ...ESC J / ESC d n de avance final: pocos bytes con contenido → se descarta
  const tickets = splitEscpos(b(`TICKET DE PRUEBA NUMERO 1${CUT}\x00\x1b\x4a\x50\x1b\x64\x03`));
  assert.equal(tickets.length, 1);
  assert.ok(tickets[0].toString("latin1").startsWith("TICKET"));
});

test("splitEscpos: contenido vacío o solo control devuelve lista vacía", () => {
  assert.deepEqual(splitEscpos(Buffer.alloc(0)), []);
  assert.deepEqual(splitEscpos(b("\x00\x00\n\r\x1b@")), []);
});

test("splitEscpos: un ticket-imagen raster (bytes binarios) se conserva entero", () => {
  // simula GS 8 L + datos de bitmap: muchos bytes >= 0x20 y de la mitad alta
  const raster = Buffer.concat([
    Buffer.from([0x1d, 0x38, 0x4c]),
    Buffer.alloc(500, 0xff),
    Buffer.from([0x1d, 0x56, 0x00]),
  ]);
  const tickets = splitEscpos(raster);
  assert.equal(tickets.length, 1);
  assert.equal(tickets[0].length, raster.length);
});
