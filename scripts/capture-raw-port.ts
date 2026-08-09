// Herramienta de diagnóstico standalone — NO toca la cola local, la subida
// a la nube, ni el pipe del viewer. Solo abre un puerto serie y vuelca lo
// que llega a un archivo. Pensada para correr a mano en la PC real del
// negocio y juntar una captura de verdad, con mucho menos riesgo que
// prender ENABLE_CAPTURE del agente completo (ver PROYECTO.md sección 8).
//
// Uso:
//   npx tsx scripts/capture-raw-port.ts --port COM3 [--baud 9600] [--seconds 60]
//
// Con el script corriendo, imprimir un ticket real desde el POS. Corta
// solo al llegar a --seconds, o antes con Ctrl+C — cualquiera de los dos
// guarda prolijo lo capturado hasta ese momento.
//
// Salida en data/captures/:
//   <timestamp>-<puerto>.bin   bytes exactos, tal cual llegaron
//   <timestamp>-<puerto>.txt   hex dump + vista en latin1, para mirar a ojo
import { SerialPort } from "serialport";

import { createRawCaptureLogger } from "./lib/rawCaptureLogger.js";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const portPath = arg("port");
  if (!portPath) {
    throw new Error("falta --port (ej. --port COM3)");
  }
  const baudRate = Number(arg("baud") ?? 9600);
  const seconds = Number(arg("seconds") ?? 60);

  const logger = createRawCaptureLogger(portPath.replace(/[^a-zA-Z0-9]/g, "_"));
  const port = new SerialPort({ path: portPath, baudRate, autoOpen: true });

  console.log(`Escuchando ${portPath} a ${baudRate} baud durante ${seconds}s (Ctrl+C para cortar antes).`);
  console.log("Imprimí un ticket real desde el POS ahora.\n");

  port.on("data", (chunk: Buffer) => {
    logger.logChunk(chunk);
    console.log(`[${new Date().toLocaleTimeString()}] +${chunk.length} bytes`);
  });

  port.on("error", (err) => {
    console.error("Error de puerto:", err.message);
  });

  const finish = (): void => {
    if (port.isOpen) port.close();
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
