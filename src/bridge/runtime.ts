import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, getStateDir, readJsonIfExists } from "../config/paths.js";
import { getProcessGeneration } from "../process/process-identity.js";
import { SERVICE_NAME, VERSION } from "../version.js";

/**
 * Runtime state file: how the CLI/Skill finds a running bridge for a
 * workspace. Contains the admin token, so it is 0600 and lives in the user
 * state dir, never in the project.
 */
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

export function runtimeFile(workspaceId: string): string {
  return path.join(ensureDir(path.join(getStateDir(), "runtime")), `${workspaceId}.json`);
}

/**
 * Publish runtime identity atomically. Tunnel start/stop updates occur after the
 * startup lifecycle ticket has been released, so readers such as `unpair` must
 * never observe a truncate/write intermediate state and mistake it for a
 * missing runtime. The temporary file lives in the same directory so rename is
 * an atomic replacement on supported local filesystems.
 */
export function writeRuntimeState(state: RuntimeState): void {
  const file = runtimeFile(state.workspaceId);
  const processGeneration = state.processGeneration ?? getProcessGeneration(state.pid);
  const payload = JSON.stringify({ ...state, processGeneration }, null, 2);
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

export function readRuntimeState(workspaceId: string): RuntimeState | null {
  return readJsonIfExists<RuntimeState>(runtimeFile(workspaceId));
}

export function clearRuntimeState(workspaceId: string): void {
  try {
    fs.rmSync(runtimeFile(workspaceId), { force: true });
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

/** Probe a port and check whether a healthy c2c bridge for the workspace answers. */
export async function probeBridge(
  port: number,
  timeoutMs = 2000
): Promise<HealthPayload | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetch(`http://127.0.0.1:${port}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) return null;
    const body = (await response.json()) as HealthPayload;
    if (body.service !== SERVICE_NAME) return null;
    return body;
  } catch {
    return null;
  }
}

export async function findLiveBridge(workspaceId: string): Promise<RuntimeState | null> {
  const state = readRuntimeState(workspaceId);
  if (!state) return null;
  const health = await probeBridge(state.port);
  if (health && health.workspaceId === workspaceId) return state;
  return null;
}

export { SERVICE_NAME, VERSION };
