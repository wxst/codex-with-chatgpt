import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TransportMode = "openai" | "cloudflare";

interface TransportState {
  workspaceId: string;
  mode: TransportMode;
  configuredAt: string;
}

export const OPENAI_TUNNEL_HEADER = "x-c2c-tunnel-token";

export function transportStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "transports", `${workspaceId}.json`);
}

export function openAITunnelTokenFile(workspaceId: string): string {
  return path.join(getStateDir(), "transports", `${workspaceId}.token`);
}

/**
 * Hardened default: use OpenAI Secure MCP Tunnel unless Cloudflare was
 * explicitly selected. Unknown or malformed state fails closed to OpenAI.
 */
export function readTransportMode(workspaceId: string): TransportMode {
  const state = readJsonIfExists<Partial<TransportState>>(transportStateFile(workspaceId));
  return state?.mode === "cloudflare" ? "cloudflare" : "openai";
}

export function writeTransportMode(workspaceId: string, mode: TransportMode): TransportMode {
  writeSecureJson(transportStateFile(workspaceId), {
    workspaceId,
    mode,
    configuredAt: new Date().toISOString(),
  } satisfies TransportState);
  return mode;
}

/**
 * Return a stable per-workspace secret used only between tunnel-client and the
 * loopback MCP endpoint. The file is owner-readable only and never belongs in
 * the repository or command-line arguments.
 */
export function ensureOpenAITunnelToken(workspaceId: string): string {
  const file = openAITunnelTokenFile(workspaceId);
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (/^c2c_tunnel_[A-Za-z0-9_-]{43}$/.test(existing)) return existing;
  } catch {
    // First use or malformed state: generate a new token below.
  }

  const token = `c2c_tunnel_${randomBytes(32).toString("base64url")}`;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Best effort on platforms without POSIX chmod semantics.
  }
  return token;
}
