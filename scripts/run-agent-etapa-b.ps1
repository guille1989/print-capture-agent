# Etapa B - corre el agente nuevo (captura de spool -> escpos) en la PC de
# Empanadas, elevado, para probar el circuito real sin armar el instalador.
#
# Paths canónicos (piloto / producción):
#   Runtime:  C:\Program Files\InnoApp Agent\resources\agent\
#   Datos:    C:\ProgramData\InnoApp Agent\
# (El layout viejo bajo %LOCALAPPDATA% / AppData del viewer ya no aplica.)
#
# ANTES: copiar 'app.mjs' al Escritorio de esta PC.
# CORRER: PowerShell "como administrador":
#   powershell -ExecutionPolicy Bypass -File run-agent-etapa-b.ps1
# REVERTIR:
#   powershell -ExecutionPolicy Bypass -File run-agent-etapa-b.ps1 -Restore

param([switch]$Restore)
$ErrorActionPreference = "Stop"

$runtime = "C:\Program Files\InnoApp Agent\resources\agent"
$node = Join-Path $runtime "node.exe"
if (-not (Test-Path $node)) {
  # Fallback legacy (instalaciones previas al layout Program Files).
  $legacy = Get-ChildItem "C:\Users\*\AppData\Local\InnoApp Agent\resources\agent\node.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($legacy) {
    $node = $legacy.FullName
    $runtime = Split-Path $node
    Write-Host "AVISO: runtime legacy en AppData. El path canónico es Program Files." -ForegroundColor Yellow
  } else {
    Write-Host "No encuentro node.exe en Program Files\InnoApp Agent\resources\agent." -ForegroundColor Red
    exit 1
  }
}
$appMjs  = Join-Path $runtime "app.mjs"
$backup  = Join-Path $runtime "app.mjs.orig"
Write-Host ("Runtime: " + $runtime)

if ($Restore) {
  if (Test-Path $backup) { Copy-Item $backup $appMjs -Force; Write-Host "app.mjs original restaurado." -ForegroundColor Green }
  else { Write-Host "No hay backup. Nada que restaurar." -ForegroundColor Yellow }
  exit 0
}

# 1. cerrar la app de bandeja y cualquier node hijo (libera el named pipe)
Get-Process "InnoApp Agent" -ErrorAction SilentlyContinue | Stop-Process -Force
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'app\.mjs' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-Sleep -Seconds 2

# 2. backup + swap del app.mjs
$new = Join-Path $env:USERPROFILE "Desktop\app.mjs"
if (-not (Test-Path $new)) { Write-Host ("No encuentro el app.mjs nuevo en " + $new) -ForegroundColor Red; exit 1 }
if (-not (Test-Path $backup)) { Copy-Item $appMjs $backup -Force; Write-Host ("Backup: " + $backup) -ForegroundColor Green }
Copy-Item $new $appMjs -Force
Write-Host ("app.mjs nuevo copiado: " + (Get-Item $appMjs).Length + " bytes") -ForegroundColor Green

# 3. arrancar el agente elevado — datos en ProgramData (layout piloto)
$data = "C:\ProgramData\InnoApp Agent"
if (-not (Test-Path (Join-Path $data "credentials.json"))) {
  # Fallback legacy del viewer Tauri en AppData del usuario.
  $legacyData = Join-Path $env:APPDATA "com.innoapp.agentstatusviewer"
  if (Test-Path (Join-Path $legacyData "credentials.json")) {
    $data = $legacyData
    Write-Host "AVISO: credentials en AppData legacy. El path canónico es ProgramData." -ForegroundColor Yellow
  } else {
    Write-Host ("No hay credentials.json en " + $data + " -- esta PC no esta activada.") -ForegroundColor Red
    exit 1
  }
}

$env:CLOUD_UPLOAD_URL       = "https://uqa4ti7fwi.execute-api.us-east-1.amazonaws.com/prod/tickets"
$env:AGENT_CREDENTIALS_FILE = Join-Path $data "credentials.json"
$env:QUEUE_FILE             = Join-Path $data "queue.json"
$env:ENABLE_CAPTURE         = "true"
$env:ENABLE_SPOOL_CAPTURE   = "true"
$env:SPOOL_PRINTERS         = '["EPSON TM-T20II Receipt"]'

Write-Host ""
Write-Host "Agente arrancando. Ctrl+C para cortar." -ForegroundColor Cyan
Write-Host "Ahora: venta de prueba en Loggro. En el log busca:" -ForegroundColor Cyan
Write-Host "  [spool] trabajo NN (EPSON TM-T20II Receipt): 1 ticket(s) capturado(s)" -ForegroundColor Cyan
Write-Host "  [agent] ticket capturado en EPSON TM-T20II Receipt (escpos)" -ForegroundColor Cyan
Write-Host ""

Set-Location $runtime
& $node "app.mjs"
