# Paths canónicos del agent (Windows)

Layout de **producción / piloto** (NSIS `perMachine`). Cualquier runbook de
hotfix, OTA o diagnóstico debe usar **estos** paths — no `%LOCALAPPDATA%` ni
`%APPDATA%\com.innoapp.agentstatusviewer` del script histórico de etapa B.

## Runtime (solo LocalSystem / instalador elevado)

```text
C:\Program Files\InnoApp Agent\
  InnoApp Agent.exe                         # bandeja Tauri
  resources\
    innoapp-agent-service.exe               # servicio SCM InnoAppAgent
    agent\
      node.exe
      app.mjs                               # bundle del print-capture-agent (+ pipe)
      package.json                          # deps nativas (serialport)
      node_modules\
```

Hotfix JS-only: reemplazar `resources\agent\app.mjs` (parar el hijo Node
antes) y reiniciar el servicio / matar el proceso `node.exe … app.mjs`.

## Datos (ProgramData — sobreviven reinstall)

```text
C:\ProgramData\InnoApp Agent\
  credentials.json
  queue.json
  status.json                               # sidecar para la bandeja
  folder-state.json                         # si aplica captura por carpeta
  logs\
    agent.log
    agent-error.log
    service.log
  updates\
    staging\app.mjs                         # download verificado (sha256)
    pending-apply.json                      # el servicio hace swap + reinicio
    blocked-versions.json                   # agent: versiones revertidas, no se reintentan por 24 h
    boot-check.json                         # post-swap; el agent lo borra tras su 1er heartbeat OK (si no, el servicio revierte)
    rolled-back.json                        # si el servicio restauró .prev
    app.mjs.prev                            # último bueno (copia en ProgramData)
```

OTA (Fase 1): el agent descarga y verifica; el **servicio** (`InnoAppAgent`)
aplica el swap de `resources\agent\app.mjs` (libera el lock) y relanza el hijo.
No usar el catálogo de diagnósticos PowerShell para update.

El instalador crea ProgramData con ACL de modificación para `BUILTIN\Users`
para que la activación desde la bandeja escriba credenciales sin UAC.
**No borrar ProgramData en upgrades.**

## Versionado

| Qué | Dónde se fija | Qué se reporta |
|-----|---------------|----------------|
| Agent JS | `print-capture-agent/package.json` | Heartbeat `version`, pipe/status |
| Override runtime | env `AGENT_VERSION` (inyectada en bundle piloto) | Igual |
| Producto Windows (setup) | `agent-status-viewer` `package.json` + `tauri.conf.json` | Nombre del setup NSIS |
| Servicio Rust | `agent-service/Cargo.toml` | Independiente; bump solo si cambia el servicio |

Ver también el runbook de release en `agent-status-viewer/docs/release-checklist.md`.
