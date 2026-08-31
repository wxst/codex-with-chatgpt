import { AuthStore } from "./store.js";
import { findLiveBridge, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, stopBridge } from "../process/daemon.js";
import { readTransportMode, revokeOpenAITunnelToken, type TransportMode } from "../tunnel/transport-mode.js";
import { Workspace } from "../workspace/manager.js";

type FindLiveBridge = (workspaceId: string) => Promise<RuntimeState | null>;
type AdminFetch = <T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs?: number
) => Promise<T>;
type StopBridge = (workspaceRoot: string) => Promise<boolean>;
type RevokeTunnelToken = (workspaceId: string) => boolean;

type RevocableAuthStore = Pick<AuthStore, "revokeAll">;

export interface RevokeWorkspaceAccessDeps {
  findLiveBridge?: FindLiveBridge;
  adminFetch?: AdminFetch;
  stopBridge?: StopBridge;
  revokeTunnelToken?: RevokeTunnelToken;
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

/**
 * Revoke every ChatGPT credential for one workspace.
 *
 * Revocation is fail-safe rather than fail-fast: every independent revocation
 * action is attempted even when an earlier one fails. This matters because a
 * stale live process and an on-disk tunnel credential are separate access
 * paths. Only after OAuth revocation, token deletion, and bridge shutdown have
 * all been attempted do we surface an aggregated error to the caller.
 */
export async function revokeWorkspaceAccess(
  workspaceRoot: string,
  deps: RevokeWorkspaceAccessDeps = {}
): Promise<RevokeWorkspaceAccessResult> {
  const workspace = new Workspace(workspaceRoot);
  const transportMode = readTransportMode(workspace.id);
  const findLive = deps.findLiveBridge ?? findLiveBridge;
  const requestAdmin = deps.adminFetch ?? adminFetch;
  const stop = deps.stopBridge ?? stopBridge;
  const revokeTunnel = deps.revokeTunnelToken ?? revokeOpenAITunnelToken;
  const makeStore = deps.authStoreFactory ?? ((workspaceId: string) => new AuthStore(workspaceId));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;
  const failures: Error[] = [];

  let runtime: RuntimeState | null = null;
  try {
    runtime = await findLive(workspace.id);
  } catch (error) {
    failures.push(new Error(`Failed to inspect bridge state: ${(error as Error).message}`, { cause: error }));
  }

  let legacyTokensRevoked = 0;
  try {
    if (runtime) {
      const result = await requestAdmin<{ revoked?: number }>(runtime, "POST", "/admin/revoke-all");
      legacyTokensRevoked = result.revoked ?? 0;
    } else {
      legacyTokensRevoked = makeStore(workspace.id).revokeAll();
    }
  } catch (error) {
    failures.push(new Error(`Failed to revoke OAuth credentials: ${(error as Error).message}`, { cause: error }));
  }

  let tunnelCredentialRevoked = false;
  try {
    // Do this before process shutdown. Even if shutdown later fails, a stale
    // credential cannot become valid again after a future restart.
    tunnelCredentialRevoked = revokeTunnel(workspace.id);
  } catch (error) {
    failures.push(new Error(`Failed to remove OpenAI tunnel credential: ${(error as Error).message}`, { cause: error }));
  }

  let bridgeStopped = false;
  if (runtime) {
    let stopRequested = false;
    try {
      stopRequested = await stop(workspace.root);
      if (!stopRequested) failures.push(new Error("Failed to request workspace bridge shutdown"));
    } catch (error) {
      failures.push(new Error(`Failed to request workspace bridge shutdown: ${(error as Error).message}`, { cause: error }));
    }

    // Confirm actual process state even if the stop request reported failure;
    // shutdown may still have raced to completion.
    const deadline = Date.now() + stopTimeoutMs;
    while (Date.now() < deadline) {
      try {
        if (!(await findLive(workspace.id))) {
          bridgeStopped = true;
          break;
        }
      } catch (error) {
        failures.push(new Error(`Failed to confirm workspace bridge shutdown: ${(error as Error).message}`, { cause: error }));
        break;
      }
      await sleep(50);
    }
    if (!bridgeStopped) failures.push(new Error("Workspace bridge did not stop before the revocation deadline"));
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
