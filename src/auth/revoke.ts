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
import {
  adminFetch,
  stopBridgeRuntime,
  stopBridgeRuntimeForWorkspaceIdentity,
} from "../process/daemon.js";
import {
  processGenerationStatus,
  type ProcessGenerationStatus,
} from "../process/process-identity.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";
import { cancelPendingStarts, listPendingStarts } from "../process/startup-registry.js";
import { readTransportMode, revokeOpenAITunnelToken, type TransportMode } from "../tunnel/transport-mode.js";
import { resolveWorkspaceIdentity, Workspace, type WorkspaceIdentity } from "../workspace/manager.js";
import {
  cleanupLegacyWindowsWorkspaceArtifacts,
  LegacyWindowsStateError,
  validateLegacyWindowsStateForCleanup,
  validateLegacyWindowsStateForCleanupUnderLock,
} from "../config/legacy-state.js";
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
type ProcessGenerationStatusFn = (pid: number, expectedGeneration: string) => ProcessGenerationStatus;

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
  /** Test override for deterministic match/mismatch/unknown generation behavior. */
  processGenerationStatus?: ProcessGenerationStatusFn;
  probeBridge?: ProbeBridge;
  /** Retained for compatibility with older callers; revocation never calls it. */
  clearRuntimeState?: (workspaceId: string) => void;
  authStoreFactory?: (workspaceId: string) => RevocableAuthStore;
  cancelPendingStarts?: (workspaceId: string) => number;
  listPendingStarts?: (workspaceId: string) => unknown[];
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
  maxRuntimeGenerations?: number;
  /** Run a synchronous state finalizer only after quiescence, while the lifecycle lock is still held. */
  afterQuiescent?: (workspaceId: string) => void;
  /** Test hook used to mutate the legacy view after lock acquisition and prove the inner fence. */
  afterLegacyLifecycleLockAcquired?: (
    workspaceId: string,
    lockNonce: string,
    legacyRoot: string
  ) => void;
}

export interface RevokeWorkspaceAccessResult {
  transportMode: TransportMode;
  legacyTokensRevoked: number;
  tunnelCredentialRevoked: boolean;
  bridgeStopped: boolean;
}

export interface RevokeLegacyWindowsWorkspaceAccessResult {
  workspaceId: string;
  removedArtifacts: number;
  alreadyClean: boolean;
  revocation: RevokeWorkspaceAccessResult | null;
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

/**
 * Quiesce one pre-migration Windows state view without exposing a general
 * C2C_STATE_DIR bypass to setup/start/serve or any other workspace command.
 */
export async function revokeLegacyWindowsWorkspaceAccess(
  workspaceRoot: string,
  deps: RevokeWorkspaceAccessDeps = {}
): Promise<RevokeLegacyWindowsWorkspaceAccessResult> {
  if (process.platform !== "win32") {
    throw new Error("Legacy Windows state cleanup is supported only on Windows");
  }
  const identity = resolveWorkspaceIdentity(workspaceRoot);
  const preflight = validateLegacyWindowsStateForCleanup(identity.id);
  if (preflight.artifacts.length === 0) {
    return {
      workspaceId: identity.id,
      removedArtifacts: 0,
      alreadyClean: true,
      revocation: null,
    };
  }

  const previousStateDir = process.env.C2C_STATE_DIR;
  let removedArtifacts: number | null = null;
  try {
    process.env.C2C_STATE_DIR = preflight.legacyRoot;
    const stopLegacyRuntime: StopBridgeRuntime =
      deps.stopBridge ??
      ((_workspaceRoot, runtime) =>
        runtime
          ? stopBridgeRuntimeForWorkspaceIdentity(identity, runtime)
          : Promise.resolve(false));
    const revocation = await withWorkspaceLifecycleLock(identity.id, (lock) => {
      deps.afterLegacyLifecycleLockAcquired?.(identity.id, lock.nonce, preflight.legacyRoot);
      validateLegacyWindowsStateForCleanupUnderLock(identity.id, {
        activeLifecycleNonce: lock.nonce,
      });
      return revokeWorkspaceAccessLocked(identity, {
        ...deps,
        stopBridge: stopLegacyRuntime,
        afterQuiescent: (workspaceId) => {
          deps.afterQuiescent?.(workspaceId);
          removedArtifacts = cleanupLegacyWindowsWorkspaceArtifacts(workspaceId, {
            activeLifecycleNonce: lock.nonce,
          }).removed;
        },
      });
    });
    if (removedArtifacts === null) {
      throw new Error("Legacy workspace state finalization did not run");
    }
    const postflight = validateLegacyWindowsStateForCleanup(identity.id);
    if (postflight.artifacts.length > 0) {
      throw new LegacyWindowsStateError(
        postflight.legacyRoot,
        postflight.artifacts,
        postflight.inspectionFailures
      );
    }
    return {
      workspaceId: identity.id,
      removedArtifacts,
      alreadyClean: false,
      revocation,
    };
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
  }
}

async function revokeWorkspaceAccessLocked(
  workspace: WorkspaceIdentity,
  deps: RevokeWorkspaceAccessDeps
): Promise<RevokeWorkspaceAccessResult> {
  const transportMode = readTransportMode(workspace.id);
  const requestAdmin = deps.adminFetch ?? adminFetch;
  const stopExact = deps.stopBridge ?? stopBridgeRuntime;
  const generationStatus = deps.processGenerationStatus ?? processGenerationStatus;
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

    if (runtime.processGeneration) {
      const status = generationStatus(runtime.pid, runtime.processGeneration);
      if (status === "match") return "exact-live";
      if (status === "unknown") return "unknown-live";
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

      // Only confirmed death authorizes removal of the runtime generation.
      // Unknown identity after a stop attempt is still potentially live and
      // must remain discoverable for this and future revocation attempts.
      const deadline = Date.now() + stopTimeoutMs;
      let postStopStatus: RuntimeLiveness = await runtimeLiveness(runtime);
      while (Date.now() < deadline && postStopStatus !== "dead") {
        await sleep(50);
        postStopStatus = await runtimeLiveness(runtime);
      }

      if (postStopStatus === "dead") {
        bridgeStopped = true;
        removeRuntime(runtime);
      } else if (postStopStatus === "unknown-live") {
        failures.push(
          new Error(`Workspace bridge process ${runtime.pid} could not be confirmed dead after the revocation attempt`)
        );
        lastUnknown.push(runtime);
      } else {
        failures.push(new Error(`Workspace bridge process ${runtime.pid} did not exit before the revocation deadline`));
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

  deps.afterQuiescent?.(workspace.id);

  return {
    transportMode,
    legacyTokensRevoked,
    tunnelCredentialRevoked,
    bridgeStopped,
  };
}
