import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../workspace/manager.js";
import { stateSubdir } from "../config/paths.js";
import { findLiveBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { withWorkspaceLifecycleLock } from "./workspace-lock.js";

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

/**
 * Open a daemon log for append while repairing permissions on reused files.
 * Existing files do not honor the mode argument to open(2), so POSIX systems
 * explicitly fchmod and verify the descriptor before any bridge output is
 * handed to it.
 */
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

  // This cross-process lock is the correctness boundary for check-and-spawn.
  // A second CLI invocation, or an overlapping `unpair`, must not pass the
  // live-bridge check while another lifecycle operation is still in flight.
  return withWorkspaceLifecycleLock(workspace.id, async () => {
    const existing = await findLiveBridge(workspace.id);
    if (existing) return { runtime: existing, spawned: false };

    const logFile = daemonLogFile(workspace.id);
    const logFd = openPrivateAppendFile(logFile);
    const entry = cliEntry();
    const child = spawn(entry.cmd, [...entry.args, "serve", "--workspace", workspace.root], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    child.unref();
    fs.closeSync(logFd);

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
  });
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
  workspaceId?: string;
  workspaceRoot?: string;
  port?: number;
  pid?: number;
  startedAt?: string;
}

function runtimeIdentityMatches(expected: RuntimeState, actual: AdminRuntimeIdentity): boolean {
  return (
    actual.workspaceId === expected.workspaceId &&
    actual.pid === expected.pid &&
    actual.port === expected.port &&
    actual.startedAt === expected.startedAt
  );
}

/**
 * Stop one exact bridge runtime generation.
 *
 * The runtime file can be stale and its PID can be reused by an unrelated
 * process. Destructive process signaling is therefore intentionally avoided.
 * We only request shutdown after the runtime's secret admin token authenticates
 * to the endpoint and `/admin/info` proves pid/start-time/port identity.
 */
export async function stopBridgeRuntime(workspaceRoot: string, runtime: RuntimeState): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  if (runtime.workspaceId !== workspace.id || path.resolve(runtime.workspaceRoot) !== workspace.root) return false;

  let info: AdminRuntimeIdentity;
  try {
    info = await adminFetch<AdminRuntimeIdentity>(runtime, "GET", "/admin/info", 2000);
  } catch {
    return false;
  }
  if (!runtimeIdentityMatches(runtime, info)) return false;

  try {
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
    return true;
  } catch {
    // Fail safe: do not fall back to PID-level SIGTERM. A PID can be recycled
    // after the authenticated identity check, and an unrelated process must
    // never be signaled from a stale runtime file.
    return false;
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;
  return stopBridgeRuntime(workspace.root, runtime);
}
