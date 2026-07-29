import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface QueuedRecord<T> {
  id: string;
  payload: T;
  attempts: number;
  enqueuedAt: string;
  /** Si está seteado y en el futuro, este registro se salta el próximo
   * ciclo de sync — así un ticket con backoff activo no se reintenta en
   * cada vuelta del loop junto con el resto. */
  nextRetryAt?: string;
}

/**
 * Cola persistida en un archivo JSON simple. Pensada para el volumen de
 * un único punto de venta (decenas/cientos de tickets por día), no para
 * alto volumen — si eso cambia, conviene pasar a algo tipo SQLite.
 * Sobrevive un corte de internet: los tickets quedan acá hasta que se
 * puedan subir.
 *
 * El agente dispara capturas y el ciclo de sincronización sin esperarse
 * entre sí (ver `index.ts`), así que `enqueue`/`markSent`/`markFailed`
 * pueden llamarse en paralelo. Para que eso no corrompa el archivo, todas
 * las operaciones que mutan estado se encadenan en `queueChain` — nunca
 * corren dos escrituras al mismo tiempo — y cada escritura es atómica
 * (archivo temporal + `rename`), así una lectura o un corte a mitad de
 * escritura nunca ve un JSON a medias.
 */
export class LocalQueue<T> {
  private items: QueuedRecord<T>[] = [];
  private loaded = false;
  private queueChain: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    if (existsSync(this.filePath)) {
      const raw = await readFile(this.filePath, "utf-8");
      this.items = raw.trim().length > 0 ? JSON.parse(raw) : [];
    }
    this.loaded = true;
  }

  async enqueue(id: string, payload: T): Promise<void> {
    return this.runExclusive(() => {
      this.items.push({ id, payload, attempts: 0, enqueuedAt: new Date().toISOString() });
    });
  }

  getPending(): QueuedRecord<T>[] {
    this.assertLoaded();
    return [...this.items];
  }

  /** Los que están listos para reintentar ahora — excluye los que tienen
   * un `nextRetryAt` todavía en el futuro (backoff activo). */
  getDue(now: Date = new Date()): QueuedRecord<T>[] {
    this.assertLoaded();
    const nowIso = now.toISOString();
    return this.items.filter((item) => !item.nextRetryAt || item.nextRetryAt <= nowIso);
  }

  async markSent(id: string): Promise<void> {
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
  async markFailed(id: string, nextRetryAt?: string): Promise<void> {
    return this.runExclusive(() => {
      const item = this.items.find((i) => i.id === id);
      if (item) {
        item.attempts += 1;
        item.nextRetryAt = nextRetryAt;
      }
    });
  }

  private assertLoaded(): void {
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
  private runExclusive(mutate: () => void): Promise<void> {
    this.assertLoaded();
    const next = this.queueChain.then(async () => {
      mutate();
      await this.persist();
    });
    // Una operación fallida no debe trabar las siguientes de la cadena.
    this.queueChain = next.catch(() => {});
    return next;
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`;
    await writeFile(tmpPath, JSON.stringify(this.items, null, 2), "utf-8");
    await rename(tmpPath, this.filePath);
  }
}
