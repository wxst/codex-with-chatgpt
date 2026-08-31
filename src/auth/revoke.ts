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

type RevocableAuthStore = Pick<AuthStore, "revokeAll">;

export interface RevokeWorkspaceAccessDeps {
  findLiveBridge?: FindLiveBridge;
  adminFetch?: AdminFetch;
  stopBridge?: StopBridge;
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
 * OAuth credentials are revoked in every mode. Any persisted OpenAI tunnel
 * credential is removed before process shutdown so even a failed stop cannot
 * preserve it for a later restart. Finally, any live bridge is stopped and
 * confirmed down. Stopping regardless of the persisted transport state avoids
 * relying on state that may briefly disagree with a process started before a
 * transport switch.
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
  const makeStore = deps.authStoreFactory ?? ((workspaceId: string) => new AuthStore(workspaceId));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;

  const runtime = await findLive(workspace.id);
  let legacyTokensRevoked = 0;
  if (runtime) {
    const result = await requestAdmin<{ revoked?: number }>(runtime, "POST", "/admin/revoke-all");
    legacyTokensRevoked = result.revoked ?? 0;
  } else {
    legacyTokensRevoked = makeStore(workspace.id).revokeAll();
  }

  // Remove dormant credentials before attempting process shutdown. If stopping
  // the bridge fails, the command reports failure, but the old credential still
  // cannot become valid again after a later restart.
  const tunnelCredentialRevoked = revokeOpenAITunnelToken(workspace.id);

  let bridgeStopped = false;
  if (runtime) {
    if (!(await stop(workspace.root))) {
      throw new Error("Failed to stop the workspace bridge during access revocation");
    }

    const deadline = Date.now() + stopTimeoutMs;
    while (Date.now() < deadline) {
      if (!(await findLive(workspace.id))) {
        bridgeStopped = true;
        break;
      }
      await sleep(50);
    }
    if (!bridgeStopped) {
      throw new Error("Workspace bridge did not stop before the revocation deadline");
    }
  }

  return {
    transportMode,
    legacyTokensRevoked,
    tunnelCredentialRevoked,
    bridgeStopped,
  };
}
