import { createWriteStream, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { WriteStream } from "node:fs";

export interface RawCaptureLogger {
  logChunk(chunk: Buffer): void;
  close(): { binPath: string; txtPath: string; totalBytes: number };
}

/**
 * 16 bytes por fila, hex + una columna "impresa tal cual" (bytes no
 * imprimibles como `.`) — el formato clásico de `hexdump -C`, para poder
 * detectar códigos de control (ESC/POS, GS V, etc.) a simple vista sin
 * depender de que la terminal los renderice bien.
 */
function hexDump(chunk: Buffer): string {
  const rows: string[] = [];
  for (let offset = 0; offset < chunk.length; offset += 16) {
    const slice = chunk.subarray(offset, offset + 16);
    const hex = Array.from(slice, (b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = Array.from(slice, (b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    rows.push(`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return rows.join("\n");
}

/**
 * Vuelca lo que llega a un puerto/socket a dos archivos: uno binario
 * byte-exacto (lo que de verdad hay que usar para escribir un parser
 * después, decodificando con el encoding correcto una vez que se sepa
 * cuál es) y uno de texto con hex dump + una vista en latin1 (el encoding
 * que ya usa `portCapture.ts`), para poder mirar la captura a simple
 * vista sin herramientas extra.
 */
export function createRawCaptureLogger(labelForFilename: string, outDir = "data/captures"): RawCaptureLogger {
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const base = `${stamp}-${labelForFilename}`;
  const binPath = join(outDir, `${base}.bin`);
  const txtPath = join(outDir, `${base}.txt`);
  const binStream: WriteStream = createWriteStream(binPath);
  const txtStream: WriteStream = createWriteStream(txtPath);
  let totalBytes = 0;

  return {
    logChunk(chunk) {
      totalBytes += chunk.length;
      binStream.write(chunk);
      txtStream.write(`\n--- ${new Date().toISOString()} (${chunk.length} bytes) ---\n`);
      txtStream.write(hexDump(chunk));
      txtStream.write(`\nlatin1: ${JSON.stringify(chunk.toString("latin1"))}\n`);
    },
    close() {
      binStream.end();
      txtStream.end();
      return { binPath, txtPath, totalBytes };
    },
  };
}
