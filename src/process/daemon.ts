import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../workspace/manager.js";
import { stateSubdir } from "../config/paths.js";
import {
  findLiveBridge,
  listRuntimeStates,
  probeBridge,
  removeRuntimeStateGeneration,
  runtimeIdentity,
  type RuntimeState,
} from "../bridge/runtime.js";
import {
  processGenerationStatus,
  signalExactProcessGeneration,
} from "./process-identity.js";
import { acquireWorkspaceLifecycleLock } from "./workspace-lock.js";
import {
  cancelPendingStart,
  cancelPendingStarts,
  createPendingStart,
  listPendingStarts,
} from "./startup-registry.js";
import { SERVICE_NAME } from "../version.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const GRACEFUL_STOP_MS = 750;
const SIGNAL_STOP_MS = 750;
const FORCE_STOP_MS = 1500;
const LEGACY_AUTHENTICATED_STOP_MS = 5_000;
const LEGACY_EXIT_CONFIRM_MS = 750;
const STOP_POLL_MS = 50;
const PENDING_START_ENV = "C2C_PENDING_START_ID";

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

    const pending = createPendingStart(workspace.id);
    const logFd = openPrivateAppendFile(logFile);
    const entry = cliEntry();
    try {
      child = spawn(entry.cmd, [...entry.args, "serve", "--workspace", workspace.root], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...process.env, [PENDING_START_ENV]: pending.startId },
      });
    } catch (error) {
      cancelPendingStart(workspace.id, pending.startId);
      throw error;
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

function exactGeneration(runtime: RuntimeState, fallbackGeneration?: string | null): string | null {
  return runtime.processGeneration ?? fallbackGeneration ?? null;
}

function numericPidExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/**
 * Return true only after the exact recorded process generation is positively
 * confirmed gone. A temporary identity-query failure (`unknown`) must never be
 * accepted as exit; it simply keeps the wait alive until the deadline.
 */
export async function waitForExactGenerationExit(
  runtime: RuntimeState,
  generation: string,
  timeoutMs: number
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (processGenerationStatus(runtime.pid, generation) === "mismatch") return true;
    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }
  return processGenerationStatus(runtime.pid, generation) === "mismatch";
}

async function waitForAuthenticatedLegacyExit(runtime: RuntimeState, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let absenceSince: number | null = null;

  while (Date.now() < deadline) {
    let authenticatedEndpointPresent = false;
    try {
      const info = await adminFetch<AdminRuntimeIdentity>(runtime, "GET", "/admin/info", 500);
      authenticatedEndpointPresent = runtimeIdentityMatches(runtime, info);
    } catch {
      authenticatedEndpointPresent = false;
    }

    const pidPresent = numericPidExists(runtime.pid);
    if (!authenticatedEndpointPresent && !pidPresent) {
      absenceSince ??= Date.now();
      if (Date.now() - absenceSince >= LEGACY_EXIT_CONFIRM_MS) return true;
    } else {
      absenceSince = null;
    }

    await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
  }

  return false;
}

function signalExactGeneration(
  runtime: RuntimeState,
  generation: string | null,
  signal: NodeJS.Signals
): boolean {
  if (!generation) return false;
  return signalExactProcessGeneration(runtime.pid, generation, signal);
}

async function terminateExactGeneration(
  runtime: RuntimeState,
  generation: string | null,
  firstSignal: NodeJS.Signals | null
): Promise<boolean> {
  if (!generation) return false;

  // Only a confirmed mismatch means this exact process generation is gone.
  // Both `match` and `unknown` remain potentially live. Atomic signaling is
  // safe to attempt in either case because the pidfd/native-handle helper
  // independently binds and validates the exact generation before signaling.
  if (processGenerationStatus(runtime.pid, generation) === "mismatch") return true;

  if (firstSignal) {
    if (!signalExactGeneration(runtime, generation, firstSignal)) {
      return processGenerationStatus(runtime.pid, generation) === "mismatch";
    }
    if (await waitForExactGenerationExit(runtime, generation, SIGNAL_STOP_MS)) return true;
  } else if (await waitForExactGenerationExit(runtime, generation, GRACEFUL_STOP_MS)) {
    return true;
  }

  if (processGenerationStatus(runtime.pid, generation) === "mismatch") return true;
  if (!signalExactGeneration(runtime, generation, "SIGKILL")) {
    return processGenerationStatus(runtime.pid, generation) === "mismatch";
  }
  return waitForExactGenerationExit(runtime, generation, FORCE_STOP_MS);
}

export async function stopBridgeRuntime(workspaceRoot: string, runtime: RuntimeState): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  if (runtime.workspaceId !== workspace.id || path.resolve(runtime.workspaceRoot) !== workspace.root) return false;

  let info: AdminRuntimeIdentity | null = null;
  try {
    info = await adminFetch<AdminRuntimeIdentity>(runtime, "GET", "/admin/info", 2000);
  } catch {
    return terminateExactGeneration(runtime, exactGeneration(runtime), "SIGTERM");
  }

  const generation = exactGeneration(runtime, info.processGeneration);
  if (!runtimeIdentityMatches(runtime, info)) {
    return terminateExactGeneration(runtime, generation, "SIGTERM");
  }

  try {
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
    if (!generation) {
      return waitForAuthenticatedLegacyExit(runtime, LEGACY_AUTHENTICATED_STOP_MS);
    }
    return terminateExactGeneration(runtime, generation, null);
  } catch {
    return terminateExactGeneration(runtime, generation, "SIGTERM");
  }
}

/**
 * Stop every persisted Bridge generation for one workspace, including exact
 * generations whose admin endpoint is paused or wedged. The lifecycle lock
 * prevents a new pending start from being published while pending intents are
 * cancelled and the runtime registry is drained. A stale/dead exact generation
 * may be removed, but an unknown generation, surviving pending intent, or a
 * still-responsive workspace endpoint keeps the result fail-closed.
 */
export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const lock = await acquireWorkspaceLifecycleLock(workspace.id);

  try {
    const cancelledPending = cancelPendingStarts(workspace.id);
    if (listPendingStarts(workspace.id).length !== 0) {
      throw new Error(`Pending bridge starts remain after cancellation for workspace ${workspace.id}`);
    }

    const runtimes = listRuntimeStates(workspace.id);
    if (runtimes.length === 0) return cancelledPending > 0;

    let allStopped = true;
    const observedPorts = new Set<number>();
    const stoppedLegacy = new Set<string>();

    for (const runtime of runtimes) {
      observedPorts.add(runtime.port);
      let stopped = false;

      if (runtime.processGeneration) {
        const status = processGenerationStatus(runtime.pid, runtime.processGeneration);
        if (status === "mismatch") {
          // The exact recorded generation is positively gone. Do not signal a
          // recycled PID; the port-level verification below still catches an
          // untracked replacement Bridge using the stale snapshot's endpoint.
          stopped = true;
        } else {
          stopped = await stopBridgeRuntime(workspace.root, runtime);
        }
      } else {
        // A generationless legacy runtime is stopped only through its exact
        // authenticated endpoint. We deliberately do not use a bare PID probe
        // here: PID reuse must neither authorize signaling nor turn an unrelated
        // process into a Bridge identity.
        stopped = await stopBridgeRuntime(workspace.root, runtime);
      }

      if (stopped) {
        if (!runtime.processGeneration) stoppedLegacy.add(runtimeIdentity(runtime));
        removeRuntimeStateGeneration(runtime);
      } else {
        allStopped = false;
      }
    }

    // A stale snapshot can point at a different Bridge generation on the same
    // port. Never report success while any observed endpoint still identifies
    // this workspace, even when the stale admin token cannot authenticate it.
    for (const port of observedPorts) {
      const health = await probeBridge(port, 1000);
      if (health?.service === SERVICE_NAME && health.workspaceId === workspace.id && health.status === "ok") {
        allStopped = false;
      }
    }

    // Re-list after every stop attempt. New generation-bearing entries are
    // allowed to disappear only on a confirmed mismatch. A generationless
    // compatibility mirror is ignored only when this invocation already
    // completed its sustained authenticated shutdown proof.
    for (const runtime of listRuntimeStates(workspace.id)) {
      observedPorts.add(runtime.port);
      if (runtime.processGeneration) {
        if (processGenerationStatus(runtime.pid, runtime.processGeneration) !== "mismatch") {
          allStopped = false;
        }
      } else if (!stoppedLegacy.has(runtimeIdentity(runtime))) {
        allStopped = false;
      }
    }

    if (listPendingStarts(workspace.id).length !== 0) allStopped = false;
    return allStopped;
  } finally {
    lock.release();
  }
}
