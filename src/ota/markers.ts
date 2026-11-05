import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import type { BlockedVersions, BootCheckMarker, PendingApplyMarker, RolledBackMarker } from "./types.js";

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, path);
}

async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

export async function writePendingApply(path: string, marker: PendingApplyMarker): Promise<void> {
  await writeJsonAtomic(path, marker);
}

export async function readBootCheck(path: string): Promise<BootCheckMarker | undefined> {
  return readJson<BootCheckMarker>(path);
}

export async function clearBootCheck(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

export async function readRolledBack(path: string): Promise<RolledBackMarker | undefined> {
  return readJson<RolledBackMarker>(path);
}

export async function clearRolledBack(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/** Lista ilegible o ausente = vacía: un archivo roto nunca debe frenar el agente. */
export async function readBlocked(path: string): Promise<BlockedVersions> {
  try {
    const parsed = await readJson<BlockedVersions>(path);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function writeBlocked(path: string, value: BlockedVersions): Promise<void> {
  await writeJsonAtomic(path, value);
}
