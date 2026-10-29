/**
 * Catálogo de diagnósticos remotos. La nube pide uno por `scriptId`; el
 * PowerShell vive acá, dentro del agente instalado, y no recibe ningún texto de
 * afuera — los únicos datos variables llegan por variables de entorno que
 * arma `runner.ts` (nunca interpolados en el script).
 *
 * Reglas para agregar un script:
 *  - Solo lectura: nada de Set-/Remove-/Restart-/Stop-/Start-, ni escribir archivos.
 *  - Nunca leer ni imprimir `credentials.json` (tiene la api-key del agente).
 *  - No imprimir el contenido de tickets (`queue.json` trae el crudo en `payload`).
 *  - Mantener el id alineado con `ticket-parsing-cloud/src/agents/commandCatalog.ts`.
 */
export const DIAGNOSTIC_SCRIPTS: Record<string, string> = {
  "agent-health": `
"== Equipo =="
Get-CimInstance Win32_OperatingSystem | Select-Object Caption, Version, LastBootUpTime | Format-List
"== Hora y zona horaria =="
(Get-Date -Format o) + "  " + (Get-TimeZone).Id
"== Servicio InnoAppAgent =="
Get-Service -Name InnoAppAgent -ErrorAction SilentlyContinue | Format-Table Name, Status, StartType -AutoSize
if (-not (Get-Service -Name InnoAppAgent -ErrorAction SilentlyContinue)) { "(el servicio InnoAppAgent no está instalado)" }
"== Procesos (node / InnoApp) =="
Get-Process | Where-Object { $_.ProcessName -match 'node|innoapp' } |
  Select-Object ProcessName, Id, StartTime, @{ n = 'MemoriaMB'; e = { [math]::Round($_.WorkingSet64 / 1MB) } } | Format-Table -AutoSize
"== Discos =="
Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" |
  Select-Object DeviceID, @{ n = 'TotalGB'; e = { [math]::Round($_.Size / 1GB, 1) } }, @{ n = 'LibreGB'; e = { [math]::Round($_.FreeSpace / 1GB, 1) } } | Format-Table -AutoSize
`,

  printers: `
"== Impresoras =="
Get-Printer | Select-Object Name, DriverName, PortName, PrinterStatus, Shared | Format-Table -AutoSize
"== Conservar documentos impresos (lo necesita la captura de spool) =="
Get-CimInstance Win32_Printer | Select-Object Name, KeepPrintedJobs, Local, WorkOffline | Format-Table -AutoSize
"== Puertos =="
Get-PrinterPort | Select-Object Name, Description, PrinterHostAddress, PortNumber | Format-Table -AutoSize
"== Trabajos en cola =="
$jobs = Get-Printer | ForEach-Object { Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue }
if ($jobs) { $jobs | Select-Object PrinterName, Id, DocumentName, JobStatus, Size, SubmittedTime | Format-Table -AutoSize } else { "(ninguno)" }
`,

  spooler: `
"== Servicio Spooler =="
Get-Service Spooler | Format-List Name, Status, StartType
$spool = Join-Path $env:SystemRoot 'System32\\spool\\PRINTERS'
"== Carpeta de spool: $spool =="
$files = @(Get-ChildItem $spool -Force -ErrorAction SilentlyContinue)
"Archivos: " + $files.Count
$files | Sort-Object LastWriteTime -Descending | Select-Object -First 30 Name, Length, LastWriteTime | Format-Table -AutoSize
"== Errores de impresión de los últimos 2 días =="
try {
  Get-WinEvent -FilterHashtable @{ LogName = 'Microsoft-Windows-PrintService/Admin'; Level = 1, 2, 3; StartTime = (Get-Date).AddDays(-2) } -MaxEvents 20 -ErrorAction Stop |
    Select-Object TimeCreated, Id, LevelDisplayName, Message | Format-List
} catch { "(sin eventos o registro deshabilitado: " + $_.Exception.Message + ")" }
`,

  network: `
$h = $env:INNO_API_HOST
"Host de la nube: $h"
"== DNS =="
try { Resolve-DnsName $h -ErrorAction Stop | Select-Object Name, Type, IPAddress | Format-Table -AutoSize } catch { "DNS falló: " + $_.Exception.Message }
"== TCP 443 =="
try { Test-NetConnection $h -Port 443 -WarningAction SilentlyContinue | Format-List ComputerName, RemoteAddress, TcpTestSucceeded } catch { "Test-NetConnection falló: " + $_.Exception.Message }
"== HTTPS (cualquier respuesta, incluso 403, prueba que hay salida) =="
try {
  $r = Invoke-WebRequest -Uri ("https://" + $h + "/") -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
  "HTTP " + [int]$r.StatusCode
} catch {
  if ($_.Exception.Response) { "HTTP " + [int]$_.Exception.Response.StatusCode } else { "Sin respuesta: " + $_.Exception.Message }
}
"== Proxy WinHTTP =="
netsh winhttp show proxy
"== Direcciones IPv4 =="
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -ne '127.0.0.1' } | Select-Object InterfaceAlias, IPAddress | Format-Table -AutoSize
`,

  "agent-logs": `
$logs = Join-Path $env:INNO_DATA_DIR 'logs'
foreach ($name in 'service.log', 'service-error.log', 'agent.log', 'agent-error.log') {
  $p = Join-Path $logs $name
  "== $name =="
  if (Test-Path $p) {
    $i = Get-Item $p
    "(" + $i.Length + " bytes, modificado " + $i.LastWriteTime + ")"
    Get-Content $p -Tail 60
  } else { "(no existe)" }
}
`,

  "agent-state": `
$dir = $env:INNO_DATA_DIR
"== Archivos de datos (sin credentials.json) =="
Get-ChildItem $dir -Force -File | Where-Object { $_.Name -ne 'credentials.json' } | Select-Object Name, Length, LastWriteTime | Format-Table -AutoSize
"== status.json =="
$status = Join-Path $dir 'status.json'
if (Test-Path $status) { Get-Content $status -Raw } else { "(no existe)" }
"== Cola de tickets pendientes (sin el contenido) =="
$qf = Join-Path $dir 'queue.json'
if (Test-Path $qf) {
  Add-Type -AssemblyName System.Web.Extensions
  $js = New-Object System.Web.Script.Serialization.JavaScriptSerializer
  $js.MaxJsonLength = [int]::MaxValue
  $raw = Get-Content $qf -Raw
  $q = @(); if ($raw.Trim().Length -gt 0) { $q = @($js.DeserializeObject($raw)) }
  "Pendientes: " + $q.Count
  $q | Select-Object -First 30 | ForEach-Object {
    [pscustomobject]@{ id = $_['id']; puerto = $_['payload']['port']; intentos = $_['attempts']; encolado = $_['enqueuedAt']; proximoIntento = $_['nextRetryAt'] }
  } | Format-Table -AutoSize
} else { "(no existe)" }
`,
};
