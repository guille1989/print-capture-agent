import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const SHA256_HEX = /^[a-f0-9]{64}$/;

export function normalizeSha256(value: string): string | undefined {
  const hex = value.trim().toLowerCase();
  return SHA256_HEX.test(hex) ? hex : undefined;
}

export async function sha256File(path: string): Promise<string> {
  const body = await readFile(path);
  return createHash("sha256").update(body).digest("hex");
}

export async function verifyFileSha256(path: string, expectedHex: string): Promise<void> {
  const expected = normalizeSha256(expectedHex);
  if (!expected) throw new Error(`sha256 inválido en señal OTA: "${expectedHex}"`);
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(`sha256 no coincide (esperado ${expected}, actual ${actual})`);
  }
}
