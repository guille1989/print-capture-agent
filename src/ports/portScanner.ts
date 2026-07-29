import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { SerialPort } from "serialport";

import { DetectedPort } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * `serialport` es multiplataforma y para puertos virtuales (Bluetooth SPP,
 * un redirector de impresora) casi nunca trae manufacturer/vendorId/etc. —
 * esos campos dependen de que el dispositivo se haya enumerado por USB.
 * Windows sí sabe el nombre real (el mismo que se ve en el Administrador
 * de dispositivos, ej. "Standard Serial over Bluetooth link"), así que lo
 * pedimos por WMI y lo cruzamos con la lista de `serialport` por número de
 * puerto. Si la consulta falla por lo que sea, no rompe nada: se sigue
 * usando el fallback de siempre.
 */
async function getWindowsFriendlyNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();

  try {
    const script =
      "Get-CimInstance Win32_PnPEntity | " +
      "Where-Object { $_.Name -match '\\(COM\\d+\\)' } | " +
      "Select-Object Name | ConvertTo-Json -Compress";

    const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
    });

    const trimmed = stdout.trim();
    if (!trimmed) return names;

    const parsed = JSON.parse(trimmed);
    const entries: Array<{ Name?: string }> = Array.isArray(parsed) ? parsed : [parsed];

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

/**
 * Enumera los puertos serie disponibles (incluye COM redirigidos e
 * impresoras/Bluetooth SPP emparejados, que Windows expone como COM
 * virtuales). No distingue todavía "cuál puerto es la impresora que me
 * interesa" — eso probablemente necesite una lista de filtro/config una
 * vez que sepamos qué aparece en una PC real del negocio.
 */
export async function scanPorts(): Promise<DetectedPort[]> {
  const [list, friendlyNames] = await Promise.all([SerialPort.list(), getWindowsFriendlyNames()]);

  return list.map((port) => ({
    id: port.path,
    name: port.path,
    description: friendlyNames.get(port.path) ?? port.manufacturer ?? port.pnpId ?? "Puerto serie",
  }));
}
