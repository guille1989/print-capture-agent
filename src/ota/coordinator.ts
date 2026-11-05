import type { UpdateSignal, UpdateStatus } from "./types.js";
import { downloadToFile } from "./download.js";
import { clearBootCheck, clearRolledBack, readBootCheck, readRolledBack, writePendingApply } from "./markers.js";
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
}

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

  function report(status: UpdateStatus, error?: string): void {
    options.onStatus?.(status, error);
  }

  async function consumeStartupMarkers(): Promise<void> {
    const rolled = await readRolledBack(paths.rolledBack);
    if (rolled) {
      report("rolled_back", rolled.reason);
      await clearRolledBack(paths.rolledBack);
    }

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
