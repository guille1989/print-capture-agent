// Manda un ticket de prueba real al pipeline completo, usando la api-key
// del robot activado en data/credentials.json. No pasa por la captura del
// agente (no hay hardware) — simula el paso "el agente ya capturó esto y
// lo sube", que es exactamente lo que hace uploadClient.ts en producción.
import { readFileSync } from "node:fs";

const creds = JSON.parse(readFileSync("data/credentials.json", "utf8"));
const rawText = readFileSync("../ticket-parsing-cloud/fixtures/sample-tickets/01-item-unico.txt", "utf8");

const body = {
  ticketId: crypto.randomUUID(),
  port: "PRUEBA-MANUAL",
  capturedAt: new Date().toISOString(),
  rawText,
};

const response = await fetch("https://uqa4ti7fwi.execute-api.us-east-1.amazonaws.com/prod/tickets", {
  method: "POST",
  headers: { "x-api-key": creds.apiKey, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

console.log(response.status, await response.text());
console.log("ticketId:", body.ticketId);
