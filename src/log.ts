/**
 * Le agrega un timestamp ISO a cada línea de `console.log`/`console.error`
 * de todo el proceso (agente + `print-capture-agent-pipe-server`, que
 * comparte el mismo `console`). Sin esto, reconstruir la secuencia de un
 * incidente (ej. tickets que se pierden entre un reinicio del servicio y
 * el próximo) depende de `service.log` nada más — ese si tiene
 * timestamps (`t+<segundos>`), pero `agent.log`/`agent-error.log` no
 * tenían ninguno, y correlacionar ambos a mano es lento y propenso a
 * error (pasó en la práctica: un ticket perdido durante un reinicio
 * múltiple de Windows Update tardó bastante en diagnosticarse por esto).
 *
 * Se llama una sola vez, apenas arranca el proceso — ver `index.ts`.
 */
export function installTimestampedLogging(): void {
  const originalLog = console.log.bind(console);
  const originalError = console.error.bind(console);
  const originalWarn = console.warn.bind(console);

  const prefix = (): string => `[${new Date().toISOString()}]`;

  console.log = (...args: unknown[]) => originalLog(prefix(), ...args);
  console.error = (...args: unknown[]) => originalError(prefix(), ...args);
  console.warn = (...args: unknown[]) => originalWarn(prefix(), ...args);
}
