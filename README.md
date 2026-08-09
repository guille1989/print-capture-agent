# print-capture-agent

Servicio que detecta puertos, captura tickets impresos y sube el texto
crudo a la nube — **el parseo (descripción, monto) vive del lado del
servidor, no acá**. Reporta su estado al
[agent-status-viewer](../innoAppV01) vía
[print-capture-agent-pipe-server](../print-capture-agent-pipe-server).

## Decisión de arquitectura: parseo en la nube

Se evaluó parsear localmente (ver `PROYECTO.md` en la raíz del sistema)
pero se decidió migrar el parseo al servidor. Consecuencia directa: el
feed en tiempo real del viewer ya **no muestra descripción ni monto** —
solo confirma "se capturó un ticket en el puerto X a las Y". Ese detalle
va a vivir únicamente en el dashboard de la nube, una vez que el servidor
lo procese.

## Etapa actual: solo detección de puertos, sin lectura todavía

**El agente identifica todos los puertos de conexión, pero no abre
ninguno para leer datos.** Es una decisión deliberada: los supuestos de
captura (marcador de fin de ticket, baud rate, encoding) todavía no están
validados contra hardware real, y abrir un puerto para leer no es una
operación sin riesgo — podría interferir con cómo el driver de
redirección o el propio POS usan ese puerto. Primero se valida que la
identificación de puertos sea sólida; recién después se prende la
lectura.

Esto se controla con la variable `ENABLE_CAPTURE` (ver más abajo) —
por default está apagada.

Lo que está **probado y funcionando**:
- **Detección de puertos** (`src/ports/portScanner.ts`) — usa `SerialPort.list()` para la lista real de puertos abribles, y cruza cada uno contra una consulta WMI (`Win32_PnPEntity`, vía PowerShell) para obtener el mismo nombre "amigable" que se ve en el Administrador de dispositivos de Windows (ej. "Standard Serial over Bluetooth link"). Esto importa porque `serialport` por sí solo casi no trae manufacturer/vendorId para puertos virtuales (Bluetooth SPP, redirectores de impresora) — esos campos dependen de que el dispositivo se haya enumerado por USB, cosa que un puerto virtual no hace.
- La cola local (`src/queue/localQueue.ts`) — lectura/escritura a disco.
- El arranque completo (`npm run start`): levanta el pipe, escanea puertos, no revienta.
- `serialport` carga correctamente en este entorno (se validó con `SerialPort.list()`).
- La consulta WMI corre sin errores en este entorno (0 puertos reales acá, así que no se pudo validar la calidad del nombre "amigable" contra un puerto de verdad — eso falta probar en una PC con hardware conectado).

Lo que **no está validado** porque no tenemos ni hardware ni una muestra
real todavía (relevante recién cuando se prenda `ENABLE_CAPTURE`):

| Supuesto | Dónde | Qué puede estar mal |
|---|---|---|
| El fin de un ticket se detecta por el comando de corte de papel (`GS V`) | `src/capture/portCapture.ts` | Si el POS no manda ese comando, o el driver de redirección lo filtra, la heurística principal nunca dispara — por eso hay una red de contención (`ticketBufferMaxBytes` + `ticketSilenceTimeoutMs` en `config.ts`) que entrega igual lo acumulado, pero los valores elegidos (8KB, 3s) son un supuesto más, sin validar contra pausas reales entre líneas de un ticket |
| `baudRate: 9600` | `src/capture/portCapture.ts` | Puede no importar en un puerto virtual, o puede necesitar otro valor |
| Encoding de los bytes capturados (`latin1`) | `src/capture/portCapture.ts` | Depende del driver/impresora — podría ser CP437 u otro |
| El agente inicia la conexión TCP (el periférico es el servidor) | `src/capture/tcpCapture.ts` | Si en realidad es al revés, hay que invertir a un `net.createServer()` |
| Delimitador de mensaje TCP = salto de línea | `src/capture/tcpCapture.ts` | Si el TPV real usa otro framing (longitud-prefijo, STX/ETX), hay que reemplazar la heurística — probado solo contra un TPV simulado |

**Nota sobre datáfonos/TPVs:** esto captura lo que el periférico emite
por su puerto/socket, igual que con la impresora — **no interpreta ni
toca datos de tarjeta** (PAN, pista, CVV). Eso mantiene al agente fuera
del alcance de PCI-DSS. Si en algún momento se necesitara integrar con
el protocolo de pago en sí (no solo capturar su salida), es un proyecto
distinto con requisitos de compliance propios.

## Captura: puertos serie y periféricos TCP

No todo lo que hay que capturar es un puerto COM. Un TPV/datáfono moderno
muy comúnmente integra por socket TCP o API JSON en vez de un puerto
serie — así que la captura está armada como una interfaz común
(`CaptureHandle`, en `src/capture/types.ts`) con dos implementaciones hoy:

- **`capture/portCapture.ts`** — puertos serie (COM), descubiertos
  dinámicamente por `ports/portScanner.ts` en cada escaneo.
- **`capture/tcpCapture.ts`** — periféricos TCP, que **no se descubren
  solos** (no hay "escaneo de red") — se configuran a mano por
  `TCP_PERIPHERALS` (ver más abajo). El agente se conecta como cliente y
  reintenta indefinidamente si se cae la conexión.

Agregar un mecanismo nuevo (ej. HID por USB) es cuestión de escribir una
tercera implementación de `CaptureHandle` — el resto del pipeline
(cola, subida a la nube, reporte al viewer) no cambia.

Probado de punta a punta con un TPV simulado por TCP en este entorno: el
agente se conectó, recibió mensajes JSON delimitados por salto de línea,
y los encoló igual que un ticket de impresora.

## Estructura

```
src/
├── index.ts                     # arma todo: puertos + TCP → captura → cola cruda → nube → pipe
├── config.ts
├── ports/portScanner.ts          # SerialPort.list() + nombres WMI
├── capture/
│   ├── types.ts                  # CaptureHandle — contrato común
│   ├── portCapture.ts             # puertos serie (COM)
│   └── tcpCapture.ts               # periféricos TCP (TPVs/datáfonos modernos)
├── queue/localQueue.ts            # cola persistida en JSON, guarda el texto crudo
└── cloud/uploadClient.ts          # POST del crudo a CLOUD_UPLOAD_URL
```

No hay carpeta `parsing/` — el parser de ejemplo que se había escrito
contra fixtures sintéticas quedó en el historial de
`print-capture-agent-pipe-server` (que conserva las fixtures) como
referencia de la forma que puede tomar el parser del lado servidor, pero
ya no forma parte de este proyecto.

## Variables de entorno

| Variable | Default | Uso |
|---|---|---|
| `CLOUD_UPLOAD_URL` | `https://example.invalid/api/tickets` | endpoint al que se sube el texto crudo del ticket |
| `CLOUD_API_KEY` | *(vacío)* | compatibilidad con instalaciones antiguas/no interactivas. En una instalación nueva se omite: el agente pide un código y guarda su propia key |
| `CLOUD_ACTIVATION_URL` | derivada de `CLOUD_UPLOAD_URL` | `POST /agents/activate`, usado una sola vez al vincular el robot |
| `CLOUD_HEARTBEAT_URL` | derivada de `CLOUD_UPLOAD_URL` | `POST /agents/heartbeat`, autenticado con la key individual |
| `AGENT_CREDENTIALS_FILE` | `./data/credentials.json` | credencial individual persistida después de la activación (el directorio `data/` está ignorado por Git) |
| `AGENT_NAME` | nombre de la PC | nombre sugerido en la activación; también se usa con `CLOUD_API_KEY` legacy |
| `AGENT_LOCATION_LABEL`, `AGENT_CITY`, `AGENT_LAT`, `AGENT_LNG` | *(vacío)* | ubicación opcional que se envía en cada heartbeat y aparece en el dashboard |
| `HEARTBEAT_INTERVAL_MS` | `60000` | frecuencia del heartbeat; el dashboard considera online hasta 2 minutos desde el último |
| `QUEUE_FILE` | `./data/queue.json` | dónde persiste la cola local |
| `ENABLE_CAPTURE` | `false` | en `"true"`, empieza a abrir los puertos detectados (y a conectar los periféricos TCP configurados) para leer datos. Mientras esté apagado, el agente solo identifica y reporta |
| `TCP_PERIPHERALS` | `[]` | JSON con los periféricos TCP a conectar, ej. `[{"id":"datafono-caja1","description":"TPV caja 1","host":"192.168.1.50","port":9000}]` — no hay descubrimiento automático para estos, hay que declarar la IP |

## Cómo correrlo

```bash
npm install
npm run start   # arranca el servicio (escanea puertos reales de esta PC)
```

En el primer arranque interactivo, si no existe `CLOUD_API_KEY` ni el
archivo de credenciales, se pide el código `XXXXX-XXXXX` y un nombre para
el robot. El código se canjea una sola vez; los siguientes arranques leen
`data/credentials.json` y no vuelven a preguntar. Para reactivar la misma
instalación con otro código hay que retirar explícitamente ese archivo.

Al arrancar, se conecta como servidor al pipe
`\\.\pipe\print-capture-agent` — si el agent-status-viewer está abierto,
debería mostrar "Activo" apenas arranca (aunque sin puertos/tickets si no
hay ninguna impresora conectada a esta PC).

## Tests

```bash
npm test
```

Corre con el test runner nativo de Node (`node:test`, vía `tsx --test` —
sin dependencias nuevas). Cubre:
- `queue/localQueue.test.ts` — persistencia, `getDue`/backoff, y el caso
  de concurrencia real (muchos `enqueue`/`markSent`/`markFailed` disparados
  en paralelo sin corromper el archivo).
- `cloud/backoff.test.ts` — clasificación de errores HTTP y el cálculo de
  backoff exponencial con techo.
- `capture/ticketBufferer.test.ts` — extracción de múltiples tickets en un
  mismo chunk, tickets partidos entre chunks, y las dos redes de
  contención (tamaño máximo, timeout de silencio).

## Siguiente paso real

1. **Validar la detección de puertos en una PC real** del negocio: ¿aparecen
   bien identificados el puerto redirigido y el de Bluetooth SPP? ¿el
   nombre "amigable" de WMI es útil o hay que ajustarlo?
2. Recién con eso confirmado, prender `ENABLE_CAPTURE=true` y validar los
   supuestos de captura de la tabla de arriba (idealmente con datos de
   bajo riesgo primero, no en el POS de producción de un negocio real).
3. Escribir el parser real del lado del servidor (`ticket-parsing-cloud`).
