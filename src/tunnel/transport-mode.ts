import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";

export type TransportMode = "openai" | "cloudflare";

interface TransportState {
  workspaceId: string;
  mode: TransportMode;
  configuredAt: string;
}

export const OPENAI_TUNNEL_HEADER = "x-c2c-tunnel-token";
export const OPENAI_TUNNEL_TOKEN_FILE_ENV = "C2C_OPENAI_TUNNEL_TOKEN_FILE";

const OPENAI_TUNNEL_TOKEN_PATTERN = /^c2c_tunnel_[A-Za-z0-9_-]{43}$/;

export function isLocalAbsoluteTokenPath(value: string, platform = process.platform): boolean {
  if (platform === "win32") {
    return path.win32.isAbsolute(value) && /^[A-Za-z]:[\\/]/.test(value);
  }
  return path.posix.isAbsolute(value) && !value.startsWith("//");
}

export function transportStateFile(workspaceId: string): string {
  return path.join(getStateDir(), "transports", `${workspaceId}.json`);
}

export function openAITunnelTokenFile(workspaceId: string): string {
  return path.join(getStateDir(), "transports", `${workspaceId}.token`);
}

function enforceOwnerOnlyPermissions(file: string, descriptor: number): void {
  if (process.platform === "win32") {
    try {
      fs.fchmodSync(descriptor, 0o600);
    } catch {
      // Windows ACL semantics do not reliably map to POSIX mode bits.
    }
    return;
  }

  // On POSIX, failure to make the credential owner-only is a security error.
  // Do not continue using a token whose confidentiality cannot be guaranteed.
  fs.fchmodSync(descriptor, 0o600);
  const mode = fs.fstatSync(descriptor).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`OpenAI tunnel token permissions are not owner-only (expected 0600): ${file}`);
  }
}

function normalizedRealPath(file: string): string {
  const resolved = path.normalize(path.resolve(file));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function assertNoLinkedWindowsDirectoryComponent(directory: string): void {
  if (process.platform !== "win32") return;
  const root = path.parse(directory).root;
  const relative = path.relative(root, directory);
  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let cursor = root;
  for (const segment of ["", ...segments]) {
    if (segment) cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor, { bigint: true });
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`OpenAI tunnel token directory must be local without symbolic links: ${cursor}`);
    }
  }
}

function realPathMatchesIdentity(
  requestedPath: string,
  realPath: string,
  requestedStat: fs.BigIntStats
): boolean {
  if (process.platform !== "win32") {
    return normalizedRealPath(realPath) === normalizedRealPath(requestedPath);
  }
  const realStat = fs.lstatSync(realPath, { bigint: true });
  return sameFileIdentity(requestedStat, realStat);
}

function requireCurrentPosixOwner(stat: fs.BigIntStats, label: string): void {
  if (process.platform === "win32" || typeof process.getuid !== "function") return;
  if (stat.uid !== BigInt(process.getuid())) {
    throw new Error(`OpenAI tunnel token ${label} is not owned by the current account`);
  }
}

function requireLocalAbsoluteTokenPath(file: string): string {
  if (!isLocalAbsoluteTokenPath(file)) {
    throw new Error(`OpenAI tunnel token path must be local and absolute: ${file}`);
  }
  return path.resolve(file);
}

function inspectLocalRegularFile(file: string): { file: string; stat: fs.BigIntStats } {
  const resolvedFile = requireLocalAbsoluteTokenPath(file);
  inspectLocalDirectory(path.dirname(resolvedFile));
  const before = fs.lstatSync(resolvedFile, { bigint: true });
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`OpenAI tunnel token must be a local regular file without symbolic links: ${resolvedFile}`);
  }
  requireCurrentPosixOwner(before, "file");

  const realFile = fs.realpathSync.native(resolvedFile);
  requireLocalAbsoluteTokenPath(realFile);
  if (!realPathMatchesIdentity(resolvedFile, realFile, before)) {
    throw new Error(`OpenAI tunnel token must be a local regular file without symbolic links: ${resolvedFile}`);
  }
  return { file: resolvedFile, stat: before };
}

function inspectLocalDirectory(
  directory: string,
  options: { allowSharedSticky?: boolean } = {}
): { directory: string; stat: fs.BigIntStats } {
  const resolvedDirectory = requireLocalAbsoluteTokenPath(directory);
  assertNoLinkedWindowsDirectoryComponent(resolvedDirectory);
  const before = fs.lstatSync(resolvedDirectory, { bigint: true });
  if (before.isSymbolicLink() || !before.isDirectory()) {
    throw new Error(`OpenAI tunnel token directory must be local without symbolic links: ${resolvedDirectory}`);
  }
  const realDirectory = fs.realpathSync.native(resolvedDirectory);
  requireLocalAbsoluteTokenPath(realDirectory);
  if (!realPathMatchesIdentity(resolvedDirectory, realDirectory, before)) {
    throw new Error(`OpenAI tunnel token directory must be local without symbolic links: ${resolvedDirectory}`);
  }
  if (process.platform !== "win32") {
    const mode = before.mode & 0o7777n;
    const writableByAnotherAccount = (mode & 0o022n) !== 0n;
    const sharedSticky = (mode & 0o1000n) !== 0n;
    if (writableByAnotherAccount && !(options.allowSharedSticky && sharedSticky)) {
      throw new Error(`OpenAI tunnel token directory permissions are not private: ${resolvedDirectory}`);
    }
    if (!options.allowSharedSticky) requireCurrentPosixOwner(before, "directory");
  }
  return { directory: resolvedDirectory, stat: before };
}

function ensureLocalDirectory(directory: string): string {
  const resolvedDirectory = requireLocalAbsoluteTokenPath(directory);
  const missing: string[] = [];
  let cursor = resolvedDirectory;
  while (true) {
    try {
      inspectLocalDirectory(cursor, { allowSharedSticky: cursor !== resolvedDirectory });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }

  for (const next of missing.reverse()) {
    try {
      fs.mkdirSync(next, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    inspectLocalDirectory(next);
  }
  return resolvedDirectory;
}

function portableOpenFlags(base: number): number {
  const portableConstants = fs.constants as typeof fs.constants & {
    O_NOFOLLOW?: number;
    O_NONBLOCK?: number;
  };
  return base | (portableConstants.O_NOFOLLOW ?? 0) | (portableConstants.O_NONBLOCK ?? 0);
}

function readRegularTokenFile(file: string): string {
  const inspected = inspectLocalRegularFile(file);
  const resolvedFile = inspected.file;

  const flags = portableOpenFlags(fs.constants.O_RDONLY);
  const descriptor = fs.openSync(resolvedFile, flags);
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || !sameFileIdentity(inspected.stat, opened)) {
      throw new Error(`OpenAI tunnel token changed while it was being opened: ${resolvedFile}`);
    }
    requireCurrentPosixOwner(opened, "file");

    const token = fs.readFileSync(descriptor, "utf8").trim();
    if (!OPENAI_TUNNEL_TOKEN_PATTERN.test(token)) {
      throw new Error(`OpenAI tunnel token file is malformed: ${resolvedFile}`);
    }

    enforceOwnerOnlyPermissions(resolvedFile, descriptor);

    const after = inspectLocalRegularFile(resolvedFile);
    if (!sameFileIdentity(opened, after.stat)) {
      throw new Error(`OpenAI tunnel token changed while it was being read: ${resolvedFile}`);
    }
    return token;
  } finally {
    fs.closeSync(descriptor);
  }
}

function removeCreatedFileIfUnchanged(file: string, identity: fs.BigIntStats): void {
  try {
    const current = fs.lstatSync(file, { bigint: true });
    if (!current.isSymbolicLink() && current.isFile() && sameFileIdentity(identity, current)) {
      fs.unlinkSync(file);
    }
  } catch {
    // The descriptor is truncated before this best-effort path cleanup.
  }
}

function writeExclusiveTokenFile(file: string, token: string): string {
  const resolvedFile = requireLocalAbsoluteTokenPath(file);
  ensureLocalDirectory(path.dirname(resolvedFile));
  const descriptor = fs.openSync(
    resolvedFile,
    portableOpenFlags(fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL),
    0o600
  );
  const opened = fs.fstatSync(descriptor, { bigint: true });
  let failure: unknown = null;
  try {
    if (!opened.isFile()) throw new Error(`OpenAI tunnel token must be a local regular file: ${resolvedFile}`);
    fs.writeFileSync(descriptor, `${token}\n`, { encoding: "utf8" });
    enforceOwnerOnlyPermissions(resolvedFile, descriptor);
    const current = inspectLocalRegularFile(resolvedFile);
    if (!sameFileIdentity(opened, current.stat)) {
      throw new Error(`OpenAI tunnel token changed while it was being created: ${resolvedFile}`);
    }
  } catch (error) {
    failure = error;
    try {
      fs.ftruncateSync(descriptor, 0);
    } catch {
      // Preserve the original validation error.
    }
  } finally {
    fs.closeSync(descriptor);
  }

  if (failure !== null) {
    removeCreatedFileIfUnchanged(resolvedFile, opened);
    throw failure;
  }
  return token;
}

function writeFreshTokenFile(file: string, token: string, replace: boolean): string {
  const resolvedFile = requireLocalAbsoluteTokenPath(file);
  const temporary = `${resolvedFile}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  if (!replace) {
    try {
      writeExclusiveTokenFile(temporary, token);
      try {
        fs.linkSync(temporary, resolvedFile);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        return readRegularTokenFile(resolvedFile);
      }
      return readRegularTokenFile(resolvedFile);
    } finally {
      try {
        fs.unlinkSync(temporary);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }

  try {
    writeExclusiveTokenFile(temporary, token);
    inspectLocalRegularFile(resolvedFile);
    fs.renameSync(temporary, resolvedFile);
    return readRegularTokenFile(resolvedFile);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
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
  try {
    return readRegularTokenFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      const token = `c2c_tunnel_${randomBytes(32).toString("base64url")}`;
      return writeFreshTokenFile(file, token, false);
    }
    if (error instanceof Error && /token file is malformed/.test(error.message)) {
      const token = `c2c_tunnel_${randomBytes(32).toString("base64url")}`;
      return writeFreshTokenFile(file, token, true);
    }
    throw error;
  }
}

/**
 * Load the parent-selected token file for a detached Bridge process. Passing a
 * file path, rather than a secret value, keeps the credential out of argv and
 * closes over environment-specific state-directory resolution.
 */
export function loadOpenAITunnelToken(workspaceId: string): string {
  const rawExplicitFile = process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV];
  if (rawExplicitFile === undefined) return ensureOpenAITunnelToken(workspaceId);

  const explicitFile = rawExplicitFile.trim();
  if (!explicitFile) {
    throw new Error(`OpenAI tunnel token file path is empty: ${OPENAI_TUNNEL_TOKEN_FILE_ENV}`);
  }

  const file = requireLocalAbsoluteTokenPath(explicitFile);
  const canonicalFile = requireLocalAbsoluteTokenPath(openAITunnelTokenFile(workspaceId));
  try {
    return readRegularTokenFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && file === canonicalFile) {
      return ensureOpenAITunnelToken(workspaceId);
    }
    throw error;
  }
}

/**
 * Read the currently configured tunnel credential without creating it.
 * Runtime authentication uses this path so an atomic rotation takes effect
 * immediately and a removed credential fails closed.
 */
export function readOpenAITunnelToken(workspaceId: string): string {
  const rawExplicitFile = process.env[OPENAI_TUNNEL_TOKEN_FILE_ENV];
  let file: string;
  if (rawExplicitFile === undefined) {
    file = openAITunnelTokenFile(workspaceId);
  } else {
    const explicitFile = rawExplicitFile.trim();
    if (!explicitFile) {
      throw new Error(`OpenAI tunnel token file path is empty: ${OPENAI_TUNNEL_TOKEN_FILE_ENV}`);
    }
    file = requireLocalAbsoluteTokenPath(explicitFile);
  }

  return readRegularTokenFile(file);
}

/**
 * Remove the per-workspace OpenAI tunnel credential. Per-request authentication
 * observes the removal immediately. Callers still stop a live Bridge so active
 * MCP sessions are closed before revocation is reported complete.
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
