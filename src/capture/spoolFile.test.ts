import { test } from "node:test";
import assert from "node:assert/strict";

import { classifySpool, isGraphicDatatype, isRawDatatype, looksLikeEmf, splitSpoolIntoTickets } from "./spoolFile.js";

const CUT = "\x1dV";

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

test("splitSpoolIntoTickets: un trabajo con una sola copia", () => {
  const tickets = splitSpoolIntoTickets(`\x1b@EMPANADAS TIPICAS\n2 x Empanada  $6.000\nTOTAL $6.000\n${CUT}`);
  assert.equal(tickets.length, 1);
  assert.ok(tickets[0].endsWith(CUT));
});

test("splitSpoolIntoTickets: comanda de cocina + ticket de cliente en el mismo trabajo", () => {
  const tickets = splitSpoolIntoTickets(`COCINA\n2 Empanada${CUT}\x1b@CLIENTE\nTOTAL $6.000${CUT}`);
  assert.equal(tickets.length, 2);
  assert.ok(tickets[0].startsWith("COCINA"));
  assert.ok(tickets[1].includes("CLIENTE"));
});

test("splitSpoolIntoTickets: sin comando de corte, el archivo entero es un ticket", () => {
  const tickets = splitSpoolIntoTickets("VENTA MOSTRADOR\nTOTAL $3.000\n");
  assert.deepEqual(tickets, ["VENTA MOSTRADOR\nTOTAL $3.000\n"]);
});

test("splitSpoolIntoTickets: el avance de papel después del último corte no cuenta como ticket", () => {
  const tickets = splitSpoolIntoTickets(`TICKET${CUT}\n\n\n\x1b\x64\x03`);
  assert.equal(tickets.length, 1);
  assert.ok(tickets[0].startsWith("TICKET"));
});

test("splitSpoolIntoTickets: contenido vacío o solo control devuelve lista vacía", () => {
  assert.deepEqual(splitSpoolIntoTickets(""), []);
  assert.deepEqual(splitSpoolIntoTickets("\x00\x00\n\r "), []);
});
