import { test } from "node:test";
import assert from "node:assert/strict";

import { buildPdf, invoiceLines } from "./pdfFixture.js";
import { extractPdfLines, PdfTextError } from "./pdfText.js";

test("lee el texto de un PDF con fuente Identity-H y mapa ToUnicode, renglón por renglón", () => {
  const lines = invoiceLines();
  const read = extractPdfLines(buildPdf(lines));
  assert.equal(read.length, lines.length);
  assert.deepEqual(read, lines);
});

test("conserva la Ñ y los paréntesis y barras del texto", () => {
  const read = extractPdfLines(buildPdf(["RIOS NOREÑA (DANIELA) \\ C:\\UNO"]));
  assert.deepEqual(read, ["RIOS NOREÑA (DANIELA) \\ C:\\UNO"]);
});

test("también lee el contenido comprimido con Flate", () => {
  const lines = invoiceLines({ sellerName: "PELAEZ OTERO NATHALIA", sellerId: "1130683823" });
  assert.deepEqual(extractPdfLines(buildPdf(lines, { compressContent: true })), lines);
});

test("rechaza lo que no es un PDF y un PDF sin páginas", () => {
  assert.throws(() => extractPdfLines(Buffer.from("<html>hola</html>")), PdfTextError);
  assert.throws(() => extractPdfLines(Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")), PdfTextError);
});

test("un stream comprimido corrupto es un error controlado, no una excepción cualquiera", () => {
  const pdf = buildPdf(["HOLA"], { compressContent: true });
  const text = pdf.toString("latin1");
  // Rompe el stream de contenido comprimido: cambia su cabecera zlib.
  const at = text.indexOf("stream\r\n", text.indexOf("/FlateDecode")) + "stream\r\n".length;
  const broken = Buffer.from(pdf);
  broken[at] = 0xff;
  broken[at + 1] = 0xff;
  assert.throws(() => extractPdfLines(broken), PdfTextError);
});
