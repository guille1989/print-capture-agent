// ../print-capture-agent/src/index.ts
import { randomUUID as randomUUID2 } from "node:crypto";

// dist/pipeServer.js
import net from "node:net";

// dist/protocol.js
var PIPE_NAME = String.raw`\\.\pipe\print-capture-agent`;

// dist/pipeServer.js
var SNAPSHOT_EVENTS_LIMIT = 20;
var DEFAULT_IDLE_THRESHOLD_MS = 5 * 60 * 1e3;
var IDLE_CHECK_INTERVAL_MS = 30 * 1e3;
var AgentPipeServer = class {
  pipeName;
  idleThresholdMs;
  idleCheckIntervalMs;
  agentInfo;
  ports = /* @__PURE__ */ new Map();
  recentEvents = [];
  server = null;
  clients = /* @__PURE__ */ new Set();
  idleCheckTimer = null;
  constructor(options = {}) {
    this.pipeName = options.pipeName ?? PIPE_NAME;
    this.idleThresholdMs = options.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
    this.idleCheckIntervalMs = options.idleCheckIntervalMs ?? IDLE_CHECK_INTERVAL_MS;
    this.agentInfo = {
      name: options.agentName ?? "print-capture-agent",
      version: options.agentVersion ?? "0.0.0",
      status: "ok"
    };
  }
  start() {
    if (this.server)
      return;
    this.server = net.createServer((socket) => this.handleConnection(socket));
    this.server.on("error", (err) => {
      console.error(`[pipe-server] error en ${this.pipeName}:`, err.message);
    });
    this.server.listen(this.pipeName, () => {
      console.log(`[pipe-server] escuchando en ${this.pipeName}`);
    });
    this.idleCheckTimer = setInterval(() => this.checkIdlePorts(), this.idleCheckIntervalMs);
  }
  stop() {
    if (this.idleCheckTimer) {
      clearInterval(this.idleCheckTimer);
      this.idleCheckTimer = null;
    }
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.server?.close();
    this.server = null;
  }
  /** Reemplaza la lista completa de puertos (alta/baja incluida) y notifica un snapshot. */
  setPorts(ports) {
    this.ports = new Map(ports.map((port) => [port.id, port]));
    this.broadcast(this.buildSnapshot());
  }
  /** Actualiza (o agrega) un único puerto sin tocar el resto. */
  updatePort(port) {
    this.ports.set(port.id, port);
    this.broadcast({ type: "port_update", port });
  }
  /** Registra que se capturó un ticket: lo agrega al feed y marca su puerto como activo. */
  emitTicket(event) {
    this.recentEvents.unshift(event);
    this.recentEvents.length = Math.min(this.recentEvents.length, SNAPSHOT_EVENTS_LIMIT);
    const port = this.ports.get(event.port);
    if (port) {
      this.updatePort({ ...port, status: "active", lastActivityAt: event.timestamp });
    }
    this.broadcast({ type: "ticket_event", event });
  }
  /** Reporta la salud general del agente (ej. falla al subir a la nube). */
  setStatus(status, message) {
    this.agentInfo = { ...this.agentInfo, status };
    this.broadcast({ type: "agent_status", status, message });
  }
  handleConnection(socket) {
    this.clients.add(socket);
    console.log(`[pipe-server] viewer conectado (${this.clients.size} activo(s))`);
    this.send(socket, this.buildSnapshot());
    socket.on("close", () => {
      this.clients.delete(socket);
      console.log(`[pipe-server] viewer desconectado (${this.clients.size} activo(s))`);
    });
    socket.on("error", (err) => {
      console.error("[pipe-server] error de socket:", err.message);
    });
  }
  checkIdlePorts() {
    const now = Date.now();
    for (const port of this.ports.values()) {
      if (port.status !== "active")
        continue;
      const elapsed = now - new Date(port.lastActivityAt).getTime();
      if (elapsed > this.idleThresholdMs) {
        this.updatePort({ ...port, status: "idle" });
      }
    }
  }
  buildSnapshot() {
    return {
      type: "snapshot",
      agent: this.agentInfo,
      ports: Array.from(this.ports.values()),
      recentEvents: this.recentEvents
    };
  }
  broadcast(message) {
    for (const client of this.clients) {
      this.send(client, message);
    }
  }
  send(socket, message) {
    socket.write(`${JSON.stringify(message)}
`);
  }
};

// ../print-capture-agent/src/capture/portCapture.ts
import { SerialPort } from "serialport";

// ../print-capture-agent/src/config.ts
function parseTcpPeripherals() {
  const raw = process.env.TCP_PERIPHERALS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error("[config] TCP_PERIPHERALS no es JSON v\xE1lido, se ignora:", err);
    return [];
  }
}
function apiSibling(path2) {
  try {
    const url = new URL(process.env.CLOUD_UPLOAD_URL ?? "https://example.invalid/api/tickets");
    url.pathname = url.pathname.replace(/tickets\/?$/, path2);
    return url.toString();
  } catch {
    return `https://example.invalid/api/${path2}`;
  }
}
function optionalNumber(name) {
  const raw = process.env[name];
  if (!raw) return void 0;
  const value = Number(raw);
  return Number.isFinite(value) ? value : void 0;
}
function parseStringArray(raw) {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch (err) {
    console.error("[config] no se pudo parsear como lista JSON, se ignora:", raw, err);
    return [];
  }
}
var config = {
  agentName: "print-capture-agent",
  agentVersion: "0.2.0",
  cloudUploadUrl: process.env.CLOUD_UPLOAD_URL ?? "https://example.invalid/api/tickets",
  cloudApiKey: process.env.CLOUD_API_KEY,
  activationUrl: process.env.CLOUD_ACTIVATION_URL ?? apiSibling("agents/activate"),
  heartbeatUrl: process.env.CLOUD_HEARTBEAT_URL ?? apiSibling("agents/heartbeat"),
  credentialsFilePath: process.env.AGENT_CREDENTIALS_FILE ?? "./data/credentials.json",
  heartbeatIntervalMs: Number(process.env.HEARTBEAT_INTERVAL_MS) || 60 * 1e3,
  // La ubicación se administra normalmente desde InnoApp Web. Si esta
  // instalación no declara ninguna variable, se omite del heartbeat para
  // no borrar la ubicación persistida por el negocio con un objeto vacío.
  location: (() => {
    const value = {
      label: process.env.AGENT_LOCATION_LABEL,
      city: process.env.AGENT_CITY,
      lat: optionalNumber("AGENT_LAT"),
      lng: optionalNumber("AGENT_LNG")
    };
    return Object.values(value).some((item) => item !== void 0) ? value : void 0;
  })(),
  queueFilePath: process.env.QUEUE_FILE ?? "./data/queue.json",
  idleThresholdMs: 5 * 60 * 1e3,
  portScanIntervalMs: 10 * 1e3,
  cloudSyncIntervalMs: 15 * 1e3,
  /**
   * Si el backend no responde dentro de este tiempo, se aborta la subida y
   * se trata como falla transitoria (reintenta por backoff) — sin esto, un
   * `fetch` colgado bloquea `syncQueueToCloud` para siempre y ningún
   * ticket posterior en la cola llega a subirse.
   */
  cloudUploadTimeoutMs: Number(process.env.CLOUD_UPLOAD_TIMEOUT_MS) || 20 * 1e3,
  /**
   * Si no aparece el marcador de corte de papel (GS V) y el buffer de un
   * puerto serie supera esto, se entrega igual en vez de acumular para
   * siempre — valor generoso para un ticket de texto plano (varios KB de
   * margen), pero sin validar contra hardware real todavía.
   */
  ticketBufferMaxBytes: 8 * 1024,
  /**
   * Si no llega nada nuevo en un puerto serie durante este tiempo y hay
   * algo sin cerrar en el buffer, se entrega por silencio — cubre el caso
   * de un POS que nunca manda GS V. Sin validar contra hardware real: si
   * en la práctica una impresora real hace pausas más largas que esto
   * entre líneas de un mismo ticket, hay que subir este valor.
   */
  ticketSilenceTimeoutMs: 3 * 1e3,
  /**
   * Mientras esto sea false, el agente detecta y reporta todos los puertos
   * pero no abre ninguno para leer datos — etapa deliberada mientras los
   * supuestos de captura (marcador de fin de ticket, baud rate, encoding)
   * siguen sin validar contra hardware real. Poner ENABLE_CAPTURE=true
   * cuando se quiera prender la lectura.
   */
  captureEnabled: process.env.ENABLE_CAPTURE === "true",
  tcpPeripherals: parseTcpPeripherals(),
  /**
   * Captura a través del spooler de Windows — el mecanismo general: vigila
   * `spool\PRINTERS` y lee el `.SPL` de cada trabajo RAW, sin importar cómo
   * esté conectada la impresora (USB, serie, red). Gateado además por
   * `captureEnabled`. Se apaga con `ENABLE_SPOOL_CAPTURE=false` en un equipo
   * donde solo se quiera la captura serie/TCP.
   */
  spoolCaptureEnabled: process.env.ENABLE_SPOOL_CAPTURE !== "false",
  spoolDir: process.env.SPOOL_DIR ?? `${process.env.SystemRoot ?? "C:\\Windows"}\\System32\\spool\\PRINTERS`,
  /**
   * Activa "conservar documentos impresos" en las impresoras vigiladas para
   * que el `.SPL` no se borre antes de leerlo. Default `true`; ponerlo en
   * `false` solo si no se quiere que el agente toque la config de las
   * impresoras (a costa de perder tickets de impresoras rápidas).
   */
  spoolKeepPrintedJobs: process.env.SPOOL_KEEP_PRINTED_JOBS !== "false",
  /** Whitelist opcional de impresoras a vigilar; vacío = todas las locales no virtuales. */
  spoolPrinters: parseStringArray(process.env.SPOOL_PRINTERS),
  /**
   * Máximo tamaño de un `.SPL` a capturar. Un ticket con logo raster ronda
   * los 200 KB; por encima de esto es una impresión que no es un ticket. Va
   * alineado con el límite de `ingest` en la nube.
   */
  spoolMaxJobBytes: optionalNumber("SPOOL_MAX_JOB_BYTES") ?? 6 * 1024 * 1024
};

// ../print-capture-agent/src/capture/ticketBufferer.ts
function createTicketBufferer(options) {
  const { marker, maxBufferBytes, silenceTimeoutMs, onTicketText, onWarning } = options;
  let buffer = "";
  let silenceTimer = null;
  function clearSilenceTimer() {
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }
  function rearmSilenceTimer() {
    clearSilenceTimer();
    if (buffer.length === 0) return;
    silenceTimer = setTimeout(() => {
      onWarning?.(`silencio de ${silenceTimeoutMs}ms sin marcador, se entrega igual (${buffer.length} bytes)`);
      const text = buffer;
      buffer = "";
      onTicketText(text);
    }, silenceTimeoutMs);
  }
  return {
    feed(text) {
      buffer += text;
      let markerIndex = buffer.indexOf(marker);
      while (markerIndex !== -1) {
        const ticketEnd = markerIndex + marker.length;
        onTicketText(buffer.slice(0, ticketEnd));
        buffer = buffer.slice(ticketEnd);
        markerIndex = buffer.indexOf(marker);
      }
      if (buffer.length > maxBufferBytes) {
        onWarning?.(`buffer super\xF3 ${maxBufferBytes} bytes sin marcador, se entrega igual`);
        onTicketText(buffer);
        buffer = "";
      }
      rearmSilenceTimer();
    },
    dispose() {
      clearSilenceTimer();
    }
  };
}

// ../print-capture-agent/src/capture/portCapture.ts
var CUT_PAPER_MARKER = "V";
function capturePort(path2, onTicketText, options = {}) {
  const port = new SerialPort({ path: path2, baudRate: options.baudRate ?? 9600, autoOpen: true });
  const bufferer = createTicketBufferer({
    marker: CUT_PAPER_MARKER,
    maxBufferBytes: config.ticketBufferMaxBytes,
    silenceTimeoutMs: config.ticketSilenceTimeoutMs,
    onTicketText,
    onWarning: (message) => console.warn(`[capture] ${path2}: ${message}`)
  });
  port.on("data", (chunk) => bufferer.feed(chunk.toString("latin1")));
  port.on("error", (err) => {
    console.error(`[capture] error en ${path2}:`, err.message);
  });
  return {
    close: () => {
      bufferer.dispose();
      if (port.isOpen) port.close();
    }
  };
}

// ../print-capture-agent/src/capture/spoolCapture.ts
import { execFile } from "node:child_process";
import { watch } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

// ../print-capture-agent/src/capture/spoolFile.ts
var GS_V = Buffer.from([29, 86]);
var RAW_DATATYPES = /* @__PURE__ */ new Set(["RAW", "RAW [FF APPENDED]", "RAW [FF AUTO]", "RAW [FF NONE]", "TEXT"]);
var GRAPHIC_DATATYPE_PREFIXES = ["EMF", "NT EMF", "XPS", "XPS_PASS", "XPS2GDI"];
function isRawDatatype(datatype) {
  if (!datatype) return false;
  return RAW_DATATYPES.has(datatype.trim().toUpperCase());
}
function isGraphicDatatype(datatype) {
  if (!datatype) return false;
  const normalized = datatype.trim().toUpperCase();
  return GRAPHIC_DATATYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
function looksLikeEmf(head) {
  return head.subarray(0, 4096).includes(Buffer.from(" EMF", "latin1"));
}
function classifySpool(args) {
  if (isGraphicDatatype(args.datatype)) {
    return { kind: "skip", reason: `datatype gr\xE1fico (${args.datatype.trim()})` };
  }
  if (looksLikeEmf(args.head)) {
    return { kind: "skip", reason: "contenido EMF (documento gr\xE1fico, no ticket)" };
  }
  if (args.datatype && !isRawDatatype(args.datatype)) {
    return { kind: "skip", reason: `datatype no soportado (${args.datatype.trim()})` };
  }
  return { kind: "raw" };
}
var MIN_MEANINGFUL_BYTES = 16;
function meaningfulByteCount(seg) {
  let count = 0;
  for (const b of seg) if (b >= 32 && b !== 127) count++;
  return count;
}
function splitEscpos(content) {
  const segments = [];
  let start = 0;
  let cut = content.indexOf(GS_V, start);
  while (cut !== -1) {
    const mode = content[cut + 2];
    const cutLength = mode === 65 || mode === 66 ? 4 : 3;
    const end = Math.min(cut + cutLength, content.length);
    segments.push(content.subarray(start, end));
    start = end;
    cut = content.indexOf(GS_V, start);
  }
  if (start < content.length) segments.push(content.subarray(start));
  return segments.filter((seg) => meaningfulByteCount(seg) >= MIN_MEANINGFUL_BYTES);
}

// ../print-capture-agent/src/capture/spoolCapture.ts
var execFileAsync = promisify(execFile);
var SPL_FILE_RE = /^(\d{5})\.SPL$/i;
var SETTLE_MS = 1e3;
var POWERSHELL_TIMEOUT_MS = 1e4;
var HEAD_BYTES = 4096;
var VIRTUAL_PRINTER_HINTS = [
  "microsoft print to pdf",
  "microsoft xps document writer",
  "onenote",
  "fax",
  "adobe pdf",
  "pdf24",
  "bullzip",
  "pdfcreator"
];
var VIRTUAL_PORT_RE = /^(nul:|portprompt:|file:|xpsport:|onenote|nul\b)/i;
async function runPowershell(script) {
  const { stdout: stdout2 } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    timeout: POWERSHELL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024
  });
  return stdout2.trim();
}
function parseJsonRows(stdout2) {
  if (!stdout2) return [];
  const parsed = JSON.parse(stdout2);
  return Array.isArray(parsed) ? parsed : [parsed];
}
async function listLocalPrinters() {
  const script = "Get-CimInstance Win32_Printer | Where-Object { -not $_.Network } | Select-Object Name,PortName | ConvertTo-Json -Compress";
  try {
    const rows = parseJsonRows(await runPowershell(script));
    return rows.map((row) => ({ name: String(row.Name ?? ""), port: String(row.PortName ?? "") })).filter(({ name, port }) => {
      if (!name) return false;
      if (VIRTUAL_PRINTER_HINTS.some((hint) => name.toLowerCase().includes(hint))) return false;
      if (VIRTUAL_PORT_RE.test(port)) return false;
      return true;
    }).map(({ name }) => name);
  } catch (err) {
    console.error("[spool] no se pudieron enumerar las impresoras:", err instanceof Error ? err.message : err);
    return [];
  }
}
async function enableKeepPrintedJobs(printers) {
  for (const name of printers) {
    const safe = name.replace(/'/g, "''");
    const script = `$p = Get-CimInstance Win32_Printer -Filter "Name='${safe}'"; if ($p -and -not $p.KeepPrintedJobs) { $p.KeepPrintedJobs = $true; Set-CimInstance -InputObject $p }`;
    try {
      await runPowershell(script);
    } catch (err) {
      console.error(`[spool] no se pudo activar "conservar impresos" en ${name}:`, err instanceof Error ? err.message : err);
    }
  }
}
async function fetchJobMeta(jobId) {
  const script = "Get-CimInstance Win32_PrintJob | Select-Object JobId,Name,DataType,Document | ConvertTo-Json -Compress";
  try {
    for (const row of parseJsonRows(await runPowershell(script))) {
      if (Number(row.JobId) !== jobId) continue;
      const rawName = typeof row.Name === "string" ? row.Name : "";
      const printer = rawName.includes(",") ? rawName.slice(0, rawName.lastIndexOf(",")).trim() : rawName.trim();
      return {
        printer: printer || "spool",
        datatype: typeof row.DataType === "string" ? row.DataType : void 0,
        document: typeof row.Document === "string" ? row.Document : void 0
      };
    }
  } catch (err) {
    console.error(`[spool] no se pudo consultar el trabajo ${jobId}:`, err instanceof Error ? err.message : err);
  }
  return void 0;
}
async function removeJob(printer, jobId) {
  if (!config.spoolKeepPrintedJobs) return;
  const safe = printer.replace(/'/g, "''");
  try {
    await runPowershell(`Remove-PrintJob -PrinterName '${safe}' -ID ${jobId} -ErrorAction SilentlyContinue`);
  } catch {
  }
}
async function startSpoolCapture(onTicket) {
  const noop = { handle: { close() {
  } }, printers: [] };
  if (process.platform !== "win32") {
    console.log("[spool] la captura de spool solo est\xE1 disponible en Windows \u2014 omitida");
    return noop;
  }
  const printers = config.spoolPrinters.length > 0 ? config.spoolPrinters : await listLocalPrinters();
  if (printers.length === 0) {
    console.warn("[spool] no hay impresoras locales para vigilar \u2014 captura de spool inactiva");
    return noop;
  }
  if (config.spoolKeepPrintedJobs) await enableKeepPrintedJobs(printers);
  const processed = /* @__PURE__ */ new Set();
  const pending = /* @__PURE__ */ new Map();
  let closed = false;
  async function processJob(jobId) {
    if (closed || processed.has(jobId)) return;
    const splPath = path.join(config.spoolDir, `${String(jobId).padStart(5, "0")}.SPL`);
    let content;
    try {
      content = await readFile(splPath);
    } catch {
      return;
    }
    processed.add(jobId);
    const meta = await fetchJobMeta(jobId);
    const printer = meta?.printer ?? "spool";
    if (config.spoolPrinters.length > 0 && !config.spoolPrinters.includes(printer)) {
      await removeJob(printer, jobId);
      return;
    }
    const decision = classifySpool({ datatype: meta?.datatype, head: content.subarray(0, HEAD_BYTES) });
    if (decision.kind === "skip") {
      console.log(`[spool] trabajo ${jobId} (${printer}) ignorado: ${decision.reason}`);
      await removeJob(printer, jobId);
      return;
    }
    if (content.length > config.spoolMaxJobBytes) {
      console.warn(
        `[spool] trabajo ${jobId} (${printer}) ignorado: ${content.length} bytes supera el m\xE1ximo (${config.spoolMaxJobBytes})`
      );
      await removeJob(printer, jobId);
      return;
    }
    const tickets = splitEscpos(content);
    for (const ticket of tickets) onTicket(printer, ticket.toString("base64"));
    console.log(
      tickets.length > 0 ? `[spool] trabajo ${jobId} (${printer}): ${tickets.length} ticket(s) capturado(s), ${content.length} bytes` : `[spool] trabajo ${jobId} (${printer}): RAW pero sin contenido de ticket reconocible (${content.length} bytes)`
    );
    await removeJob(printer, jobId);
  }
  function schedule(jobId) {
    if (closed || processed.has(jobId)) return;
    const existing = pending.get(jobId);
    if (existing) clearTimeout(existing);
    pending.set(
      jobId,
      setTimeout(() => {
        pending.delete(jobId);
        void processJob(jobId).catch(
          (err) => console.error(`[spool] error procesando el trabajo ${jobId}:`, err instanceof Error ? err.message : err)
        );
      }, SETTLE_MS)
    );
  }
  try {
    for (const entry of await readdir(config.spoolDir)) {
      const match = entry.match(SPL_FILE_RE);
      if (match) schedule(Number(match[1]));
    }
  } catch (err) {
    const code = err.code;
    if (code === "EPERM" || code === "EACCES") {
      console.error(
        `[spool] sin permiso para leer ${config.spoolDir} \u2014 el agente tiene que correr como administrador o servicio (LocalSystem). Captura de spool inactiva.`
      );
      return noop;
    }
    console.error("[spool] no se pudo listar la carpeta de spool:", err instanceof Error ? err.message : err);
  }
  let watcher;
  try {
    watcher = watch(config.spoolDir, (_event, filename) => {
      if (!filename) return;
      const match = String(filename).match(SPL_FILE_RE);
      if (match) schedule(Number(match[1]));
    });
  } catch (err) {
    console.error("[spool] no se pudo vigilar la carpeta de spool:", err instanceof Error ? err.message : err);
    return noop;
  }
  watcher.on("error", (err) => console.error("[spool] error del watcher:", err.message));
  console.log(`[spool] vigilando ${config.spoolDir} \u2014 ${printers.length} impresora(s): ${printers.join(", ")}`);
  return {
    handle: {
      close() {
        closed = true;
        for (const timer of pending.values()) clearTimeout(timer);
        pending.clear();
        watcher.close();
      }
    },
    printers
  };
}

// ../print-capture-agent/src/capture/tcpCapture.ts
import net2 from "node:net";
var RECONNECT_DELAY_MS = 5e3;
function captureTcp(peripheral, onData) {
  let socket = null;
  let closed = false;
  let reconnectTimer = null;
  const bufferer = createTicketBufferer({
    marker: "\n",
    maxBufferBytes: config.ticketBufferMaxBytes,
    silenceTimeoutMs: config.ticketSilenceTimeoutMs,
    onTicketText: (rawText) => {
      const message = rawText.endsWith("\n") ? rawText.slice(0, -1) : rawText;
      if (message.trim()) onData(message);
    },
    onWarning: (message) => console.warn(`[capture-tcp] ${peripheral.id}: ${message}`)
  });
  function connect() {
    if (closed) return;
    socket = net2.createConnection({ host: peripheral.host, port: peripheral.port });
    socket.on("connect", () => {
      console.log(`[capture-tcp] conectado a ${peripheral.id} (${peripheral.host}:${peripheral.port})`);
    });
    socket.on("data", (chunk) => {
      bufferer.feed(chunk.toString("utf-8"));
    });
    socket.on("error", (err) => {
      console.error(`[capture-tcp] error en ${peripheral.id}:`, err.message);
    });
    socket.on("close", () => {
      if (closed) return;
      reconnectTimer = setTimeout(connect, RECONNECT_DELAY_MS);
    });
  }
  connect();
  return {
    close: () => {
      closed = true;
      bufferer.dispose();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      socket?.destroy();
    }
  };
}

// ../print-capture-agent/src/cloud/backoff.ts
function classifyFailure(status) {
  if (status === void 0) return "transient";
  if (status === 408 || status === 429) return "transient";
  if (status >= 400 && status < 500) return "permanent";
  return "transient";
}
var TRANSIENT_MAX_MS = 5 * 60 * 1e3;
var PERMANENT_BASE_MS = 5 * 60 * 1e3;
var PERMANENT_MAX_MS = 60 * 60 * 1e3;
var MAX_EXPONENT = 10;
var JITTER_MIN = 0.8;
var JITTER_SPREAD = 0.4;
function computeBackoffMs(attempts, kind, baseMs) {
  const base = kind === "permanent" ? PERMANENT_BASE_MS : baseMs;
  const cap = kind === "permanent" ? PERMANENT_MAX_MS : TRANSIENT_MAX_MS;
  const exponent = Math.min(Math.max(attempts - 1, 0), MAX_EXPONENT);
  const raw = Math.min(base * 2 ** exponent, cap);
  const jitter = JITTER_MIN + Math.random() * JITTER_SPREAD;
  return Math.round(raw * jitter);
}

// ../print-capture-agent/src/cloud/uploadClient.ts
async function uploadTicket(options, record) {
  try {
    const response = await fetch(options.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...options.apiKey ? { "x-api-key": options.apiKey } : {}
      },
      body: JSON.stringify(record),
      // Sin esto, una conexión que se queda abierta sin responder nunca
      // resuelve ni rechaza — `syncQueueToCloud` queda colgado para
      // siempre y ningún ticket posterior en la cola llega a subirse.
      signal: AbortSignal.timeout(options.timeoutMs)
    });
    return { ok: response.ok, status: response.status };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ../print-capture-agent/src/cloud/credentials.ts
import { mkdir, readFile as readFile2, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline/promises";
import { hostname } from "node:os";
import { stdin, stdout } from "node:process";

// ../print-capture-agent/src/cloud/activationClient.ts
async function activateAgent(url, code, name, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code.trim().toUpperCase(), name: name.trim() }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error ?? `la activaci\xF3n respondi\xF3 HTTP ${response.status}`);
  if (!body.agentId || !body.name || !body.apiKey) throw new Error("la activaci\xF3n devolvi\xF3 una respuesta incompleta");
  return body;
}

// ../print-capture-agent/src/cloud/credentials.ts
async function loadCredentials(path2) {
  try {
    const value = JSON.parse(await readFile2(path2, "utf8"));
    return value?.apiKey && value?.name ? value : void 0;
  } catch (err) {
    const code = err.code;
    if (code === "ENOENT") return void 0;
    throw new Error(`no se pudieron leer las credenciales de ${path2}`, { cause: err });
  }
}
async function saveCredentials(path2, value) {
  await mkdir(dirname(path2), { recursive: true });
  const temporary = `${path2}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf8", mode: 384 });
  await rename(temporary, path2);
}
async function ensureCredentials(options) {
  if (options.envApiKey) return { name: process.env.AGENT_NAME?.trim() || hostname(), apiKey: options.envApiKey };
  const stored = await loadCredentials(options.path);
  if (stored) return stored;
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(`el agente todav\xEDa no est\xE1 activado; ejec\xFAtalo una vez en una consola interactiva o define CLOUD_API_KEY`);
  }
  const prompt = createInterface({ input: stdin, output: stdout });
  try {
    console.log("[activation] Este robot todav\xEDa no est\xE1 vinculado a un negocio.");
    const code = await prompt.question("C\xF3digo de activaci\xF3n (XXXXX-XXXXX): ");
    const suggestedName = process.env.AGENT_NAME?.trim() || hostname();
    const name = (await prompt.question(`Nombre del robot [${suggestedName}]: `)).trim() || suggestedName;
    const activated = await activateAgent(options.activationUrl, code, name, options.timeoutMs);
    const credentials2 = { agentId: activated.agentId, name: activated.name, apiKey: activated.apiKey };
    await saveCredentials(options.path, credentials2);
    console.log(`[activation] Robot "${activated.name}" activado. La credencial qued\xF3 guardada en ${options.path}.`);
    return credentials2;
  } finally {
    prompt.close();
  }
}

// ../print-capture-agent/src/cloud/heartbeatClient.ts
async function sendHeartbeat(url, apiKey, payload, timeoutMs) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": apiKey },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!response.ok) throw new Error(`heartbeat respondi\xF3 HTTP ${response.status}`);
}

// ../print-capture-agent/src/ports/portScanner.ts
import { execFile as execFile2 } from "node:child_process";
import { promisify as promisify2 } from "node:util";
import { SerialPort as SerialPort2 } from "serialport";
var execFileAsync2 = promisify2(execFile2);
async function getWindowsFriendlyNames() {
  const names = /* @__PURE__ */ new Map();
  try {
    const script = "Get-CimInstance Win32_PnPEntity | Where-Object { $_.Name -match '\\(COM\\d+\\)' } | Select-Object Name | ConvertTo-Json -Compress";
    const { stdout: stdout2 } = await execFileAsync2("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5e3
    });
    const trimmed = stdout2.trim();
    if (!trimmed) return names;
    const parsed = JSON.parse(trimmed);
    const entries = Array.isArray(parsed) ? parsed : [parsed];
    for (const entry of entries) {
      const name = entry.Name;
      if (!name) continue;
      const match = name.match(/\((COM\d+)\)/);
      if (!match) continue;
      names.set(match[1], name.replace(/\s*\(COM\d+\)\s*$/, "").trim());
    }
  } catch (err) {
    console.error("[ports] no se pudo consultar WMI para nombres de puerto:", err);
  }
  return names;
}
async function scanPorts() {
  const [list, friendlyNames] = await Promise.all([SerialPort2.list(), getWindowsFriendlyNames()]);
  return list.map((port) => ({
    id: port.path,
    name: port.path,
    description: friendlyNames.get(port.path) ?? port.manufacturer ?? port.pnpId ?? "Puerto serie"
  }));
}

// ../print-capture-agent/src/queue/localQueue.ts
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir as mkdir2, readFile as readFile3, rename as rename2, writeFile as writeFile2 } from "node:fs/promises";
import { dirname as dirname2 } from "node:path";
var LocalQueue = class {
  constructor(filePath) {
    this.filePath = filePath;
  }
  filePath;
  items = [];
  loaded = false;
  queueChain = Promise.resolve();
  async load() {
    if (existsSync(this.filePath)) {
      const raw = await readFile3(this.filePath, "utf-8");
      this.items = raw.trim().length > 0 ? JSON.parse(raw) : [];
    }
    this.loaded = true;
  }
  async enqueue(id, payload) {
    return this.runExclusive(() => {
      this.items.push({ id, payload, attempts: 0, enqueuedAt: (/* @__PURE__ */ new Date()).toISOString() });
    });
  }
  getPending() {
    this.assertLoaded();
    return [...this.items];
  }
  /** Los que están listos para reintentar ahora — excluye los que tienen
   * un `nextRetryAt` todavía en el futuro (backoff activo). */
  getDue(now = /* @__PURE__ */ new Date()) {
    this.assertLoaded();
    const nowIso = now.toISOString();
    return this.items.filter((item) => !item.nextRetryAt || item.nextRetryAt <= nowIso);
  }
  async markSent(id) {
    return this.runExclusive(() => {
      this.items = this.items.filter((item) => item.id !== id);
    });
  }
  /**
   * `nextRetryAt` (calculado por el llamador con backoff según el tipo de
   * error) determina cuándo vuelve a ser elegible este ticket en
   * `getDue()`. Sin esto, `attempts` solo se incrementaba sin controlar
   * nada del reintento real.
   */
  async markFailed(id, nextRetryAt) {
    return this.runExclusive(() => {
      const item = this.items.find((i) => i.id === id);
      if (item) {
        item.attempts += 1;
        item.nextRetryAt = nextRetryAt;
      }
    });
  }
  assertLoaded() {
    if (!this.loaded) {
      throw new Error("LocalQueue: llamar a load() antes de usarla");
    }
  }
  /**
   * Encola `mutate` + persistencia detrás de todo lo que ya esté pendiente
   * en `queueChain`, así dos llamadas concurrentes (ej. una captura nueva
   * mientras el sync está marcando otro ticket como enviado) nunca leen o
   * escriben el archivo al mismo tiempo — corren una atrás de la otra, en
   * el orden en que se invocaron.
   */
  runExclusive(mutate) {
    this.assertLoaded();
    const next = this.queueChain.then(async () => {
      mutate();
      await this.persist();
    });
    this.queueChain = next.catch(() => {
    });
    return next;
  }
  async persist() {
    await mkdir2(dirname2(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile2(tmpPath, JSON.stringify(this.items, null, 2), "utf-8");
    await rename2(tmpPath, this.filePath);
  }
};

// ../print-capture-agent/src/index.ts
var pipe = new AgentPipeServer({
  agentName: config.agentName,
  agentVersion: config.agentVersion,
  idleThresholdMs: config.idleThresholdMs
});
var queue = new LocalQueue(config.queueFilePath);
var captures = /* @__PURE__ */ new Map();
var knownPortIds = /* @__PURE__ */ new Set();
var credentials;
var tcpPorts = config.tcpPeripherals.map((peripheral) => ({
  id: peripheral.id,
  name: peripheral.id,
  description: peripheral.description,
  status: "idle",
  lastActivityAt: (/* @__PURE__ */ new Date()).toISOString()
}));
var spoolPorts = [];
var SPOOL_CAPTURE_ID = "__spool__";
async function handleCapturedTicket(rawPort, raw, encoding = "text") {
  const id = randomUUID2();
  const capturedAt = (/* @__PURE__ */ new Date()).toISOString();
  pipe.emitTicket({ id, timestamp: capturedAt, port: rawPort });
  const payload = encoding === "escpos" ? { ticketId: id, port: rawPort, capturedAt, rawBase64: raw, rawEncoding: "escpos" } : { ticketId: id, port: rawPort, capturedAt, rawText: raw };
  await queue.enqueue(id, payload);
  console.log(`[agent] ticket capturado en ${rawPort} (${encoding}), encolado para parsear en la nube`);
}
function runDetached(taskName, task) {
  task().catch((err) => {
    console.error(`[agent] error inesperado en ${taskName}:`, err);
    pipe.setStatus("error", `Error interno en ${taskName} \u2014 ver logs del agente`);
  });
}
async function syncQueueToCloud() {
  const due = queue.getDue();
  if (due.length === 0) return;
  let anyFailure = false;
  for (const record of due) {
    const result = await uploadTicket(
      {
        url: config.cloudUploadUrl,
        apiKey: credentials.apiKey,
        timeoutMs: config.cloudUploadTimeoutMs
      },
      record.payload
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
      const kindLabel = kind === "permanent" ? "permanente, no va a cambiar solo" : "transitorio";
      console.error(
        `[agent] fall\xF3 la subida de ${record.id} (${kindLabel}): ${result.error ?? `HTTP ${result.status}`} \u2014 reintenta en ${Math.round(delayMs / 1e3)}s`
      );
    }
  }
  pipe.setStatus(
    anyFailure ? "error" : "ok",
    anyFailure ? "No se pudo conectar al backend en la nube" : void 0
  );
}
function scheduleHeartbeatLoop() {
  setTimeout(() => {
    sendHeartbeat(
      config.heartbeatUrl,
      credentials.apiKey,
      { name: credentials.name, version: config.agentVersion, location: config.location },
      config.cloudUploadTimeoutMs
    ).catch((err) => console.error("[agent] no se pudo enviar el heartbeat:", err)).finally(scheduleHeartbeatLoop);
  }, config.heartbeatIntervalMs);
}
async function sendInitialHeartbeatWithRetry() {
  const retryDelaysMs = [0, 2e3, 5e3, 1e4];
  let lastError;
  for (const delayMs of retryDelaysMs) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      await sendHeartbeat(
        config.heartbeatUrl,
        credentials.apiKey,
        { name: credentials.name, version: config.agentVersion, location: config.location },
        config.cloudUploadTimeoutMs
      );
      return;
    } catch (err) {
      lastError = err;
      console.error(`[agent] no se pudo enviar el heartbeat inicial${delayMs ? ` tras reintento de ${delayMs / 1e3}s` : ""}:`, err);
    }
  }
  throw lastError;
}
async function refreshPorts() {
  const detected = await scanPorts();
  for (const port of detected) {
    if (!knownPortIds.has(port.id)) {
      knownPortIds.add(port.id);
      console.log(`[ports] detectado: ${port.id} \u2014 ${port.description}`);
    }
  }
  for (const portId of knownPortIds) {
    if (!detected.some((p) => p.id === portId)) {
      knownPortIds.delete(portId);
      console.log(`[ports] ya no disponible: ${portId}`);
    }
  }
  const serialPorts = detected.map((port) => ({
    id: port.id,
    name: port.name,
    description: port.description,
    status: captures.has(port.id) ? "active" : "idle",
    lastActivityAt: (/* @__PURE__ */ new Date()).toISOString()
  }));
  const reportedTcpPorts = tcpPorts.map((port) => ({
    ...port,
    status: captures.has(port.id) ? "active" : "idle"
  }));
  pipe.setPorts([...serialPorts, ...reportedTcpPorts, ...spoolPorts]);
  if (config.captureEnabled) {
    for (const port of detected) {
      if (captures.has(port.id)) continue;
      const handle = capturePort(port.id, (rawText) => {
        runDetached("handleCapturedTicket", () => handleCapturedTicket(port.id, rawText));
      });
      captures.set(port.id, handle);
    }
  }
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
function startTcpCaptures() {
  if (!config.captureEnabled) return;
  for (const peripheral of config.tcpPeripherals) {
    const handle = captureTcp(peripheral, (rawText) => {
      runDetached("handleCapturedTicket", () => handleCapturedTicket(peripheral.id, rawText));
    });
    captures.set(peripheral.id, handle);
  }
}
async function initSpoolCapture() {
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
    lastActivityAt: (/* @__PURE__ */ new Date()).toISOString()
  }));
}
function scheduleSyncLoop() {
  setTimeout(() => {
    syncQueueToCloud().catch((err) => {
      console.error("[agent] error inesperado sincronizando con la nube:", err);
      pipe.setStatus("error", "Error interno sincronizando con la nube \u2014 ver logs del agente");
    }).finally(scheduleSyncLoop);
  }, config.cloudSyncIntervalMs);
}
function schedulePortScanLoop() {
  setTimeout(() => {
    refreshPorts().catch((err) => {
      console.error("[agent] error inesperado escaneando puertos:", err);
      pipe.setStatus("error", "Error interno escaneando puertos \u2014 ver logs del agente");
    }).finally(schedulePortScanLoop);
  }, config.portScanIntervalMs);
}
async function main() {
  credentials = await ensureCredentials({
    path: config.credentialsFilePath,
    envApiKey: config.cloudApiKey,
    activationUrl: config.activationUrl,
    timeoutMs: config.cloudUploadTimeoutMs
  });
  await queue.load();
  pipe.start();
  startTcpCaptures();
  try {
    await initSpoolCapture();
  } catch (err) {
    console.error("[agent] error inesperado arrancando la captura de spool:", err);
    pipe.setStatus("error", "Error interno arrancando la captura de spool \u2014 ver logs del agente");
  }
  try {
    await refreshPorts();
  } catch (err) {
    console.error("[agent] error inesperado en el primer escaneo de puertos:", err);
    pipe.setStatus("error", "Error interno escaneando puertos \u2014 ver logs del agente");
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
