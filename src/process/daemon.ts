import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../workspace/manager.js";
import { stateSubdir } from "../config/paths.js";
import { findLiveBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { processGenerationMatches } from "./process-identity.js";
import { acquireWorkspaceLifecycleLock } from "./workspace-lock.js";
import { SERVICE_NAME } from "../version.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));

/** Resolve the CLI entry for both built installs and source-mode development. */
function cliEntry(): { cmd: string; args: string[] } {
  const distEntry = path.resolve(moduleDir, "..", "cli", "index.js");
  if (fs.existsSync(distEntry)) {
    return { cmd: process.execPath, args: [distEntry] };
  }

  const projectRoot = path.resolve(moduleDir, "..", "..");
  const tsEntry = path.join(projectRoot, "src", "cli", "index.ts");
  return { cmd: process.execPath, args: ["--import", "tsx/esm", tsEntry] };
}

function daemonLogFile(workspaceId: string): string {
  return path.join(stateSubdir("logs"), `bridge-${workspaceId}.out.log`);
}

export function openPrivateAppendFile(file: string): number {
  const fd = fs.openSync(file, "a", 0o600);
  try {
    if (process.platform === "win32") {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {
        // Windows ACLs do not reliably map to POSIX mode bits.
      }
      return fd;
    }

    fs.fchmodSync(fd, 0o600);
    const mode = fs.fstatSync(fd).mode & 0o777;
    if (mode !== 0o600) {
      throw new Error(`Daemon log permissions are not owner-only (expected 0600): ${file}`);
    }
    return fd;
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export async function ensureBridge(workspaceRoot: string): Promise<{ runtime: RuntimeState; spawned: boolean }> {
  const workspace = new Workspace(workspaceRoot);
  const lock = await acquireWorkspaceLifecycleLock(workspace.id);
  let child: ChildProcess | null = null;
  const logFile = daemonLogFile(workspace.id);

  try {
    const existing = await findLiveBridge(workspace.id);
    if (existing) return { runtime: existing, spawned: false };

    const logFd = openPrivateAppendFile(logFile);
    const entry = cliEntry();
    try {
      child = spawn(entry.cmd, [...entry.args, "serve", "--workspace", workspace.root], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env },
      });
    } finally {
      fs.closeSync(logFd);
    }
    child.unref();
  } finally {
    lock.release();
  }

  if (!child) throw new Error(`Bridge process could not be spawned. See ${logFile}`);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

interface AdminRuntimeIdentity {
  service?: string;
  workspaceId?: string;
  workspaceRoot?: string;
  port?: number;
  pid?: number;
  processGeneration?: string | null;
  startedAt?: string;
}

function runtimeIdentityMatches(expected: RuntimeState, actual: AdminRuntimeIdentity): boolean {
  return (
    actual.service === SERVICE_NAME &&
    actual.workspaceId === expected.workspaceId &&
    typeof actual.workspaceRoot === "string" &&
    path.resolve(actual.workspaceRoot) === path.resolve(expected.workspaceRoot) &&
    actual.pid === expected.pid &&
    actual.port === expected.port &&
    actual.startedAt === expected.startedAt &&
    (!expected.processGeneration || actual.processGeneration === expected.processGeneration)
  );
}

/**
 * Signal only a cryptographically/state-file-bound OS process generation. The
 * generation is re-read immediately before SIGTERM, so a stale numeric PID can
 * never authorize signaling a replacement process.
 */
function signalExactGeneration(runtime: RuntimeState, fallbackGeneration?: string | null): boolean {
  const generation = runtime.processGeneration ?? fallbackGeneration ?? null;
  if (!generation || !processGenerationMatches(runtime.pid, generation)) return false;
  try {
    process.kill(runtime.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop one exact bridge runtime generation. Prefer authenticated graceful
 * shutdown. If the admin endpoint is paused/hung, safely escalate only when the
 * persisted/authenticated OS process generation still matches immediately
 * before SIGTERM.
 */
export async function stopBridgeRuntime(workspaceRoot: string, runtime: RuntimeState): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  if (runtime.workspaceId !== workspace.id || path.resolve(runtime.workspaceRoot) !== workspace.root) return false;

  let info: AdminRuntimeIdentity | null = null;
  try {
    info = await adminFetch<AdminRuntimeIdentity>(runtime, "GET", "/admin/info", 2000);
  } catch {
    // No application-level response, but a modern runtime snapshot still gives
    // us a safe process-generation proof for termination.
    return signalExactGeneration(runtime);
  }

  if (!runtimeIdentityMatches(runtime, info)) {
    // If the endpoint identity drifted, only the persisted exact process
    // generation can authorize terminating the old recorded bridge.
    return signalExactGeneration(runtime);
  }

  try {
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
    return true;
  } catch {
    return signalExactGeneration(runtime, info.processGeneration);
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;
  return stopBridgeRuntime(workspace.root, runtime);
}
