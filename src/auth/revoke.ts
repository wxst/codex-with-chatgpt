import { AuthStore } from "./store.js";
import {
  listRuntimeStates,
  probeBridge,
  readRuntimeState,
  removeRuntimeStateGeneration,
  runtimeIdentity,
  type HealthPayload,
  type RuntimeState,
} from "../bridge/runtime.js";
import { adminFetch, stopBridgeRuntime } from "../process/daemon.js";
import { processGenerationMatches } from "../process/process-identity.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";
import { cancelPendingStarts, listPendingStarts } from "../process/startup-registry.js";
import { readTransportMode, revokeOpenAITunnelToken, type TransportMode } from "../tunnel/transport-mode.js";
import { Workspace } from "../workspace/manager.js";
import { SERVICE_NAME } from "../version.js";

type ReadRuntimeState = (workspaceId: string) => RuntimeState | null;
type ListRuntimeStates = (workspaceId: string) => RuntimeState[];
type AdminFetch = <T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs?: number
) => Promise<T>;
type StopBridgeRuntime = (workspaceRoot: string, runtime?: RuntimeState) => Promise<boolean>;
type RevokeTunnelToken = (workspaceId: string) => boolean;
type IsProcessAlive = (pid: number) => boolean;
type ProbeBridge = (port: number, timeoutMs?: number) => Promise<HealthPayload | null>;
type RevocableAuthStore = Pick<AuthStore, "revokeAll">;

interface RuntimeIdentityPayload {
  service?: string;
  workspaceId?: string;
  pid?: number;
  port?: number;
  startedAt?: string;
  processGeneration?: string | null;
}

type RuntimeLiveness = "exact-live" | "unknown-live" | "dead";

export interface RevokeWorkspaceAccessDeps {
  /** Legacy test/compatibility single-slot reader. Production uses listRuntimeStates. */
  readRuntimeState?: ReadRuntimeState;
  listRuntimeStates?: ListRuntimeStates;
  removeRuntimeStateGeneration?: (runtime: RuntimeState) => void;
  adminFetch?: AdminFetch;
  stopBridge?: StopBridgeRuntime;
  revokeTunnelToken?: RevokeTunnelToken;
  /** Test/compatibility override. Production uses process-generation identity. */
  isProcessAlive?: IsProcessAlive;
  probeBridge?: ProbeBridge;
  /** Retained for compatibility with older callers; revocation never calls it. */
  clearRuntimeState?: (workspaceId: string) => void;
  authStoreFactory?: (workspaceId: string) => RevocableAuthStore;
  cancelPendingStarts?: (workspaceId: string) => number;
  listPendingStarts?: (workspaceId: string) => unknown[];
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
  maxRuntimeGenerations?: number;
}

export interface RevokeWorkspaceAccessResult {
  transportMode: TransportMode;
  legacyTokensRevoked: number;
  tunnelCredentialRevoked: boolean;
  bridgeStopped: boolean;
}

function authenticatedRuntimeMatches(runtime: RuntimeState, info: RuntimeIdentityPayload): boolean {
  return (
    info.service === SERVICE_NAME &&
    info.workspaceId === runtime.workspaceId &&
    info.pid === runtime.pid &&
    info.port === runtime.port &&
    info.startedAt === runtime.startedAt &&
    (!runtime.processGeneration ||
      !info.processGeneration ||
      info.processGeneration === runtime.processGeneration)
  );
}

function dedupeRuntimes(states: RuntimeState[]): RuntimeState[] {
  const seen = new Set<string>();
  const unique: RuntimeState[] = [];
  for (const state of states) {
    const key = runtimeIdentity(state);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(state);
  }
  return unique;
}

/**
 * Numeric PID existence is intentionally only conservative evidence for legacy
 * runtimes that predate process-generation stamping. PID reuse means this can
 * never authorize a signal or prove exact ownership; it can only prevent an
 * unsafe false "dead" classification when a generationless Bridge is paused.
 */
function numericPidExists(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export async function revokeWorkspaceAccess(
  workspaceRoot: string,
  deps: RevokeWorkspaceAccessDeps = {}
): Promise<RevokeWorkspaceAccessResult> {
  const workspace = new Workspace(workspaceRoot);
  return withWorkspaceLifecycleLock(workspace.id, () => revokeWorkspaceAccessLocked(workspace, deps));
}

async function revokeWorkspaceAccessLocked(
  workspace: Workspace,
  deps: RevokeWorkspaceAccessDeps
): Promise<RevokeWorkspaceAccessResult> {
  const transportMode = readTransportMode(workspace.id);
  const requestAdmin = deps.adminFetch ?? adminFetch;
  const stopExact = deps.stopBridge ?? stopBridgeRuntime;
  const healthProbe = deps.probeBridge ?? probeBridge;
  const revokeTunnel = deps.revokeTunnelToken ?? revokeOpenAITunnelToken;
  const makeStore = deps.authStoreFactory ?? ((workspaceId: string) => new AuthStore(workspaceId));
  const cancelStarts = deps.cancelPendingStarts ?? cancelPendingStarts;
  const pendingStarts = deps.listPendingStarts ?? listPendingStarts;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;
  const maxRounds = deps.maxRuntimeGenerations ?? 8;
  const failures: Error[] = [];

  const listRuntimes = (): RuntimeState[] => {
    try {
      if (deps.listRuntimeStates) return dedupeRuntimes(deps.listRuntimeStates(workspace.id));
      if (deps.readRuntimeState) {
        const legacy = deps.readRuntimeState(workspace.id);
        return legacy ? [legacy] : [];
      }
      return dedupeRuntimes(listRuntimeStates(workspace.id));
    } catch (error) {
      failures.push(new Error(`Failed to read bridge runtime registry: ${(error as Error).message}`, { cause: error }));
      return [];
    }
  };

  const removeRuntime = (runtime: RuntimeState): void => {
    try {
      if (deps.removeRuntimeStateGeneration) deps.removeRuntimeStateGeneration(runtime);
      else if (!deps.readRuntimeState && !deps.listRuntimeStates) removeRuntimeStateGeneration(runtime);
    } catch (error) {
      failures.push(new Error(`Failed to remove stale runtime generation ${runtime.pid}: ${(error as Error).message}`, { cause: error }));
    }
  };

  const cancelAllPending = (label: string): void => {
    try {
      cancelStarts(workspace.id);
    } catch (error) {
      failures.push(new Error(`${label}: ${(error as Error).message}`, { cause: error }));
    }
  };

  const pendingCount = (): number => {
    try {
      return pendingStarts(workspace.id).length;
    } catch (error) {
      failures.push(new Error(`Failed to inspect pending bridge starts: ${(error as Error).message}`, { cause: error }));
      return 1;
    }
  };

  const runtimeLiveness = async (runtime: RuntimeState): Promise<RuntimeLiveness> => {
    if (deps.isProcessAlive) return deps.isProcessAlive(runtime.pid) ? "exact-live" : "dead";

    if (runtime.processGeneration && processGenerationMatches(runtime.pid, runtime.processGeneration)) {
      return "exact-live";
    }

    try {
      const info = await requestAdmin<RuntimeIdentityPayload>(runtime, "GET", "/admin/info", 1500);
      if (authenticatedRuntimeMatches(runtime, info)) return "exact-live";
    } catch {
      // Continue to conservative endpoint/PID detection.
    }

    try {
      const health = await healthProbe(runtime.port, 1000);
      if (
        health &&
        health.service === SERVICE_NAME &&
        health.workspaceId === runtime.workspaceId &&
        health.status === "ok"
      ) {
        return "unknown-live";
      }
    } catch {
      // Continue to the generationless PID fallback below.
    }

    // Pre-hardening runtimes have no process generation. If both application
    // probes time out while the recorded numeric PID still exists, the Bridge
    // may simply be paused/wedged. Treat it as potentially live and fail closed.
    // A reused PID can cause a conservative false positive, but is never signaled.
    if (!runtime.processGeneration && numericPidExists(runtime.pid)) {
      return "unknown-live";
    }

    return "dead";
  };

  let legacyTokensRevoked = 0;
  let tunnelCredentialRevoked = false;
  let bridgeStopped = false;

  const scrubPersistedOAuth = (label: string): void => {
    try {
      legacyTokensRevoked += makeStore(workspace.id).revokeAll();
    } catch (error) {
      failures.push(new Error(`${label}: ${(error as Error).message}`, { cause: error }));
    }
  };

  const removeTunnelCredential = (label: string): void => {
    try {
      tunnelCredentialRevoked = revokeTunnel(workspace.id) || tunnelCredentialRevoked;
    } catch (error) {
      failures.push(new Error(`${label}: ${(error as Error).message}`, { cause: error }));
    }
  };

  cancelAllPending("Failed to cancel pending bridge starts");
  scrubPersistedOAuth("Failed to revoke persisted OAuth credentials");
  removeTunnelCredential("Failed to remove OpenAI tunnel credential");

  let quiescent = false;
  let lastUnknown: RuntimeState[] = [];

  for (let round = 0; round < maxRounds; round++) {
    cancelAllPending("Failed to cancel pending bridge starts during revocation");
    const runtimes = listRuntimes();
    lastUnknown = [];

    for (const runtime of runtimes) {
      const status = await runtimeLiveness(runtime);
      if (status === "dead") {
        removeRuntime(runtime);
        continue;
      }
      if (status === "unknown-live") {
        lastUnknown.push(runtime);
        continue;
      }

      try {
        const result = await requestAdmin<{ revoked?: number }>(runtime, "POST", "/admin/revoke-all");
        legacyTokensRevoked += result.revoked ?? 0;
      } catch (error) {
        failures.push(
          new Error(`Failed to revoke OAuth credentials through bridge ${runtime.pid}: ${(error as Error).message}`, {
            cause: error,
          })
        );
        scrubPersistedOAuth("Failed persisted OAuth fallback after live admin revocation failure");
      }

      try {
        const stopped = await stopExact(workspace.root, runtime);
        if (!stopped) {
          failures.push(new Error(`Failed to stop exact workspace bridge generation ${runtime.pid}`));
        }
      } catch (error) {
        failures.push(
          new Error(`Failed to request workspace bridge ${runtime.pid} shutdown: ${(error as Error).message}`, {
            cause: error,
          })
        );
      }

      const deadline = Date.now() + stopTimeoutMs;
      while (Date.now() < deadline) {
        const nextStatus = await runtimeLiveness(runtime);
        if (nextStatus !== "exact-live") {
          bridgeStopped = true;
          break;
        }
        await sleep(50);
      }
      if ((await runtimeLiveness(runtime)) === "exact-live") {
        failures.push(new Error(`Workspace bridge process ${runtime.pid} did not exit before the revocation deadline`));
      } else {
        removeRuntime(runtime);
      }

      scrubPersistedOAuth("Failed post-stop persisted OAuth credential scrub");
      removeTunnelCredential("Failed post-stop OpenAI tunnel credential scrub");
    }

    scrubPersistedOAuth("Failed round-final persisted OAuth credential scrub");
    removeTunnelCredential("Failed round-final OpenAI tunnel credential scrub");
    cancelAllPending("Failed to re-cancel pending bridge starts");
    await sleep(50);

    const confirmRuntimes = listRuntimes();
    let confirmedLive = 0;
    let confirmedUnknown = 0;
    for (const runtime of confirmRuntimes) {
      const status = await runtimeLiveness(runtime);
      if (status === "dead") {
        removeRuntime(runtime);
      } else if (status === "exact-live") {
        confirmedLive += 1;
      } else {
        confirmedUnknown += 1;
      }
    }

    if (confirmedLive === 0 && confirmedUnknown === 0 && pendingCount() === 0) {
      await sleep(50);
      cancelAllPending("Failed to cancel pending starts during final confirmation");
      const second = listRuntimes();
      let secondLive = 0;
      for (const runtime of second) {
        const status = await runtimeLiveness(runtime);
        if (status === "dead") removeRuntime(runtime);
        else secondLive += 1;
      }
      if (secondLive === 0 && pendingCount() === 0) {
        quiescent = true;
        break;
      }
    }
  }

  if (!quiescent) {
    if (lastUnknown.length > 0) {
      failures.push(
        new Error(
          `Detected ${lastUnknown.length} live same-workspace bridge endpoint(s) whose exact runtime identity could not be authenticated`
        )
      );
    }
    failures.push(new Error(`Workspace did not reach a quiescent state after ${maxRounds} runtime-registry round(s)`));
  }

  scrubPersistedOAuth("Failed final persisted OAuth credential scrub after quiescence check");
  removeTunnelCredential("Failed final OpenAI tunnel credential scrub after quiescence check");
  cancelAllPending("Failed final pending-start cancellation");

  if (pendingCount() !== 0) {
    failures.push(new Error("One or more pending bridge starts remained after revocation"));
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, "Failed to fully revoke ChatGPT access to this workspace");
  }

  return {
    transportMode,
    legacyTokensRevoked,
    tunnelCredentialRevoked,
    bridgeStopped,
  };
}
