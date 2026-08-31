import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists } from "../config/paths.js";
import { getProcessGeneration } from "../process/process-identity.js";
import { SERVICE_NAME, VERSION } from "../version.js";

export interface RuntimeState {
  service: string;
  version: string;
  workspaceId: string;
  workspaceRoot: string;
  pid: number;
  /** OS-derived process start/generation identity. Older runtime files may omit it. */
  processGeneration?: string | null;
  port: number;
  adminToken: string;
  publicUrl: string | null;
  startedAt: string;
}

/** Legacy/canonical compatibility mirror. New code never relies on it as a sole registry. */
export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

function runtimeRegistryDir(workspaceId: string, create: boolean): string {
  const dir = path.join(getStateDir(), "runtime-generations", workspaceId);
  return create ? ensureDir(dir) : dir;
}

export function runtimeIdentity(state: RuntimeState): string {
  return [
    state.workspaceId,
    state.pid,
    state.processGeneration ?? "",
    state.port,
    state.startedAt,
    state.adminToken,
  ].join("\u0000");
}

export function runtimeGenerationKey(state: RuntimeState): string {
  return createHash("sha256").update(runtimeIdentity(state)).digest("hex").slice(0, 40);
}

export function runtimeGenerationFile(state: RuntimeState): string {
  return path.join(runtimeRegistryDir(state.workspaceId, true), `${runtimeGenerationKey(state)}.json`);
}

function atomicPrivateWrite(file: string, payload: string): void {
  ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, payload, "utf8");
    if (process.platform !== "win32") {
      fs.fchmodSync(fd, 0o600);
    } else {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {
        // Windows ACL semantics do not reliably map to POSIX mode bits.
      }
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write error.
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Successful rename already moved the temporary path away.
    }
  }
}

function isRuntimeState(value: unknown, workspaceId: string): value is RuntimeState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<RuntimeState>;
  return (
    state.service === SERVICE_NAME &&
    typeof state.version === "string" &&
    state.workspaceId === workspaceId &&
    typeof state.workspaceRoot === "string" &&
    typeof state.pid === "number" &&
    Number.isSafeInteger(state.pid) &&
    state.pid > 0 &&
    (state.processGeneration === undefined || state.processGeneration === null || typeof state.processGeneration === "string") &&
    typeof state.port === "number" &&
    Number.isSafeInteger(state.port) &&
    state.port > 0 &&
    state.port <= 65535 &&
    typeof state.adminToken === "string" &&
    state.adminToken.length > 0 &&
    (state.publicUrl === null || typeof state.publicUrl === "string") &&
    typeof state.startedAt === "string" &&
    Number.isFinite(Date.parse(state.startedAt))
  );
}

function readRuntimeStrict(file: string, workspaceId: string): RuntimeState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`Runtime state exists but cannot be read: ${file}`, { cause: error });
  }
  if (!isRuntimeState(parsed, workspaceId)) {
    throw new Error(`Runtime state is malformed or belongs to another workspace: ${file}`);
  }
  return parsed;
}

/**
 * Publish one exact runtime generation first, then refresh the legacy canonical
 * mirror. The per-generation file is authoritative, so a crash or restored
 * canonical snapshot cannot hide a different live Bridge generation/port.
 */
export function writeRuntimeState(state: RuntimeState): void {
  const processGeneration = state.processGeneration ?? getProcessGeneration(state.pid);
  const normalized: RuntimeState = { ...state, processGeneration };
  const payload = JSON.stringify(normalized, null, 2);

  // The authoritative generation write must succeed or startup fails closed.
  atomicPrivateWrite(runtimeGenerationFile(normalized), payload);
  // The canonical file is a compatibility mirror only. A mirror update failure
  // cannot make the already-published authoritative generation disappear.
  try {
    atomicPrivateWrite(runtimeFile(normalized.workspaceId), payload);
  } catch {
    // Keep the authoritative generation; later readers include any older mirror
    // as an additional stale candidate rather than letting it hide this state.
  }
}

/** Legacy compatibility read. Security-sensitive callers should use listRuntimeStates(). */
export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

/**
 * Return every tracked generation plus the legacy mirror as an additional
 * compatibility candidate. No single canonical snapshot can replace or hide a
 * registry generation. Existing-but-unreadable/malformed state fails closed.
 */
export function listRuntimeStates(workspaceId: string): RuntimeState[] {
  const states: RuntimeState[] = [];
  const seen = new Set<string>();
  const add = (state: RuntimeState): void => {
    const key = runtimeIdentity(state);
    if (seen.has(key)) return;
    seen.add(key);
    states.push(state);
  };

  const dir = runtimeRegistryDir(workspaceId, false);
  if (fs.existsSync(dir)) {
    const names = fs.readdirSync(dir);
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      add(readRuntimeStrict(path.join(dir, name), workspaceId));
    }
  }

  const canonical = runtimeFile(workspaceId);
  if (fs.existsSync(canonical)) {
    add(readRuntimeStrict(canonical, workspaceId));
  }

  states.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return states;
}

/** Remove only one unique generation path; another Bridge's state cannot be deleted. */
export function removeRuntimeStateGeneration(state: RuntimeState): void {
  const dir = runtimeRegistryDir(state.workspaceId, false);
  if (!fs.existsSync(dir)) return;
  try {
    fs.rmSync(path.join(dir, `${runtimeGenerationKey(state)}.json`), { force: true });
  } catch {
    // Callers re-list the registry and fail closed if state remains.
  }
}

/** Explicit full cleanup retained for compatibility/tests; revocation does not use this. */
export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
  } catch {
    // ignore
  }
  try {
    fs.rmSync(runtimeRegistryDir(workspaceId, false), { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export interface HealthPayload {
  service: string;
  version: string;
  workspaceId: string;
  status: string;
}

export async function probeBridge(port: number, timeoutMs = 2000): Promise<HealthPayload | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

interface AdminRuntimeIdentity {
  service?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  pid?: number;
  processGeneration?: string | null;
  port?: number;
  startedAt?: string;
}

function exactRuntimeMatches(state: RuntimeState, info: AdminRuntimeIdentity): boolean {
  return (
    info.service === SERVICE_NAME &&
    info.workspaceId === state.workspaceId &&
    typeof info.workspaceRoot === "string" &&
    path.resolve(info.workspaceRoot) === path.resolve(state.workspaceRoot) &&
    info.pid === state.pid &&
    info.port === state.port &&
    info.startedAt === state.startedAt &&
    (!state.processGeneration || info.processGeneration === state.processGeneration)
  );
}

async function authenticatedRuntimeIsLive(state: RuntimeState): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/admin/info`, {
      headers: { Authorization: `Bearer ${state.adminToken}` },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    return exactRuntimeMatches(state, (await response.json()) as AdminRuntimeIdentity);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Return a usable exact runtime, never a stale canonical snapshot that merely shares a port. */
export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  for (const state of listRuntimeStates(workspaceId)) {
    if (await authenticatedRuntimeIsLive(state)) return state;
  }
  return null;
}

export { SERVICE_NAME, VERSION };
