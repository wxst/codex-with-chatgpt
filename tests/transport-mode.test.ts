import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readTransportMode,
  writeTransportMode,
  type TransportMode,
} from "../src/tunnel/transport-mode.js";

const originalStateDir = process.env.C2C_STATE_DIR;
const tempDirs: string[] = [];

function useTempStateDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-transport-"));
  tempDirs.push(dir);
  process.env.C2C_STATE_DIR = dir;
  return dir;
}

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("transport mode", () => {
  it("defaults new workspaces to OpenAI Secure MCP Tunnel", () => {
    useTempStateDir();
    expect(readTransportMode("workspace-a")).toBe("openai");
  });

  it.each<TransportMode>(["openai", "cloudflare"])("persists %s explicitly", (mode) => {
    useTempStateDir();
    writeTransportMode("workspace-a", mode);
    expect(readTransportMode("workspace-a")).toBe(mode);
  });

  it("fails closed to OpenAI mode when stored state is malformed", () => {
    const dir = useTempStateDir();
    const transports = path.join(dir, "transports");
    fs.mkdirSync(transports, { recursive: true });
    fs.writeFileSync(path.join(transports, "workspace-a.json"), '{"mode":"unexpected"}');
    expect(readTransportMode("workspace-a")).toBe("openai");
  });
});
