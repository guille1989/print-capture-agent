/**
 * Lógica pura para decidir qué hacer con un archivo de spool (`*.SPL` de
 * `C:\Windows\System32\spool\PRINTERS`) y cómo partirlo en tickets. Vive
 * separada de `spoolCapture.ts` — que hace el IO (watcher, WMI, borrado de
 * trabajos) — para poder probarla con buffers/strings sintéticos, sin
 * necesitar el spooler de Windows ni una impresora real.
 */

const CUT_PAPER_MARKER = "\x1dV"; // GS V — igual que `portCapture.ts`

/**
 * Datatypes de spool cuyo `.SPL` son los bytes crudos que van a la
 * impresora (ESC/POS para una térmica) — se pueden parsear tal cual.
 * `TEXT` también: el spooler lo trata como texto ANSI plano.
 */
const RAW_DATATYPES = new Set(["RAW", "RAW [FF APPENDED]", "RAW [FF AUTO]", "RAW [FF NONE]", "TEXT"]);

/**
 * Datatypes gráficos: el `.SPL` es un metafile GDI (EMF) o un paquete XPS
 * que recién se convierte a comandos de impresora al despachar. No se puede
 * leer como texto — necesitaría render + OCR, fuera del alcance de este
 * módulo. El string real que reporta `Win32_PrintJob` para GDI suele ser
 * `NT EMF 1.00x`, no `EMF` a secas.
 */
const GRAPHIC_DATATYPE_PREFIXES = ["EMF", "NT EMF", "XPS", "XPS_PASS", "XPS2GDI"];

export function isRawDatatype(datatype: string | null | undefined): boolean {
  if (!datatype) return false;
  return RAW_DATATYPES.has(datatype.trim().toUpperCase());
}

export function isGraphicDatatype(datatype: string | null | undefined): boolean {
  if (!datatype) return false;
  const normalized = datatype.trim().toUpperCase();
  return GRAPHIC_DATATYPE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Detecta un `.SPL` gráfico mirando el contenido, como red de contención
 * para cuando no tenemos el datatype (el trabajo ya no está en la cola al
 * consultarlo). Todo EMF lleva la firma ASCII `" EMF"` en el offset 40 de
 * su header; un spool EMF la tiene cerca del arranque. Un stream ESC/POS
 * de un ticket no la contiene.
 */
export function looksLikeEmf(head: Buffer): boolean {
  return head.subarray(0, 4096).includes(Buffer.from(" EMF", "latin1"));
}

export type SpoolDecision = { kind: "raw" } | { kind: "skip"; reason: string };

/**
 * Decide si un `.SPL` se puede capturar como texto crudo. Solo se descarta
 * ante una identificación POSITIVA de contenido gráfico — si el datatype es
 * desconocido y no parece EMF, se intenta parsear igual (mejor un ticket de
 * más para revisar que uno perdido).
 */
export function classifySpool(args: { datatype?: string | null; head: Buffer }): SpoolDecision {
  if (isGraphicDatatype(args.datatype)) {
    return { kind: "skip", reason: `datatype gráfico (${args.datatype!.trim()})` };
  }
  if (looksLikeEmf(args.head)) {
    return { kind: "skip", reason: "contenido EMF (documento gráfico, no ticket)" };
  }
  if (args.datatype && !isRawDatatype(args.datatype)) {
    return { kind: "skip", reason: `datatype no soportado (${args.datatype.trim()})` };
  }
  return { kind: "raw" };
}

/**
 * Parte el contenido de un `.SPL` en tickets. A diferencia de la captura
 * serie/TCP (stream continuo sin borde natural), un `.SPL` es un trabajo de
 * impresión completo: el borde del archivo ya es un fin de ticket. Además
 * se corta en cada comando de corte de papel (GS V), por si un mismo
 * trabajo trae varias copias (ej. comanda de cocina + ticket de cliente).
 */
export function splitSpoolIntoTickets(content: string): string[] {
  const tickets: string[] = [];
  let rest = content;

  let cutIndex = rest.indexOf(CUT_PAPER_MARKER);
  while (cutIndex !== -1) {
    const end = cutIndex + CUT_PAPER_MARKER.length;
    tickets.push(rest.slice(0, end));
    rest = rest.slice(end);
    cutIndex = rest.indexOf(CUT_PAPER_MARKER);
  }
  if (rest.length > 0) tickets.push(rest);

  // Descarta segmentos sin texto real: el pedazo que queda después del
  // último corte suele ser solo comandos ESC/POS de avance de papel
  // (`ESC d n`, `ESC J n`…), que traen bytes imprimibles sueltos pero
  // ninguna palabra. Un ticket de verdad tiene decenas de letras/números.
  const MIN_ALPHANUMERIC = 3;
  return tickets.filter((ticket) => (ticket.match(/[\p{L}\p{N}]/gu) ?? []).length >= MIN_ALPHANUMERIC);
}
