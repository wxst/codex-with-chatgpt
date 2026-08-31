import { AuthStore } from "./store.js";
import { readRuntimeState, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, stopBridgeRuntime } from "../process/daemon.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";
import { readTransportMode, revokeOpenAITunnelToken, type TransportMode } from "../tunnel/transport-mode.js";
import { Workspace } from "../workspace/manager.js";

type ReadRuntimeState = (workspaceId: string) => RuntimeState | null;
type AdminFetch = <T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs?: number
) => Promise<T>;
type StopBridgeRuntime = (workspaceRoot: string, runtime?: RuntimeState) => Promise<boolean>;
type RevokeTunnelToken = (workspaceId: string) => boolean;
type IsProcessAlive = (pid: number) => boolean;
type RevocableAuthStore = Pick<AuthStore, "revokeAll">;

export interface RevokeWorkspaceAccessDeps {
  readRuntimeState?: ReadRuntimeState;
  adminFetch?: AdminFetch;
  stopBridge?: StopBridgeRuntime;
  revokeTunnelToken?: RevokeTunnelToken;
  isProcessAlive?: IsProcessAlive;
  /** Retained for compatibility with older callers; runtime files are no longer deleted during revocation. */
  clearRuntimeState?: (workspaceId: string) => void;
  authStoreFactory?: (workspaceId: string) => RevocableAuthStore;
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

function defaultIsProcessAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but the current user cannot signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function runtimeIdentity(runtime: RuntimeState): string {
  return [runtime.workspaceId, runtime.pid, runtime.port, runtime.startedAt, runtime.adminToken].join("\u0000");
}

/**
 * Revoke every ChatGPT credential for one workspace.
 *
 * The lifecycle lock is shared with `ensureBridge`, making startup and
 * revocation mutually exclusive across independent CLI processes. This closes
 * the last-writer-wins runtime race where two concurrent starters could create
 * an untracked bridge while `unpair` was trying to prove quiescence.
 */
export async function revokeWorkspaceAccess(
  workspaceRoot: string,
  deps: RevokeWorkspaceAccessDeps = {}
): Promise<RevokeWorkspaceAccessResult> {
  const workspace = new Workspace(workspaceRoot);
  return withWorkspaceLifecycleLock(workspace.id, () => revokeWorkspaceAccessLocked(workspace, deps));
}

/**
 * Revocation is fail-safe rather than fail-fast: independent credential paths
 * are attempted even when an earlier operation fails. Runtime files are never
 * deleted by workspace id because an older process may be exiting while a
 * newer exact runtime generation is being inspected.
 */
async function revokeWorkspaceAccessLocked(
  workspace: Workspace,
  deps: RevokeWorkspaceAccessDeps
): Promise<RevokeWorkspaceAccessResult> {
  const transportMode = readTransportMode(workspace.id);
  const readRuntime = deps.readRuntimeState ?? readRuntimeState;
  const requestAdmin = deps.adminFetch ?? adminFetch;
  const stopExact = deps.stopBridge ?? stopBridgeRuntime;
  const revokeTunnel = deps.revokeTunnelToken ?? revokeOpenAITunnelToken;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const makeStore = deps.authStoreFactory ?? ((workspaceId: string) => new AuthStore(workspaceId));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;
  const maxRuntimeGenerations = deps.maxRuntimeGenerations ?? 4;
  const failures: Error[] = [];
  const processed = new Set<string>();

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

  const readRuntimeSafely = (): RuntimeState | null => {
    try {
      return readRuntime(workspace.id);
    } catch (error) {
      failures.push(new Error(`Failed to read bridge runtime state: ${(error as Error).message}`, { cause: error }));
      return null;
    }
  };

  // Revoke disk credentials before touching a live process, then repeat after
  // each process exits to close refresh/save races.
  scrubPersistedOAuth("Failed to revoke persisted OAuth credentials");
  removeTunnelCredential("Failed to remove OpenAI tunnel credential");

  let candidate = readRuntimeSafely();
  let quiescent = false;

  for (let generation = 0; generation < maxRuntimeGenerations; generation++) {
    if (!candidate) {
      await sleep(50);
      candidate = readRuntimeSafely();
      if (!candidate) {
        quiescent = true;
        break;
      }
    }

    const current = candidate;
    const key = runtimeIdentity(current);
    const aliveAtStart = isAlive(current.pid);

    if (processed.has(key)) {
      if (aliveAtStart) {
        failures.push(new Error(`Workspace bridge runtime ${current.pid} remained live after a revocation attempt`));
      } else {
        await sleep(50);
        const confirm = readRuntimeSafely();
        if (!confirm || (runtimeIdentity(confirm) === key && !isAlive(confirm.pid))) {
          quiescent = true;
          break;
        }
        candidate = confirm;
        continue;
      }
      break;
    }
    processed.add(key);

    if (aliveAtStart) {
      try {
        const result = await requestAdmin<{ revoked?: number }>(current, "POST", "/admin/revoke-all");
        legacyTokensRevoked += result.revoked ?? 0;
      } catch (error) {
        failures.push(
          new Error(`Failed to revoke OAuth credentials through bridge ${current.pid}: ${(error as Error).message}`, {
            cause: error,
          })
        );
        scrubPersistedOAuth("Failed persisted OAuth fallback after live admin revocation failure");
      }

      try {
        const shutdownRequested = await stopExact(workspace.root, current);
        if (!shutdownRequested) {
          failures.push(new Error(`Failed to authenticate and request shutdown for workspace bridge ${current.pid}`));
        }
      } catch (error) {
        failures.push(
          new Error(`Failed to request workspace bridge ${current.pid} shutdown: ${(error as Error).message}`, {
            cause: error,
          })
        );
      }

      const deadline = Date.now() + stopTimeoutMs;
      while (Date.now() < deadline) {
        if (!isAlive(current.pid)) {
          bridgeStopped = true;
          break;
        }
        await sleep(50);
      }
      if (isAlive(current.pid)) {
        failures.push(new Error(`Workspace bridge process ${current.pid} did not exit before the revocation deadline`));
      }
    }

    // A live bridge may have re-saved OAuth state just before process exit.
    scrubPersistedOAuth("Failed final persisted OAuth credential scrub");
    removeTunnelCredential("Failed final OpenAI tunnel credential scrub");

    await sleep(50);
    const next = readRuntimeSafely();
    if (!next) {
      await sleep(50);
      const confirm = readRuntimeSafely();
      if (!confirm) {
        quiescent = true;
        break;
      }
      candidate = confirm;
      continue;
    }

    const nextKey = runtimeIdentity(next);
    if (nextKey !== key) {
      candidate = next;
      continue;
    }

    if (!isAlive(next.pid)) {
      await sleep(50);
      const confirm = readRuntimeSafely();
      if (!confirm || (runtimeIdentity(confirm) === nextKey && !isAlive(confirm.pid))) {
        quiescent = true;
        break;
      }
      candidate = confirm;
      continue;
    }

    candidate = next;
  }

  if (!quiescent) {
    failures.push(
      new Error(`Workspace did not reach a quiescent state after ${maxRuntimeGenerations} runtime generation(s)`)
    );
  }

  scrubPersistedOAuth("Failed final persisted OAuth credential scrub after quiescence check");
  removeTunnelCredential("Failed final OpenAI tunnel credential scrub after quiescence check");

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
