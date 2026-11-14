import { deflateSync } from "node:zlib";

/**
 * Arma un PDF mínimo con el mismo esqueleto que el que genera el ERP de Alamo
 * (una fuente compuesta Identity-H con mapa ToUnicode y un `Td`/`Tj` por renglón),
 * para probar la lectura de texto sin depender de facturas reales. Solo para tests.
 */
export function buildPdf(lines: string[], options: { compressContent?: boolean; trailer?: boolean } = {}): Buffer {
  // Un código de 2 bytes por carácter distinto, desde 3 como en el ERP.
  const codes = new Map<string, number>();
  for (const line of lines) {
    for (const ch of line) if (!codes.has(ch)) codes.set(ch, codes.size + 3);
  }

  const literal = (text: string): string => {
    let out = "";
    for (const ch of text) {
      const code = codes.get(ch)!;
      for (const byte of [code >> 8, code & 0xff]) {
        if (byte === 0x28 || byte === 0x29 || byte === 0x5c) out += "\\" + String.fromCharCode(byte);
        else out += String.fromCharCode(byte);
      }
    }
    return `(${out})`;
  };

  let content = "BT\n/F1 7 Tf\n22.67717 792 Td\n";
  lines.forEach((line, i) => {
    // Cada renglón baja 10,5 respecto del anterior; el primero también.
    content += `0 -10.5 Td\n${literal(line)} Tj\n`;
    void i;
  });
  content += "ET\n";

  const bfchars = [...codes.entries()]
    .map(([ch, code]) => `<${code.toString(16).padStart(4, "0")}> <${ch.charCodeAt(0).toString(16).padStart(4, "0")}>`)
    .join("\n");
  const cmap =
    "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n/CMapName /Adobe-Identity-UCS def\n" +
    "1 begincodespacerange\n<0000> <FFFF>\nendcodespacerange\n" +
    `${codes.size} beginbfchar\n${bfchars}\nendbfchar\nendcmap\nend\nend\n`;
  const cmapStream = deflateSync(Buffer.from(cmap, "latin1"));

  const contentBytes = Buffer.from(content, "latin1");
  const contentStream = options.compressContent ? deflateSync(contentBytes) : contentBytes;
  const contentDict = options.compressContent
    ? `<< /Length ${contentStream.length} /Filter /FlateDecode >>`
    : `<< /Length ${contentStream.length} >>`;

  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xf6\xe4\xfc\xdf\n", "latin1")];
  const obj = (n: number, dict: string, stream?: Buffer): void => {
    parts.push(Buffer.from(`${n} 0 obj\n${dict}\n`, "latin1"));
    if (stream) {
      parts.push(Buffer.from("stream\r\n", "latin1"), stream, Buffer.from("\nendstream\n", "latin1"));
    }
    parts.push(Buffer.from("endobj\n", "latin1"));
  };
  obj(1, "<< /Type /Catalog /Version /1.4 /Pages 2 0 R >>");
  obj(2, "<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  obj(3, "<< /Type /Page /MediaBox [0.0 0.0 612.0 792.0] /Parent 2 0 R /Contents 4 0 R /Resources 5 0 R >>");
  obj(4, contentDict, contentStream);
  obj(5, "<< /Font 6 0 R >>");
  obj(6, "<< /F1 8 0 R >>");
  obj(8, "<< /Type /Font /BaseFont /AAAYBH+CourierNewPSMT /Subtype /Type0 /Encoding /Identity-H /DescendantFonts [12 0 R] /ToUnicode 13 0 R >>");
  obj(13, `<< /Length ${cmapStream.length} /Filter /FlateDecode >>`, cmapStream);
  if (options.trailer !== false) parts.push(Buffer.from("trailer\n<< /Root 1 0 R >>\nstartxref\n0\n%%EOF\n", "latin1"));
  return Buffer.concat(parts);
}

/** Texto de una factura de Alamo con los renglones que importan, para pruebas. */
export function invoiceLines(options: { number?: string; sellerId?: string; sellerName?: string } = {}): string[] {
  return [
    "INDUSTRIA ALIMENTICIA ALAMO S.A.S                    +----------------------------------------+",
    "                                                     |       FACTURA ELECTRONICA DE VENTA     |",
    "NIT.: 900528724-6                                    +----------------------------------------+",
    `CRA 36 10 549 BODEGA 5                               | Numero: ${options.number ?? "FVA38478"}                       |`,
    "| Cliente : SERVIGRAFIC SAS                          | Forma de Pago: CREDITO CREDITO |",
    "| NIT.      :       890323309-6 Codigo: 890323309    +----------------------+---------+",
    `| Direccion : CRA 36 10 107 ZN ARROYOHONDO           | Vendedor: ${options.sellerId ?? "1144047585"}    ${options.sellerName ?? "RIOS NOREÑA DANIELA"}      |`,
    "|001 900003              FLETES                      40  1.000 UND 41,000.00 |",
  ];
}
