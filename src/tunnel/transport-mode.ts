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

function enforceOwnerOnlyPermissions(file: string): void {
  if (process.platform === "win32") {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows ACL semantics do not reliably map to POSIX mode bits.
    }
    return;
  }

  // On POSIX, failure to make the credential owner-only is a security error.
  // Do not continue using a token whose confidentiality cannot be guaranteed.
  fs.chmodSync(file, 0o600);
  const mode = fs.statSync(file).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`OpenAI tunnel token permissions are not owner-only (expected 0600): ${file}`);
  }
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
  let existing: string | null = null;
  try {
    existing = fs.readFileSync(file, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (existing && /^c2c_tunnel_[A-Za-z0-9_-]{43}$/.test(existing)) {
    // Restores/copies may recreate a valid credential with permissive mode.
    // Permission repair is outside the read catch so POSIX failures propagate.
    enforceOwnerOnlyPermissions(file);
    return existing;
  }

  const token = `c2c_tunnel_${randomBytes(32).toString("base64url")}`;
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, token + "\n", { mode: 0o600 });
  enforceOwnerOnlyPermissions(file);
  return token;
}

/**
 * Remove the per-workspace OpenAI tunnel credential. Callers that have a live
 * bridge must stop it before reporting revocation complete, because a running
 * process has already loaded the previous token into memory.
 */
export function revokeOpenAITunnelToken(workspaceId: string): boolean {
  const file = openAITunnelTokenFile(workspaceId);
  try {
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
