import { createWriteStream } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";

/**
 * Descarga `url` a `destPath` vía archivo temporal en el mismo directorio
 * (rename atómico en el mismo volumen).
 */
export async function downloadToFile(url: string, destPath: string, timeoutMs: number): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true });
  const tmpPath = `${destPath}.part`;
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) throw new Error(`download HTTP ${response.status}`);
    if (!response.body) throw new Error("download sin body");
    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    await pipeline(nodeStream, createWriteStream(tmpPath));
    await rename(tmpPath, destPath);
  } catch (err) {
    await unlink(tmpPath).catch(() => undefined);
    throw err;
  }
}
