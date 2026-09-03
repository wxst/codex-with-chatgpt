import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  ensureOpenAITunnelToken,
  isLocalAbsoluteTokenPath,
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

function tryCreateFileSymlink(target: string, link: string): boolean {
  try {
    fs.symlinkSync(target, link, "file");
    return true;
  } catch (error) {
    if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
  if (originalExplicitTokenFile === undefined) delete process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV];
  else process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = originalExplicitTokenFile;
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("transport mode", () => {
  it.each(["\\\\HOST\\share\\token", "\\\\?\\C:\\fixture\\token", "\\??\\C:\\fixture\\token", "\\Device\\token", "\\rooted"])(
    "rejects an unsafe Windows credential path before filesystem access: %s",
    (unsafePath) => {
      expect(isLocalAbsoluteTokenPath(unsafePath, "win32")).toBe(false);
    }
  );

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

  it("atomically replaces a malformed canonical credential on the current platform", () => {
    useTempStateDir();
    const file = openAITunnelTokenFile("workspace-repair-malformed");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "malformed-token\n", { mode: 0o600 });

    const repaired = ensureOpenAITunnelToken("workspace-repair-malformed");
    expect(repaired).toMatch(/^c2c_tunnel_[A-Za-z0-9_-]{43}$/);
    expect(fs.readFileSync(file, "utf8")).toBe(`${repaired}\n`);
    expect(fs.readdirSync(path.dirname(file)).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("accepts a Windows 8.3 temp-path spelling when it identifies the same state directory", () => {
    if (process.platform !== "win32") return;
    const requestedStateDir = useTempStateDir();
    const realStateDir = fs.realpathSync.native(requestedStateDir);
    const token = ensureOpenAITunnelToken("workspace-short-path");
    const requestedTokenFile = openAITunnelTokenFile("workspace-short-path");

    expect(token).toMatch(/^c2c_tunnel_[A-Za-z0-9_-]{43}$/);
    expect(fs.existsSync(requestedTokenFile)).toBe(true);
    process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = requestedTokenFile;
    expect(loadOpenAITunnelToken("workspace-short-path")).toBe(token);

    // GitHub-hosted Windows exposes TEMP through RUNNER~1 while realpath expands
    // it. Other Windows hosts still exercise the same identity-based path.
    if (requestedStateDir.includes("~")) {
      expect(path.normalize(realStateDir).toLowerCase()).not.toBe(
        path.normalize(requestedStateDir).toLowerCase()
      );
    }
  });

  it("does not write a new credential through a linked state-directory ancestor", () => {
    const dir = useTempStateDir();
    const target = path.join(dir, "linked-state-target");
    const linkedState = path.join(dir, "linked-state");
    fs.mkdirSync(target);
    try {
      fs.symlinkSync(target, linkedState, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    process.env.C2C_STATE_DIR = linkedState;

    expect(() => ensureOpenAITunnelToken("workspace-linked-parent")).toThrow(/local|symbolic|linked/i);
    expect(fs.existsSync(path.join(target, "transports", "workspace-linked-parent.token"))).toBe(false);
  });

  it("does not write through a linked intermediate state-directory component", () => {
    const dir = useTempStateDir();
    const targetParent = path.join(dir, "linked-parent-target");
    const nestedState = path.join(targetParent, "nested-state");
    const linkedParent = path.join(dir, "linked-parent");
    fs.mkdirSync(nestedState, { recursive: true });
    try {
      fs.symlinkSync(targetParent, linkedParent, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }
    process.env.C2C_STATE_DIR = path.join(linkedParent, "nested-state");

    expect(() => ensureOpenAITunnelToken("workspace-linked-intermediate")).toThrow(
      /local|symbolic|linked/i
    );
    expect(fs.existsSync(path.join(nestedState, "transports", "workspace-linked-intermediate.token"))).toBe(
      false
    );
  });

  it("rejects a credential whose direct parent is writable by another POSIX account", () => {
    if (process.platform === "win32") return;
    const dir = useTempStateDir();
    const tokenDir = path.join(dir, "shared");
    const tokenFile = path.join(tokenDir, "shared.token");
    fs.mkdirSync(tokenDir, { mode: 0o777 });
    fs.chmodSync(tokenDir, 0o777);
    fs.writeFileSync(tokenFile, `c2c_tunnel_${"P".repeat(43)}\n`, { mode: 0o600 });
    process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = tokenFile;

    expect(() => loadOpenAITunnelToken("workspace-shared-parent")).toThrow(/directory permissions/i);
  });

  it("rejects an explicit token file symbolic link without changing its target", () => {
    const dir = useTempStateDir();
    const target = path.join(dir, "linked-target.token");
    const link = path.join(dir, "linked.token");
    const token = `c2c_tunnel_${"L".repeat(43)}`;
    fs.writeFileSync(target, `${token}\n`, { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    if (!tryCreateFileSymlink(target, link)) return;
    process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV] = link;

    expect(() => loadOpenAITunnelToken("workspace-linked-explicit")).toThrow(/regular file|symbolic link/i);
    expect(fs.readFileSync(target, "utf8")).toBe(`${token}\n`);
    if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });

  it("rejects a canonical token file symbolic link without changing its target", () => {
    const dir = useTempStateDir();
    const file = openAITunnelTokenFile("workspace-linked-canonical");
    const target = path.join(dir, "canonical-target.token");
    const token = `c2c_tunnel_${"C".repeat(43)}`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(target, `${token}\n`, { mode: 0o644 });
    fs.chmodSync(target, 0o644);
    if (!tryCreateFileSymlink(target, file)) return;

    expect(() => ensureOpenAITunnelToken("workspace-linked-canonical")).toThrow(/regular file|symbolic link/i);
    expect(fs.readFileSync(target, "utf8")).toBe(`${token}\n`);
    if (process.platform !== "win32") expect(fs.statSync(target).mode & 0o777).toBe(0o644);
  });
});
