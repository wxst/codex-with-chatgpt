import { AuthStore } from "./store.js";
import {
  clearRuntimeState,
  readRuntimeState,
  type RuntimeState,
} from "../bridge/runtime.js";
import { adminFetch, stopBridge } from "../process/daemon.js";
import { readTransportMode, revokeOpenAITunnelToken, type TransportMode } from "../tunnel/transport-mode.js";
import { Workspace } from "../workspace/manager.js";

type ReadRuntimeState = (workspaceId: string) => RuntimeState | null;
type AdminFetch = <T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs?: number
) => Promise<T>;
type StopBridge = (workspaceRoot: string) => Promise<boolean>;
type RevokeTunnelToken = (workspaceId: string) => boolean;
type IsProcessAlive = (pid: number) => boolean;
type ClearRuntimeState = (workspaceId: string) => void;
type RevocableAuthStore = Pick<AuthStore, "revokeAll">;

export interface RevokeWorkspaceAccessDeps {
  readRuntimeState?: ReadRuntimeState;
  adminFetch?: AdminFetch;
  stopBridge?: StopBridge;
  revokeTunnelToken?: RevokeTunnelToken;
  isProcessAlive?: IsProcessAlive;
  clearRuntimeState?: ClearRuntimeState;
  authStoreFactory?: (workspaceId: string) => RevocableAuthStore;
  sleep?: (ms: number) => Promise<void>;
  stopTimeoutMs?: number;
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

/**
 * Revoke every ChatGPT credential for one workspace.
 *
 * Revocation is fail-safe rather than fail-fast: every independent access path
 * is attempted even when an earlier one fails. Runtime PID/state is used for
 * process-level shutdown confirmation; health reachability is deliberately not
 * treated as proof that a bridge has exited.
 */
export async function revokeWorkspaceAccess(
  workspaceRoot: string,
  deps: RevokeWorkspaceAccessDeps = {}
): Promise<RevokeWorkspaceAccessResult> {
  const workspace = new Workspace(workspaceRoot);
  const transportMode = readTransportMode(workspace.id);
  const readRuntime = deps.readRuntimeState ?? readRuntimeState;
  const requestAdmin = deps.adminFetch ?? adminFetch;
  const stop = deps.stopBridge ?? stopBridge;
  const revokeTunnel = deps.revokeTunnelToken ?? revokeOpenAITunnelToken;
  const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
  const clearRuntime = deps.clearRuntimeState ?? clearRuntimeState;
  const makeStore = deps.authStoreFactory ?? ((workspaceId: string) => new AuthStore(workspaceId));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;
  const failures: Error[] = [];

  let runtime: RuntimeState | null = null;
  try {
    runtime = readRuntime(workspace.id);
  } catch (error) {
    failures.push(new Error(`Failed to read bridge runtime state: ${(error as Error).message}`, { cause: error }));
  }

  const runtimeAlive = Boolean(runtime && isAlive(runtime.pid));
  let legacyTokensRevoked = 0;

  if (runtime && runtimeAlive) {
    try {
      const result = await requestAdmin<{ revoked?: number }>(runtime, "POST", "/admin/revoke-all");
      legacyTokensRevoked = result.revoked ?? 0;
    } catch (error) {
      failures.push(new Error(`Failed to revoke OAuth credentials through the live bridge: ${(error as Error).message}`, { cause: error }));
      // The live bridge may be unhealthy or its admin endpoint may be wedged.
      // Revoke the persisted store as a second, independent path so a later
      // Cloudflare-mode restart cannot resurrect access/refresh tokens.
      try {
        legacyTokensRevoked = makeStore(workspace.id).revokeAll();
      } catch (fallbackError) {
        failures.push(
          new Error(`Failed to revoke persisted OAuth credentials: ${(fallbackError as Error).message}`, {
            cause: fallbackError,
          })
        );
      }
    }
  } else {
    try {
      legacyTokensRevoked = makeStore(workspace.id).revokeAll();
    } catch (error) {
      failures.push(new Error(`Failed to revoke persisted OAuth credentials: ${(error as Error).message}`, { cause: error }));
    }
  }

  let tunnelCredentialRevoked = false;
  try {
    tunnelCredentialRevoked = revokeTunnel(workspace.id);
  } catch (error) {
    failures.push(new Error(`Failed to remove OpenAI tunnel credential: ${(error as Error).message}`, { cause: error }));
  }

  let bridgeStopped = false;
  if (runtime && runtimeAlive) {
    try {
      const requested = await stop(workspace.root);
      if (!requested) failures.push(new Error("Failed to request workspace bridge shutdown"));
    } catch (error) {
      failures.push(new Error(`Failed to request workspace bridge shutdown: ${(error as Error).message}`, { cause: error }));
    }

    const deadline = Date.now() + stopTimeoutMs;
    while (Date.now() < deadline) {
      if (!isAlive(runtime.pid)) {
        bridgeStopped = true;
        break;
      }
      await sleep(50);
    }
    if (!bridgeStopped) {
      failures.push(new Error(`Workspace bridge process ${runtime.pid} did not exit before the revocation deadline`));
    }
  } else if (runtime && !runtimeAlive) {
    bridgeStopped = true;
  }

  // Once the recorded PID is confirmed dead, remove stale state immediately so
  // a future PID reuse cannot make stopBridge target an unrelated process.
  if (runtime && !isAlive(runtime.pid)) {
    try {
      clearRuntime(workspace.id);
    } catch (error) {
      failures.push(new Error(`Failed to clear stale bridge runtime state: ${(error as Error).message}`, { cause: error }));
    }
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
