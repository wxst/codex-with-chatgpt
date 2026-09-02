import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  loadOpenAITunnelToken,
  openAITunnelTokenFile,
  OPENAI_TUNNEL_TOKEN_FILE_ENV,
  readTransportMode,
  writeTransportMode,
  type TransportMode,
} from "../src/tunnel/transport-mode.js";

const originalStateDir = process.env.C2C_STATE_DIR;
const originalExplicitTokenFile = process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV];
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
  if (originalExplicitTokenFile === undefined) delete process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV];
  else process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = originalExplicitTokenFile;
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

  it("uses the workspace token file only when no explicit file was handed off", () => {
    useTempStateDir();
    delete process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV];

    expect(loadOpenAITunnelToken("workspace-unset")).toMatch(/^c2c_tunnel_/);
    expect(fs.existsSync(openAITunnelTokenFile("workspace-unset"))).toBe(true);
  });

  it.each(["", "   \t  "])("rejects an explicitly empty token file path (%j)", (value) => {
    useTempStateDir();
    process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = value;

    expect(() => loadOpenAITunnelToken("workspace-empty")).toThrow(/token file path is empty/i);
    expect(fs.existsSync(openAITunnelTokenFile("workspace-empty"))).toBe(false);
  });

  it("rejects an explicit token file path that does not exist", () => {
    const dir = useTempStateDir();
    process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = path.join(dir, "missing.token");

    expect(() => loadOpenAITunnelToken("workspace-missing")).toThrow(/ENOENT/);
    expect(fs.existsSync(openAITunnelTokenFile("workspace-missing"))).toBe(false);
  });

  it("creates the canonical handed-off token only inside the Bridge load path", () => {
    useTempStateDir();
    const file = openAITunnelTokenFile("workspace-canonical");
    process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = file;

    expect(fs.existsSync(file)).toBe(false);
    expect(loadOpenAITunnelToken("workspace-canonical")).toMatch(/^c2c_tunnel_/);
    expect(fs.existsSync(file)).toBe(true);
  });

  it.each(["", "malformed-token\n"])(
    "rejects and preserves an existing malformed canonical token file (%j)",
    (contents) => {
      useTempStateDir();
      const file = openAITunnelTokenFile("workspace-canonical-malformed");
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, contents, { mode: 0o600 });
      process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = file;

      expect(() => loadOpenAITunnelToken("workspace-canonical-malformed")).toThrow(/malformed/i);
      expect(fs.readFileSync(file, "utf8")).toBe(contents);
    }
  );
});
