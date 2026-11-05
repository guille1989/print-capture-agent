import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { resolveAgentVersion } from "./version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageVersion = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string }).version;

describe("resolveAgentVersion", () => {
  it("lee package.json cuando AGENT_VERSION no está definida", () => {
    const previous = process.env.AGENT_VERSION;
    delete process.env.AGENT_VERSION;
    try {
      assert.equal(resolveAgentVersion(), packageVersion);
    } finally {
      if (previous === undefined) delete process.env.AGENT_VERSION;
      else process.env.AGENT_VERSION = previous;
    }
  });

  it("prioriza AGENT_VERSION del entorno", () => {
    const previous = process.env.AGENT_VERSION;
    process.env.AGENT_VERSION = "9.9.9-test";
    try {
      assert.equal(resolveAgentVersion(), "9.9.9-test");
    } finally {
      if (previous === undefined) delete process.env.AGENT_VERSION;
      else process.env.AGENT_VERSION = previous;
    }
  });
});
