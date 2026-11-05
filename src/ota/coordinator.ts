import type { UpdateSignal, UpdateStatus } from "./types.js";
import { downloadToFile } from "./download.js";
import {
  clearBootCheck,
  clearRolledBack,
  readBlocked,
  readBootCheck,
  readRolledBack,
  writeBlocked,
  writePendingApply,
} from "./markers.js";
import { otaPaths, type OtaPaths } from "./paths.js";
import { normalizeSha256, verifyFileSha256 } from "./verify.js";

export interface OtaCoordinatorOptions {
  dataDir: string;
  agentVersion: string;
  downloadTimeoutMs: number;
  /** Si false, ignora señales (tests / kill local). Default true. */
  enabled?: boolean;
  runtimeDir?: string;
  onStatus?: (status: UpdateStatus, error?: string) => void;
  /** Tras escribir pending-apply: por defecto sale para que el servicio aplique. */
  requestRestart?: () => void;
  /** Reloj inyectable (tests). */
  now?: () => number;
  /** Cuánto no se reintenta una versión que se revirtió. Default 24 h. */
  blockMs?: number;
}

/** Espera tras fallos consecutivos de la misma versión+hash (descarga, sha256…). */
const FAILURE_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000];
const DEFAULT_BLOCK_MS = 24 * 60 * 60_000;

/**
 * Cliente OTA Fase 1: download → verify sha256 → pending-apply → exit.
 * El swap + rollback lo hace el servicio Windows (evita lock de `app.mjs`).
 * Tras un swap el servicio deja `boot-check.json`; el agente nuevo lo borra
 * con `confirmBoot()` al lograr su primer heartbeat.
 */
export function createOtaCoordinator(options: OtaCoordinatorOptions) {
  const enabled = options.enabled !== false;
  const paths: OtaPaths = otaPaths(options.dataDir, options.runtimeDir);
  let inflight: Promise<void> | undefined;
  let lastDesired: string | undefined;
  let bootChecked = false;
  const now = options.now ?? (() => Date.now());
  const blockMs = options.blockMs ?? DEFAULT_BLOCK_MS;
  const failures = new Map<string, { count: number; nextAt: number }>();
  const warnedBlocked = new Set<string>();

  function report(status: UpdateStatus, error?: string): void {
    options.onStatus?.(status, error);
  }

  async function consumeStartupMarkers(): Promise<void> {
    const rolled = await readRolledBack(paths.rolledBack);
    if (rolled) {
      report("rolled_back", rolled.reason);
      await blockVersion(rolled.fromVersion, rolled.reason);
      await clearRolledBack(paths.rolledBack);
    }
  }

  /**
   * Una versión que arrancó mal y se revirtió no se vuelve a bajar: sin esto el
   * agente la pediría en el siguiente heartbeat y entraría en un bucle
   * descarga → swap → rollback. Persiste en disco porque el proceso se reinicia.
   */
  async function blockVersion(version: string, reason: string): Promise<void> {
    if (!version || version === "unknown") return;
    const blocked = await readBlocked(paths.blocked);
    blocked[version] = { until: new Date(now() + blockMs).toISOString(), reason: reason.slice(0, 200) };
    await writeBlocked(paths.blocked, blocked).catch((err) =>
      console.error("[ota] no se pudo guardar blocked-versions:", err),
    );
    console.warn(`[ota] versión ${version} bloqueada por ${Math.round(blockMs / 3_600_000)} h tras rollback`);
  }

  async function isBlocked(version: string): Promise<boolean> {
    const entry = (await readBlocked(paths.blocked))[version];
    if (!entry) return false;
    const until = Date.parse(entry.until);
    return Number.isFinite(until) && until > now();
  }

  /**
   * Confirma el arranque tras un update: borra `boot-check.json`. Hay que
   * llamarlo SOLO cuando el agente ya demostró estar sano (primer heartbeat
   * exitoso), no al arrancar: mientras el marker exista, el servicio revierte
   * a `.prev` si el proceso muere o no confirma dentro de la gracia.
   */
  async function confirmBoot(): Promise<void> {
    if (bootChecked) return;
    const boot = await readBootCheck(paths.bootCheck);
    bootChecked = true;
    if (!boot) return;
    if (boot.version === options.agentVersion) {
      report("ok");
      await clearBootCheck(paths.bootCheck);
      return;
    }
    // Este proceso no es la versión que el servicio dejó en boot-check (el
    // bundle publicado no coincide con su versión, o swap a medias): no se
    // confirma, así el servicio revierte a `.prev` al vencer la gracia.
    console.warn(
      `[ota] boot-check espera ${boot.version} pero este proceso es ${options.agentVersion} — sin confirmar`,
    );
  }

  async function applySignal(signal: UpdateSignal): Promise<void> {
    if (!enabled) return;
    if (signal.desiredVersion === options.agentVersion) return;
    if (!normalizeSha256(signal.sha256)) {
      report("error", "sha256 inválido en señal OTA");
      return;
    }
    if (!signal.url.trim() || !signal.desiredVersion.trim()) {
      report("error", "señal OTA incompleta");
      return;
    }
    if (await isBlocked(signal.desiredVersion)) {
      if (!warnedBlocked.has(signal.desiredVersion)) {
        warnedBlocked.add(signal.desiredVersion);
        console.warn(`[ota] ${signal.desiredVersion} está bloqueada (se revirtió antes) — se ignora la señal`);
      }
      return;
    }
    const failureKey = `${signal.desiredVersion}:${signal.sha256.toLowerCase()}`;
    const failed = failures.get(failureKey);
    if (failed && now() < failed.nextAt) return;
    if (lastDesired === signal.desiredVersion && inflight) return;
    lastDesired = signal.desiredVersion;

    if (inflight) return;
    inflight = (async () => {
      try {
        report("downloading");
        console.log(`[ota] descargando ${signal.desiredVersion}…`);
        await downloadToFile(signal.url, paths.stagingApp, options.downloadTimeoutMs);
        report("verifying");
        await verifyFileSha256(paths.stagingApp, signal.sha256);
        await writePendingApply(paths.pendingApply, {
          version: signal.desiredVersion,
          sha256: signal.sha256.toLowerCase(),
          stagedPath: paths.stagingApp,
          requestedAt: new Date().toISOString(),
        });
        report("pending_apply");
        console.log(`[ota] staging listo (${signal.desiredVersion}) — pidiendo reinicio al servicio`);
        (options.requestRestart ?? (() => process.exit(0)))();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error("[ota] update falló:", message);
        report("error", message.slice(0, 500));
        const count = (failures.get(failureKey)?.count ?? 0) + 1;
        const wait = FAILURE_BACKOFF_MS[Math.min(count - 1, FAILURE_BACKOFF_MS.length - 1)];
        failures.set(failureKey, { count, nextAt: now() + wait });
      } finally {
        inflight = undefined;
      }
    })();
    await inflight;
  }

  return {
    paths,
    consumeStartupMarkers,
    confirmBoot,
    applySignal,
    /** Para tests / inspección. */
    isBusy: () => inflight !== undefined,
  };
}

export type OtaCoordinator = ReturnType<typeof createOtaCoordinator>;
