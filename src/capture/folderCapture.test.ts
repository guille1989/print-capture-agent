import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { classifyInvoiceXml, createFolderPoller, stripContactBlocks } from "./folderCapture.js";

const SALE_XML =
  '<?xml version="1.0" encoding="UTF-8"?><Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" ' +
  'xmlns:cbc="urn:cbc" xmlns:cac="urn:cac"><cbc:ID>FVA1</cbc:ID><cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>' +
  "<cac:AccountingCustomerParty><cac:Party><cac:Contact><cbc:Telephone>3001234567</cbc:Telephone>" +
  "<cbc:ElectronicMail>cliente@example.com</cbc:ElectronicMail></cac:Contact></cac:Party></cac:AccountingCustomerParty></Invoice>";

const SUPPORT_DOC_XML = SALE_XML.replace("<cbc:InvoiceTypeCode>01<", "<cbc:InvoiceTypeCode>05<");

test("classifyInvoiceXml: reconoce una venta, ignora compras y notas, y espera a un archivo incompleto", () => {
  assert.equal(classifyInvoiceXml(SALE_XML).kind, "sale");
  assert.equal(classifyInvoiceXml(SALE_XML + "\n").kind, "sale");
  assert.equal(classifyInvoiceXml(SUPPORT_DOC_XML).kind, "ignore");
  assert.equal(classifyInvoiceXml('<CreditNote xmlns="urn:x"><ID>NC1</ID></CreditNote>').kind, "ignore");
  assert.equal(classifyInvoiceXml(SALE_XML.slice(0, SALE_XML.length - 20)).kind, "incomplete");
  assert.equal(classifyInvoiceXml("").kind, "incomplete");
  assert.equal(classifyInvoiceXml(SALE_XML.replace("<cbc:InvoiceTypeCode>01</cbc:InvoiceTypeCode>", "")).kind, "ignore");
});

test("stripContactBlocks: quita teléfono y correo del cliente y deja el resto igual", () => {
  const stripped = stripContactBlocks(SALE_XML);
  assert.ok(!stripped.includes("3001234567"));
  assert.ok(!stripped.includes("cliente@example.com"));
  assert.ok(stripped.includes("<cbc:ID>FVA1</cbc:ID>"));
  assert.ok(stripped.endsWith("</cac:Party></cac:AccountingCustomerParty></Invoice>"));
  assert.equal(stripContactBlocks("<Invoice><ID>1</ID></Invoice>"), "<Invoice><ID>1</ID></Invoice>");
});

interface Captured {
  port: string;
  xml: string;
  capturedAt: string;
}

async function setup() {
  const root = await mkdtemp(path.join(tmpdir(), "folder-capture-"));
  const dir = path.join(root, "UNFE");
  await import("node:fs/promises").then((fs) => fs.mkdir(dir));
  const stateFile = path.join(root, "state", "folder-state.json");
  const captured: Captured[] = [];
  const make = (extra: { backfillSinceMs?: number } = {}) =>
    createFolderPoller({
      dir,
      port: "Carpeta UNFE",
      stateFile,
      settleMs: 0,
      onInvoice: (port, rawBase64, capturedAt) =>
        captured.push({ port, xml: Buffer.from(rawBase64, "base64").toString("latin1"), capturedAt }),
      ...extra,
    });
  const put = async (name: string, content: string | Buffer, mtime?: Date) => {
    const file = path.join(dir, name);
    await writeFile(file, content);
    if (mtime) await utimes(file, mtime, mtime);
  };
  return { root, dir, captured, make, put, cleanup: () => rm(root, { recursive: true, force: true }) };
}

test("primera vigilancia: lo que ya había es historial y no se sube; lo nuevo sí", async () => {
  const t = await setup();
  try {
    await t.put("viejo.xml", SALE_XML);
    const poller = t.make();
    await poller.pollOnce();
    assert.equal(t.captured.length, 0);

    await t.put("01001FE0382670090165541000.xml", SALE_XML);
    await poller.pollOnce();
    assert.equal(t.captured.length, 1);
    assert.equal(t.captured[0].port, "Carpeta UNFE");
    // Se subió sin los datos de contacto del cliente.
    assert.ok(!t.captured[0].xml.includes("cliente@example.com"));
    assert.ok(t.captured[0].xml.includes("<cbc:ID>FVA1</cbc:ID>"));
  } finally {
    await t.cleanup();
  }
});

test("no vuelve a subir lo ya visto, ni siquiera tras reiniciar el agente", async () => {
  const t = await setup();
  try {
    await t.make().pollOnce(); // baseline vacío
    await t.put("a.xml", SALE_XML);
    await t.make().pollOnce();
    await t.make().pollOnce(); // "reinicio": otro poller con el mismo archivo de estado
    assert.equal(t.captured.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("las dos copias del ERP (.xml y .xml.xml) se consideran; la nube las deduplica por número de factura", async () => {
  const t = await setup();
  try {
    const poller = t.make();
    await poller.pollOnce();
    await t.put("01001FE038267.xml", SALE_XML);
    await t.put("01001FE038267.xml.xml", SALE_XML);
    await poller.pollOnce();
    assert.equal(t.captured.length, 2);
  } finally {
    await t.cleanup();
  }
});

test("no sube documentos soporte (compras) ni XML ajenos, y los marca como vistos", async () => {
  const t = await setup();
  try {
    const poller = t.make();
    await poller.pollOnce();
    await t.put("01001DC0000010031954400000.xml", SUPPORT_DOC_XML);
    await t.put("otra-cosa.xml", "<Configuracion><a>1</a></Configuracion>");
    await t.put("nota.txt", SALE_XML);
    await poller.pollOnce();
    await poller.pollOnce();
    assert.equal(t.captured.length, 0);
  } finally {
    await t.cleanup();
  }
});

test("un archivo a medio escribir se reintenta hasta que está completo", async () => {
  const t = await setup();
  try {
    const poller = t.make();
    await poller.pollOnce();
    await t.put("a.xml", SALE_XML.slice(0, 200));
    await poller.pollOnce();
    assert.equal(t.captured.length, 0);

    await t.put("a.xml", SALE_XML);
    await poller.pollOnce();
    assert.equal(t.captured.length, 1);
  } finally {
    await t.cleanup();
  }
});

test("espera a que el archivo lleve un rato sin modificarse", async () => {
  const t = await setup();
  try {
    const poller = createFolderPoller({
      dir: t.dir,
      port: "Carpeta UNFE",
      stateFile: path.join(t.root, "state.json"),
      settleMs: 60_000,
      onInvoice: (_p, b64, at) => t.captured.push({ port: "x", xml: b64, capturedAt: at }),
    });
    await poller.pollOnce();
    await t.put("a.xml", SALE_XML); // mtime = ahora
    await poller.pollOnce();
    assert.equal(t.captured.length, 0);
  } finally {
    await t.cleanup();
  }
});

test("capturedAt es la fecha de modificación del archivo", async () => {
  const t = await setup();
  try {
    const poller = t.make();
    await poller.pollOnce();
    await t.put("a.xml", SALE_XML, new Date("2026-10-22T17:07:00.000Z"));
    await poller.pollOnce();
    assert.equal(t.captured[0].capturedAt, "2026-10-22T17:07:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("FOLDER_BACKFILL_SINCE: en la primera vigilancia sube lo existente desde esa fecha y toma el resto como historial", async () => {
  const t = await setup();
  try {
    await t.put("2022.xml", SALE_XML, new Date("2022-08-18T10:00:00Z"));
    await t.put("2026.xml", SALE_XML, new Date("2026-10-20T10:00:00Z"));
    await t.make({ backfillSinceMs: Date.parse("2026-10-01") }).pollOnce();
    assert.equal(t.captured.length, 1);
    assert.equal(t.captured[0].capturedAt, "2026-10-20T10:00:00.000Z");
  } finally {
    await t.cleanup();
  }
});

test("los bytes que no son UTF-8 válido se suben tal cual (la nube decide cómo decodificarlos)", async () => {
  const t = await setup();
  try {
    const poller = t.make();
    await poller.pollOnce();
    const withLatin1 = Buffer.concat([Buffer.from(SALE_XML.slice(0, -"</Invoice>".length), "latin1"), Buffer.from([0xf3]), Buffer.from("</Invoice>", "latin1")]);
    await t.put("a.xml", withLatin1);
    await poller.pollOnce();
    assert.equal(t.captured.length, 1);
    assert.ok(t.captured[0].xml.includes("ó</Invoice>"));
  } finally {
    await t.cleanup();
  }
});

test("una carpeta que no responde no tira nada abajo y se recupera después", async () => {
  const t = await setup();
  try {
    const poller = createFolderPoller({
      dir: path.join(t.root, "no-existe"),
      port: "Carpeta X",
      stateFile: path.join(t.root, "state.json"),
      settleMs: 0,
      onInvoice: () => assert.fail("no debía subir nada"),
    });
    await poller.pollOnce();
  } finally {
    await t.cleanup();
  }
});
