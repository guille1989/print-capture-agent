import { randomUUID } from "node:crypto";

import { AgentPipeServer, PortInfo } from "print-capture-agent-pipe-server";

import { capturePort } from "./capture/portCapture.js";
import { startSpoolCapture } from "./capture/spoolCapture.js";
import { captureTcp } from "./capture/tcpCapture.js";
import { CaptureHandle } from "./capture/types.js";
import { classifyFailure, computeBackoffMs } from "./cloud/backoff.js";
import { uploadTicket } from "./cloud/uploadClient.js";
import { ensureCredentials, type AgentCredentials } from "./cloud/credentials.js";
import { sendHeartbeat } from "./cloud/heartbeatClient.js";
import { config } from "./config.js";
import { scanPorts } from "./ports/portScanner.js";
import { LocalQueue } from "./queue/localQueue.js";

/**
 * El parseo (descripción, monto) vive del lado del servidor en la nube, no
 * acá. Este agente solo captura, encola localmente el texto crudo y lo
 * sube — nunca lo interpreta.
 */
interface RawTicket {
  // Generado acá, una sola vez por captura — se manda a la nube como
  // clave de idempotencia. Si la subida falla y se reintenta desde la
  // cola local, el mismo ticketId viaja de nuevo, y el servidor puede
  // reconocer que es un reintento en vez de crear un ticket duplicado.
  ticketId: string;
  port: string;
  capturedAt: string;
  // Captura serie/TCP: texto crudo. Captura de spool: `rawBase64` con los
  // bytes ESC/POS (que pueden ser una imagen raster) y `rawEncoding`. Va
  // siempre exactamente uno de los dos — sin `rawEncoding` la nube asume
  // texto (compatibilidad con agentes anteriores).
  rawText?: string;
  rawBase64?: string;
  rawEncoding?: "escpos";
}

const pipe = new AgentPipeServer({
  agentName: config.agentName,
  agentVersion: config.agentVersion,
  idleThresholdMs: config.idleThresholdMs,
  statusFilePath: config.statusFilePath,
});

const queue = new LocalQueue<RawTicket>(config.queueFilePath);
const captures = new Map<string, CaptureHandle>();
const knownPortIds = new Set<string>();
let credentials: AgentCredentials;

/** Los periféricos TCP son estáticos (no se "descubren"), así que se
 * reportan siempre junto con los puertos serie detectados dinámicamente. */
const tcpPorts: PortInfo[] = config.tcpPeripherals.map((peripheral) => ({
  id: peripheral.id,
  name: peripheral.id,
  description: peripheral.description,
  status: "idle",
  lastActivityAt: new Date().toISOString(),
}));

/**
 * Impresoras vigiladas por la captura de spool — se resuelven una vez al
 * arrancar (no cambian seguido) y se reportan como "puertos" junto con los
 * serie y los TCP. El `ticket_event` del pipe las pone en "active" sola.
 */
let spoolPorts: PortInfo[] = [];

/** Clave con la que vive el handle de la captura de spool en `captures` (no es un puerto real). */
const SPOOL_CAPTURE_ID = "__spool__";

async function handleCapturedTicket(
  rawPort: string,
  raw: string,
  encoding: "text" | "escpos" = "text",
): Promise<void> {
  const id = randomUUID();
  const capturedAt = new Date().toISOString();

  // El viewer se entera al toque de que "algo se capturó" — la descripción
  // y el monto van a aparecer solo en el dashboard de la nube, una vez
  // que el servidor lo parsee.
  pipe.emitTicket({ id, timestamp: capturedAt, port: rawPort });

  const payload: RawTicket =
    encoding === "escpos"
      ? { ticketId: id, port: rawPort, capturedAt, rawBase64: raw, rawEncoding: "escpos" }
      : { ticketId: id, port: rawPort, capturedAt, rawText: raw };

  await queue.enqueue(id, payload);
  console.log(`[agent] ticket capturado en ${rawPort} (${encoding}), encolado para parsear en la nube`);
}

/**
 * Política de recuperación: los callbacks de captura y el escaneo de
 * puertos son fire-and-forget por naturaleza (no hay a quién devolverle
 * un error — el evento del puerto o el timer ya siguieron de largo), así
 * que un rechazo sin manejar acá se convierte en una promesa rechazada
 * sin capturar, que en Node termina el proceso entero. Nada de lo que
 * puede fallar acá (un disco lleno, un hiccup escaneando puertos) debería
 * tirar abajo TODO el agente — hoy no hay un servicio/supervisor que lo
 * reinicie solo, así que un crash significa capturar cero tickets hasta
 * que alguien lo note y lo levante a mano. En cambio: se loguea, se
 * reporta como error en el pipe (así se ve en el viewer), y sigue
 * corriendo — el próximo intento programado (scan de puertos, o el
 * próximo ticket capturado) puede seguir funcionando aunque este haya
 * fallado.
 */
function runDetached(taskName: string, task: () => Promise<void>): void {
  task().catch((err) => {
    console.error(`[agent] error inesperado en ${taskName}:`, err);
    pipe.setStatus("error", `Error interno en ${taskName} — ver logs del agente`);
  });
}

async function syncQueueToCloud(): Promise<void> {
  // Solo lo que ya venció su backoff — un ticket con un error persistente
  // no vuelve a intentarse en cada vuelta junto con el resto (ver
  // `cloud/backoff.ts`).
  const due = queue.getDue();
  if (due.length === 0) return;

  let anyFailure = false;

  // Un ticket a la vez, secuencial — nunca en paralelo entre sí.
  for (const record of due) {
    const result = await uploadTicket(
      {
        url: config.cloudUploadUrl,
        apiKey: credentials.apiKey,
        timeoutMs: config.cloudUploadTimeoutMs,
      },
      record.payload,
    );

    if (result.ok) {
      await queue.markSent(record.id);
    } else {
      anyFailure = true;
      const kind = classifyFailure(result.status);
      const attemptsAfterThis = record.attempts + 1;
      const delayMs = computeBackoffMs(attemptsAfterThis, kind, config.cloudSyncIntervalMs);
      const nextRetryAt = new Date(Date.now() + delayMs).toISOString();
      await queue.markFailed(record.id, nextRetryAt);

      const kindLabel =
        kind === "permanent"
          ? "permanente, no va a cambiar solo"
          : kind === "delayed"
            ? "403 — API key propagando o mal configurada, se reintenta lento"
            : "transitorio";
      console.error(
        `[agent] falló la subida de ${record.id} (${kindLabel}): ` +
          `${result.error ?? `HTTP ${result.status}`} — reintenta en ${Math.round(delayMs / 1000)}s`,
      );
    }
  }

  pipe.setStatus(
    anyFailure ? "error" : "ok",
    anyFailure ? "No se pudo conectar al backend en la nube" : undefined,
  );
}

function scheduleHeartbeatLoop(): void {
  setTimeout(() => {
    sendHeartbeat(
      config.heartbeatUrl,
      credentials.apiKey,
      { name: credentials.name, version: config.agentVersion, location: config.location },
      config.cloudUploadTimeoutMs,
    )
      .catch((err) => console.error("[agent] no se pudo enviar el heartbeat:", err))
      .finally(scheduleHeartbeatLoop);
  }, config.heartbeatIntervalMs);
}

async function sendInitialHeartbeatWithRetry(): Promise<void> {
  // Ventanas más largas que las de un error de red: un agente recién
  // activado choca con un 403 hasta que propaga su API key (minutos). Si
  // igual no entra acá, el loop periódico (cada 60s) lo sigue intentando.
  const retryDelaysMs = [0, 5_000, 15_000, 30_000, 60_000];
  let lastError: unknown;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    try {
      await sendHeartbeat(
        config.heartbeatUrl,
        credentials.apiKey,
        { name: credentials.name, version: config.agentVersion, location: config.location },
        config.cloudUploadTimeoutMs,
      );
      return;
    } catch (err) {
      lastError = err;
      console.error(`[agent] no se pudo enviar el heartbeat inicial${delayMs ? ` tras reintento de ${delayMs / 1000}s` : ""}:`, err);
    }
  }
  throw lastError;
}

async function refreshPorts(): Promise<void> {
  const detected = await scanPorts();

  // Log de detección — para poder confirmar por consola qué encontró el
  // agente sin necesidad de tener abierto el viewer.
  for (const port of detected) {
    if (!knownPortIds.has(port.id)) {
      knownPortIds.add(port.id);
      console.log(`[ports] detectado: ${port.id} — ${port.description}`);
    }
  }
  for (const portId of knownPortIds) {
    if (!detected.some((p) => p.id === portId)) {
      knownPortIds.delete(portId);
      console.log(`[ports] ya no disponible: ${portId}`);
    }
  }

  const serialPorts: PortInfo[] = detected.map((port) => ({
    id: port.id,
    name: port.name,
    description: port.description,
    status: captures.has(port.id) ? "active" : "idle",
    lastActivityAt: new Date().toISOString(),
  }));

  // Los periféricos TCP son estáticos, pero su estado (active/idle) sí
  // refleja si la conexión está viva ahora mismo.
  const reportedTcpPorts = tcpPorts.map((port) => ({
    ...port,
    status: captures.has(port.id) ? ("active" as const) : ("idle" as const),
  }));

  pipe.setPorts([...serialPorts, ...reportedTcpPorts, ...spoolPorts]);

  // Arranca a escuchar los puertos serie nuevos que no estuviéramos ya
  // capturando. Gateado por ENABLE_CAPTURE: hasta no validar los supuestos
  // de captura contra hardware real, el agente solo identifica puertos,
  // no los lee.
  if (config.captureEnabled) {
    for (const port of detected) {
      if (captures.has(port.id)) continue;
      const handle = capturePort(port.id, (rawText) => {
        runDetached("handleCapturedTicket", () => handleCapturedTicket(port.id, rawText));
      });
      captures.set(port.id, handle);
    }
  }

  // Deja de escuchar los puertos serie que desaparecieron — los TCP y la
  // captura de spool no entran acá porque no se "detectan" en cada vuelta.
  for (const [portId, handle] of captures) {
    if (portId === SPOOL_CAPTURE_ID) continue;
    const stillSerial = detected.some((p) => p.id === portId);
    const isTcp = tcpPorts.some((p) => p.id === portId);
    if (!stillSerial && !isTcp) {
      handle.close();
      captures.delete(portId);
    }
  }
}

function startTcpCaptures(): void {
  if (!config.captureEnabled) return;
  for (const peripheral of config.tcpPeripherals) {
    const handle = captureTcp(peripheral, (rawText) => {
      runDetached("handleCapturedTicket", () => handleCapturedTicket(peripheral.id, rawText));
    });
    captures.set(peripheral.id, handle);
  }
}

/**
 * Arranca la captura de spool (el mecanismo general). Es async porque
 * consulta el spooler por WMI al inicializar, así que se espera antes del
 * primer `refreshPorts()` para que las impresoras ya salgan en el snapshot
 * inicial de puertos.
 */
async function initSpoolCapture(): Promise<void> {
  if (!config.captureEnabled || !config.spoolCaptureEnabled) return;
  const { handle, printers } = await startSpoolCapture((printerName, rawBase64) => {
    runDetached("handleCapturedTicket", () => handleCapturedTicket(printerName, rawBase64, "escpos"));
  });
  captures.set(SPOOL_CAPTURE_ID, handle);
  spoolPorts = printers.map((name) => ({
    id: name,
    name,
    description: "Impresora (captura de spool)",
    status: "idle",
    lastActivityAt: new Date().toISOString(),
  }));
}

/**
 * A diferencia de `setInterval`, esto nunca arranca un ciclo nuevo antes
 * de que termine el anterior — si una subida tarda más que
 * `cloudSyncIntervalMs` (una conexión colgada, por ejemplo), un
 * `setInterval` seguiría apilando llamadas nuevas por encima; acá recién
 * se programa la siguiente vuelta cuando la actual termina.
 */
function scheduleSyncLoop(): void {
  setTimeout(() => {
    syncQueueToCloud()
      .catch((err) => {
        console.error("[agent] error inesperado sincronizando con la nube:", err);
        pipe.setStatus("error", "Error interno sincronizando con la nube — ver logs del agente");
      })
      .finally(scheduleSyncLoop);
  }, config.cloudSyncIntervalMs);
}

/**
 * Mismo patrón que `scheduleSyncLoop`: con `setInterval` dos escaneos
 * podían solaparse si `scanPorts()` (WMI / `SerialPort.list()`) tardaba más
 * que `portScanIntervalMs` — el segundo escaneo vería un puerto que el
 * primero ya está por abrir, lo abriría de nuevo y el handle viejo quedaba
 * huérfano en `captures` al ser sobrescrito. Acá recién se programa la
 * siguiente vuelta cuando la actual termina.
 */
function schedulePortScanLoop(): void {
  setTimeout(() => {
    refreshPorts()
      .catch((err) => {
        console.error("[agent] error inesperado escaneando puertos:", err);
        pipe.setStatus("error", "Error interno escaneando puertos — ver logs del agente");
      })
      .finally(schedulePortScanLoop);
  }, config.portScanIntervalMs);
}

async function main(): Promise<void> {
  // Estos dos sí son fatales si fallan: sin la cola cargada o sin poder
  // levantar el pipe (ej. porque ya hay otra instancia corriendo), no hay
  // una forma segura de seguir — se deja que `main().catch()` de abajo
  // termine el proceso. Todo lo demás (escanear puertos, capturar,
  // sincronizar) usa `runDetached` para no arrastrar eso al arranque.
  credentials = await ensureCredentials({
    path: config.credentialsFilePath,
    envApiKey: config.cloudApiKey,
    activationUrl: config.activationUrl,
    timeoutMs: config.cloudUploadTimeoutMs,
  });
  await queue.load();
  pipe.start();
  startTcpCaptures();

  try {
    await initSpoolCapture();
  } catch (err) {
    console.error("[agent] error inesperado arrancando la captura de spool:", err);
    pipe.setStatus("error", "Error interno arrancando la captura de spool — ver logs del agente");
  }

  try {
    await refreshPorts();
  } catch (err) {
    console.error("[agent] error inesperado en el primer escaneo de puertos:", err);
    pipe.setStatus("error", "Error interno escaneando puertos — ver logs del agente");
  }
  schedulePortScanLoop();
  scheduleSyncLoop();
  await sendInitialHeartbeatWithRetry().catch((err) => console.error("[agent] se agotaron los reintentos del heartbeat inicial:", err));
  scheduleHeartbeatLoop();

  console.log("[agent] print-capture-agent arrancado");
}

process.on("SIGINT", () => {
  for (const handle of captures.values()) handle.close();
  pipe.stop();
  process.exit(0);
});

main().catch((err) => {
  console.error("[agent] error fatal en el arranque:", err);
  process.exit(1);
});
