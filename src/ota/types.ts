/** Señal OTA embebida en la respuesta del heartbeat (cloud Fase 1). */
export interface UpdateSignal {
  desiredVersion: string;
  url: string;
  sha256: string;
}

export type UpdateStatus =
  | "idle"
  | "downloading"
  | "verifying"
  | "pending_apply"
  | "ok"
  | "rolled_back"
  | "error";

/** Marker que el servicio consume para swap + reinicio del hijo Node. */
export interface PendingApplyMarker {
  version: string;
  sha256: string;
  stagedPath: string;
  requestedAt: string;
}

export interface BootCheckMarker {
  version: string;
  appliedAt: string;
}

/** Versiones que el agente no vuelve a intentar (fallaron y se revirtieron). */
export type BlockedVersions = Record<string, { until: string; reason: string }>;

export interface RolledBackMarker {
  fromVersion: string;
  toVersion: string | null;
  reason: string;
  at: string;
}
