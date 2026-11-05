import { join } from "node:path";

/**
 * Paths OTA bajo ProgramData (`updates\`) y runtime (`app.mjs`).
 * En prod el servicio spawnea con cwd = `resources\agent\`, así que
 * `process.cwd()` apunta al runtime salvo override `AGENT_RUNTIME_DIR`.
 */
export function otaPaths(dataDir: string, runtimeDir = process.env.AGENT_RUNTIME_DIR || process.cwd()) {
  const updatesDir = join(dataDir, "updates");
  const stagingDir = join(updatesDir, "staging");
  return {
    updatesDir,
    stagingDir,
    stagingApp: join(stagingDir, "app.mjs"),
    pendingApply: join(updatesDir, "pending-apply.json"),
    bootCheck: join(updatesDir, "boot-check.json"),
    rolledBack: join(updatesDir, "rolled-back.json"),
    prevInUpdates: join(updatesDir, "app.mjs.prev"),
    runtimeDir,
    runtimeApp: join(runtimeDir, "app.mjs"),
    runtimePrev: join(runtimeDir, "app.mjs.prev"),
  };
}

export type OtaPaths = ReturnType<typeof otaPaths>;
