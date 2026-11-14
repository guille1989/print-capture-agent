import { inflateSync } from "node:zlib";

/**
 * Extractor mínimo de texto de PDF, sin dependencias, para las facturas que el
 * ERP de Alamo (UNO/Siesa) deja en `UNFE\PDF`. No es un lector de PDF general:
 * entiende lo que esos archivos usan — streams de contenido con `Td`/`Tj`/`TJ`
 * y fuentes compuestas (Identity-H) con mapa `ToUnicode` — y cuando encuentra
 * algo que no entiende devuelve menos texto en vez de inventarlo.
 *
 * El PDF viene de afuera: nunca se ejecuta nada de él, todo está acotado (tamaño
 * de entrada y de salida descomprimida) y cualquier estructura rara termina en
 * una excepción `PdfTextError`, que quien llama trata como "PDF no legible".
 */

export class PdfTextError extends Error {}

const MAX_INFLATED_BYTES = 8 * 1024 * 1024;
const MAX_OBJECTS = 5000;

interface PdfObject {
  dict: string;
  stream?: Buffer;
}

export interface TextRun {
  x: number;
  y: number;
  text: string;
}

function readObjects(buf: Buffer): Map<number, PdfObject> {
  const s = buf.toString("latin1");
  const objects = new Map<number, PdfObject>();
  const header = /(\d+)\s+\d+\s+obj\b/g;
  let match: RegExpExecArray | null;
  while ((match = header.exec(s)) !== null) {
    if (objects.size >= MAX_OBJECTS) throw new PdfTextError("el PDF tiene demasiados objetos");
    const id = Number(match[1]);
    const bodyStart = header.lastIndex;
    const endobj = s.indexOf("endobj", bodyStart);
    const streamKw = s.indexOf("stream", bodyStart);
    if (streamKw !== -1 && (endobj === -1 || streamKw < endobj)) {
      const dict = s.slice(bodyStart, streamKw);
      let start = streamKw + "stream".length;
      if (s[start] === "\r") start++;
      if (s[start] === "\n") start++;
      // `/Length` directo cuando está; si es una referencia indirecta, hasta `endstream`.
      const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
      let end: number;
      if (direct && start + Number(direct[1]) <= buf.length) {
        end = start + Number(direct[1]);
      } else {
        end = s.indexOf("endstream", start);
        if (end === -1) throw new PdfTextError("stream sin cierre");
      }
      objects.set(id, { dict, stream: buf.subarray(start, end) });
      header.lastIndex = end;
    } else {
      if (endobj === -1) break;
      objects.set(id, { dict: s.slice(bodyStart, endobj) });
      header.lastIndex = endobj;
    }
  }
  return objects;
}

function streamBytes(obj: PdfObject | undefined): Buffer | undefined {
  if (!obj?.stream) return undefined;
  if (/\/FlateDecode/.test(obj.dict)) {
    try {
      return inflateSync(obj.stream, { maxOutputLength: MAX_INFLATED_BYTES });
    } catch {
      throw new PdfTextError("stream comprimido ilegible");
    }
  }
  return obj.stream;
}

function refTo(dict: string, key: string): number | undefined {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : undefined;
}

/** `<0041>` → "A". Los destinos de ToUnicode son UTF-16BE en hexadecimal. */
function utf16Hex(hex: string): string {
  const clean = hex.replace(/\s+/g, "");
  let out = "";
  for (let i = 0; i + 4 <= clean.length; i += 4) out += String.fromCharCode(parseInt(clean.slice(i, i + 4), 16));
  return out;
}

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) {
      map.set(parseInt(m[1], 16), utf16Hex(m[2]));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:<([0-9A-Fa-f]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16);
      const hi = parseInt(m[2], 16);
      if (hi < lo || hi - lo > 0xffff) continue;
      if (m[3] !== undefined) {
        const base = utf16Hex(m[3]);
        const last = base.charCodeAt(base.length - 1);
        for (let code = lo; code <= hi; code++) {
          map.set(code, base.slice(0, -1) + String.fromCharCode(last + (code - lo)));
        }
      } else if (m[4] !== undefined) {
        const targets = [...m[4].matchAll(/<([0-9A-Fa-f]+)>/g)].map((t) => utf16Hex(t[1]));
        targets.forEach((target, i) => {
          if (lo + i <= hi) map.set(lo + i, target);
        });
      }
    }
  }
  return map;
}

interface PdfFont {
  twoByte: boolean;
  toUnicode?: Map<number, string>;
}

function loadFonts(objects: Map<number, PdfObject>, page: PdfObject): Map<string, PdfFont> {
  const resourcesRef = refTo(page.dict, "Resources");
  const resourcesDict = resourcesRef !== undefined ? (objects.get(resourcesRef)?.dict ?? "") : page.dict;
  let fontEntries: string | undefined;
  const fontRef = refTo(resourcesDict, "Font");
  if (fontRef !== undefined) fontEntries = objects.get(fontRef)?.dict;
  else fontEntries = /\/Font\s*<<([\s\S]*?)>>/.exec(resourcesDict)?.[1];

  const fonts = new Map<string, PdfFont>();
  for (const entry of (fontEntries ?? "").matchAll(/\/([\w.+-]+)\s+(\d+)\s+\d+\s+R/g)) {
    const fontObj = objects.get(Number(entry[2]));
    if (!fontObj) continue;
    const twoByte = /\/Encoding\s*\/Identity-H/.test(fontObj.dict) || /\/Subtype\s*\/Type0/.test(fontObj.dict);
    const toUnicodeRef = refTo(fontObj.dict, "ToUnicode");
    const cmapBytes = toUnicodeRef !== undefined ? streamBytes(objects.get(toUnicodeRef)) : undefined;
    fonts.set(entry[1], { twoByte, toUnicode: cmapBytes ? parseToUnicode(cmapBytes.toString("latin1")) : undefined });
  }
  return fonts;
}

function decodeShown(bytes: number[], font: PdfFont | undefined): string {
  if (!font) return bytes.map((b) => String.fromCharCode(b)).join("");
  if (!font.twoByte) {
    return bytes.map((b) => font.toUnicode?.get(b) ?? String.fromCharCode(b)).join("");
  }
  let out = "";
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const code = (bytes[i] << 8) | bytes[i + 1];
    out += font.toUnicode?.get(code) ?? "�";
  }
  return out;
}

/** Tokeniza un stream de contenido y devuelve los textos con su posición absoluta en la página. */
function readTextRuns(content: string, fonts: Map<string, PdfFont>): TextRun[] {
  const runs: TextRun[] = [];
  let x = 0;
  let y = 0;
  let font: PdfFont | undefined;
  const operands: Array<number | string | { bytes: number[] } | Array<{ bytes: number[] }>> = [];
  let array: Array<{ bytes: number[] }> | undefined;

  const emit = (parts: Array<{ bytes: number[] }>): void => {
    const text = parts.map((p) => decodeShown(p.bytes, font)).join("");
    if (text.length > 0) runs.push({ x, y, text });
  };

  let i = 0;
  const n = content.length;
  while (i < n) {
    const ch = content[i];
    if (ch === "(") {
      // Literal con paréntesis anidados y escapes.
      const bytes: number[] = [];
      let depth = 1;
      i++;
      while (i < n && depth > 0) {
        const c = content[i];
        if (c === "\\") {
          const next = content[i + 1];
          if (next === undefined) break;
          if (/[0-7]/.test(next)) {
            const oct = /^[0-7]{1,3}/.exec(content.slice(i + 1, i + 4))![0];
            bytes.push(parseInt(oct, 8) & 0xff);
            i += 1 + oct.length;
            continue;
          }
          const map: Record<string, number> = { n: 10, r: 13, t: 9, b: 8, f: 12 };
          if (next === "\r") {
            i += content[i + 2] === "\n" ? 3 : 2;
            continue;
          }
          if (next === "\n") {
            i += 2;
            continue;
          }
          bytes.push(map[next] ?? next.charCodeAt(0));
          i += 2;
          continue;
        }
        if (c === "(") depth++;
        else if (c === ")") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
        bytes.push(c.charCodeAt(0) & 0xff);
        i++;
      }
      const str = { bytes };
      if (array) array.push(str);
      else operands.push(str);
      continue;
    }
    if (ch === "<" && content[i + 1] !== "<") {
      const end = content.indexOf(">", i);
      if (end === -1) break;
      const hex = content.slice(i + 1, end).replace(/\s+/g, "");
      const bytes: number[] = [];
      for (let k = 0; k < hex.length; k += 2) bytes.push(parseInt(hex.slice(k, k + 2).padEnd(2, "0"), 16));
      const str = { bytes };
      if (array) array.push(str);
      else operands.push(str);
      i = end + 1;
      continue;
    }
    if (ch === "[") {
      array = [];
      i++;
      continue;
    }
    if (ch === "]") {
      if (array) operands.push(array);
      array = undefined;
      i++;
      continue;
    }
    if (ch === "/") {
      const m = /^\/[^\s/<>[\]()]*/.exec(content.slice(i, i + 80));
      operands.push(m ? m[0] : "/");
      i += m ? m[0].length : 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    // Número u operador: hasta el próximo separador.
    const m = /^[^\s/<>[\]()]+/.exec(content.slice(i, i + 40));
    if (!m) {
      i++;
      continue;
    }
    const token = m[0];
    i += token.length;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      operands.push(Number(token));
      continue;
    }
    switch (token) {
      case "BT":
        x = 0;
        y = 0;
        break;
      case "Tf": {
        const name = operands[operands.length - 2];
        font = typeof name === "string" && name.startsWith("/") ? fonts.get(name.slice(1)) : undefined;
        break;
      }
      case "Td":
      case "TD": {
        const dx = operands[operands.length - 2];
        const dy = operands[operands.length - 1];
        if (typeof dx === "number" && typeof dy === "number") {
          x += dx;
          y += dy;
        }
        break;
      }
      case "Tm": {
        const e = operands[operands.length - 2];
        const f = operands[operands.length - 1];
        if (typeof e === "number" && typeof f === "number") {
          x = e;
          y = f;
        }
        break;
      }
      case "Tj": {
        const s = operands[operands.length - 1];
        if (s && typeof s === "object" && "bytes" in s) emit([s]);
        break;
      }
      case "TJ": {
        const a = operands[operands.length - 1];
        if (Array.isArray(a)) emit(a);
        break;
      }
      default:
        break;
    }
    operands.length = 0;
  }
  return runs;
}

/**
 * Textos de la primera página, en orden de lectura (de arriba abajo, de
 * izquierda a derecha). Los que comparten altura se unen en una sola línea.
 */
export function extractPdfLines(pdf: Buffer): string[] {
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new PdfTextError("no es un PDF");
  const objects = readObjects(pdf);

  let page: PdfObject | undefined;
  for (const obj of objects.values()) {
    if (/\/Type\s*\/Page(?![s\w])/.test(obj.dict)) {
      page = obj;
      break;
    }
  }
  if (!page) throw new PdfTextError("el PDF no tiene páginas");

  const contentsMatch = /\/Contents\s*(?:(\d+)\s+\d+\s+R|\[([^\]]*)\])/.exec(page.dict);
  if (!contentsMatch) throw new PdfTextError("la página no tiene contenido");
  const contentRefs = contentsMatch[1]
    ? [Number(contentsMatch[1])]
    : [...contentsMatch[2].matchAll(/(\d+)\s+\d+\s+R/g)].map((m) => Number(m[1]));

  const fonts = loadFonts(objects, page);
  const runs: TextRun[] = [];
  for (const ref of contentRefs) {
    const bytes = streamBytes(objects.get(ref));
    if (bytes) runs.push(...readTextRuns(bytes.toString("latin1"), fonts));
  }

  // Misma altura (con una tolerancia de media unidad) = misma línea.
  const rows: Array<{ y: number; runs: TextRun[] }> = [];
  for (const run of runs) {
    const row = rows.find((r) => Math.abs(r.y - run.y) < 0.5);
    if (row) row.runs.push(run);
    else rows.push({ y: run.y, runs: [run] });
  }
  rows.sort((a, b) => b.y - a.y);
  return rows.map((row) =>
    row.runs
      .sort((a, b) => a.x - b.x)
      .map((r) => r.text)
      .join(" "),
  );
}
