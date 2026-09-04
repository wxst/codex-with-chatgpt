import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace, type WorkspaceIdentity } from "../workspace/manager.js";
import { getStateDir, stateSubdir } from "../config/paths.js";
import {
  findLiveBridge,
  listRuntimeStates,
  probeBridge,
  removeRuntimeStateGeneration,
  runtimeIdentity,
  type RuntimeState,
} from "../bridge/runtime.js";
import {
  processExists,
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
import {
  OPENAI_TUNNEL_TOKEN_FILE_ENV,
  openAITunnelTokenFile,
  readTransportMode,
} from "../tunnel/transport-mode.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const GRACEFUL_STOP_MS = 750;
const SIGNAL_STOP_MS = 750;
const FORCE_STOP_MS = 1500;
const LEGACY_AUTHENTICATED_STOP_MS = 5_000;
const LEGACY_EXIT_CONFIRM_MS = 750;
const STOP_POLL_MS = 50;
const PENDING_START_ENV = "C2C_PENDING_START_ID";
const STATE_DIR_ENV = "C2C_STATE_DIR";

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
 * Pin the parent's state directory and credential file into the detached child
 * environment. The child must use the same lifecycle registry, runtime files,
 * and security boundary rather than rediscovering them from another context.
 */
export function bridgeDaemonEnvironment(
  workspace: Workspace,
  base: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const environment = { ...base };
  for (const key of Object.keys(environment)) {
    const normalizedKey = key.toUpperCase();
    if (normalizedKey === STATE_DIR_ENV || normalizedKey === OPENAI_TUNNEL_TOKEN_FILE_ENV) {
      delete environment[key];
    }
  }
  environment[STATE_DIR_ENV] = getStateDir();
  if (readTransportMode(workspace.id) === "openai") {
    environment[OPENAI_TUNNEL_TOKEN_FILE_ENV] = openAITunnelTokenFile(workspace.id);
  }
  return environment;
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

export interface BridgeStartupWaitOptions {
  timeoutMs?: number;
  pollMs?: number;
  findLive?: (workspaceId: string) => Promise<RuntimeState | null>;
  sleep?: (ms: number) => Promise<void>;
  stopBridge?: (workspaceRoot: string) => Promise<boolean>;
}

/**
 * Wait for one detached daemon launch to publish a usable runtime. Every
 * unsuccessful outcome is cleaned up through the same lifecycle-fenced stop
 * path used by explicit stop/restart/transport changes. If the child has not
 * consumed its pending intent, stop cancels it before the child can proceed. If
 * the child consumed the intent and published a runtime just before cleanup,
 * stop drains that exact process generation instead of leaving a Bridge alive
 * after the caller has already observed startup failure.
 */
export async function waitForBridgeStartup(
  workspace: Workspace,
  child: Pick<ChildProcess, "exitCode">,
  pendingStartId: string,
  logFile: string,
  options: BridgeStartupWaitOptions = {}
): Promise<RuntimeState> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const pollMs = options.pollMs ?? 300;
  const findLive = options.findLive ?? findLiveBridge;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopWorkspace = options.stopBridge ?? stopBridge;

  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(pollMs);
      const runtime = await findLive(workspace.id);
      if (runtime) return runtime;
      if (child.exitCode !== null && child.exitCode !== 0) {
        throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
      }
    }
    throw new Error(`Bridge did not become healthy within ${Math.ceil(timeoutMs / 1000)}s. See ${logFile}`);
  } catch (startupError) {
    try {
      const cleanupConfirmed = await stopWorkspace(workspace.root);
      if (!cleanupConfirmed) {
        throw new Error("Failed-start cleanup was not confirmed by the workspace lifecycle fence");
      }
    } catch (cleanupError) {
      throw new AggregateError(
        [startupError, cleanupError],
        "Bridge startup failed and the workspace could not be fully fenced during cleanup"
      );
    }
    throw startupError;
  }
}

export async function ensureBridge(workspaceRoot: string): Promise<{ runtime: RuntimeState; spawned: boolean }> {
  const workspace = new Workspace(workspaceRoot);
  const lock = await acquireWorkspaceLifecycleLock(workspace.id);
  let child: ChildProcess | null = null;
  let pendingStartId: string | null = null;
  const logFile = daemonLogFile(workspace.id);

  try {
    const existing = await findLiveBridge(workspace.id);
    if (existing) return { runtime: existing, spawned: false };

    const pending = createPendingStart(workspace.id);
    pendingStartId = pending.startId;
    const logFd = openPrivateAppendFile(logFile);
    const entry = cliEntry();
    try {
      child = spawn(entry.cmd, [...entry.args, "serve", "--workspace", workspace.root], {
        detached: true,
        stdio: ["ignore", logFd, logFd],
        env: { ...bridgeDaemonEnvironment(workspace), [PENDING_START_ENV]: pending.startId },
        windowsHide: true,
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

  if (!child || !pendingStartId) {
    if (pendingStartId) cancelPendingStart(workspace.id, pendingStartId);
    throw new Error(`Bridge process could not be spawned. See ${logFile}`);
  }

  const runtime = await waitForBridgeStartup(workspace, child, pendingStartId, logFile);
  return { runtime, spawned: true };
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

export async function stopBridgeRuntimeForWorkspaceIdentity(
  workspace: WorkspaceIdentity,
  runtime: RuntimeState
): Promise<boolean> {
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

export async function stopBridgeRuntime(workspaceRoot: string, runtime: RuntimeState): Promise<boolean> {
  return stopBridgeRuntimeForWorkspaceIdentity(new Workspace(workspaceRoot), runtime);
}

/**
 * Stop every persisted Bridge generation for one workspace, including exact
 * generations whose admin endpoint is paused or wedged. The lifecycle lock
 * prevents a new pending start from being published while pending intents are
 * cancelled and the runtime registry is drained. A stale/dead exact generation
 * may be removed, but an unknown generation, surviving pending intent, or a
 * still-responsive workspace endpoint keeps the result fail-closed.
 */
export async function stopBridgeWithinLifecycleLock(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
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
        // recycled PID; endpoint verification still catches a replacement.
        stopped = true;
      } else {
        stopped = await stopBridgeRuntime(workspace.root, runtime);
      }
    } else {
      // A generationless runtime can be considered dead only when the
      // numeric PID is positively absent. A reused/live PID remains
      // conservative and is never signalled without authenticated identity.
      stopped = await stopBridgeRuntime(workspace.root, runtime);
      if (!stopped && !processExists(runtime.pid)) stopped = true;
    }

    if (stopped) {
      if (!runtime.processGeneration) stoppedLegacy.add(runtimeIdentity(runtime));
      removeRuntimeStateGeneration(runtime);
    } else {
      allStopped = false;
    }
  }

  for (const port of observedPorts) {
    const health = await probeBridge(port, 1000);
    if (health?.service === SERVICE_NAME && health.workspaceId === workspace.id && health.status === "ok") {
      allStopped = false;
    }
  }

  for (const runtime of listRuntimeStates(workspace.id)) {
    observedPorts.add(runtime.port);
    if (runtime.processGeneration) {
      if (processGenerationStatus(runtime.pid, runtime.processGeneration) !== "mismatch") {
        allStopped = false;
      }
    } else if (!stoppedLegacy.has(runtimeIdentity(runtime)) && processExists(runtime.pid)) {
      allStopped = false;
    }
  }

  if (listPendingStarts(workspace.id).length !== 0) allStopped = false;
  if (!allStopped) {
    throw new Error(`One or more Bridge generations for workspace ${workspace.id} could not be fully stopped`);
  }
  return true;
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const lock = await acquireWorkspaceLifecycleLock(workspace.id);
  try {
    return await stopBridgeWithinLifecycleLock(workspace.root);
  } finally {
    lock.release();
  }
}
