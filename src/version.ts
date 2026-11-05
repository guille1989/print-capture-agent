import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Versión del agent JS reportada al cloud (heartbeat) y al pipe/tray.
 *
 * Fuente de verdad: `package.json` → `"version"`.
 * En el bundle piloto (`prepare-pilot.ps1`) se inyecta con
 * `--define:process.env.AGENT_VERSION="…"` para que el `app.mjs` no dependa
 * de un package.json junto al runtime. Override opcional: `AGENT_VERSION` en
 * el entorno de la máquina.
 */
export function resolveAgentVersion(): string {
  const fromEnv = process.env.AGENT_VERSION?.trim();
  if (fromEnv) return fromEnv;

  for (const candidate of packageJsonCandidates()) {
    try {
      if (!existsSync(candidate)) continue;
      const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
      if (pkg.name === "print-capture-agent" && typeof pkg.version === "string" && pkg.version.trim()) {
        return pkg.version.trim();
      }
    } catch {
      // sigue buscando
    }
  }
  return "0.0.0-dev";
}

function packageJsonCandidates(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(process.cwd(), "package.json"),
    join(here, "..", "package.json"),
    join(here, "package.json"),
  ];
}
