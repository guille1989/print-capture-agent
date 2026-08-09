// Misma idea que capture-raw-port.ts, para un periférico TCP (ej. un
// datáfono/TPV moderno que expone una API por socket) en vez de un puerto
// serie. Standalone, no toca la cola/pipe/subida del agente.
//
// Uso:
//   npx tsx scripts/capture-raw-tcp.ts --host 192.168.1.50 --port 9000 [--seconds 60]
import net from "node:net";

import { createRawCaptureLogger } from "./lib/rawCaptureLogger.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const host = arg("host");
  const portArg = arg("port");
  if (!host || !portArg) {
    throw new Error("faltan --host y/o --port (ej. --host 192.168.1.50 --port 9000)");
  }
  const port = Number(portArg);
  const seconds = Number(arg("seconds") ?? 60);

  const logger = createRawCaptureLogger(`${host.replace(/[^a-zA-Z0-9]/g, "_")}_${port}`);
  const socket = net.createConnection({ host, port });

  console.log(`Conectando a ${host}:${port}, escuchando ${seconds}s (Ctrl+C para cortar antes).`);

  socket.on("connect", () => console.log("Conectado. Generá una transacción real en el TPV ahora.\n"));

  socket.on("data", (chunk: Buffer) => {
    logger.logChunk(chunk);
    console.log(`[${new Date().toLocaleTimeString()}] +${chunk.length} bytes`);
  });

  socket.on("error", (err) => {
    console.error("Error de conexión:", err.message);
  });

  const finish = (): void => {
    socket.destroy();
    const { binPath, txtPath, totalBytes } = logger.close();
    console.log(`\nListo. ${totalBytes} bytes capturados.`);
    console.log(`  crudo (usar esto para escribir el parser):  ${binPath}`);
    console.log(`  legible (hex dump, para mirar a ojo):       ${txtPath}`);
    process.exit(0);
  };

  process.on("SIGINT", finish);
  setTimeout(finish, seconds * 1000);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
