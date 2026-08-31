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
 * Cloudflare mode revokes OAuth tokens in-place. OpenAI mode additionally
 * stops a live bridge (so its in-memory tunnel token dies), waits until that
 * process is no longer reachable, then deletes the on-disk tunnel token.
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

  let bridgeStopped = false;
  let tunnelCredentialRevoked = false;

  if (transportMode === "openai") {
    if (runtime) {
      if (!(await stop(workspace.root))) {
        throw new Error("Failed to stop the OpenAI tunnel bridge during access revocation");
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
        throw new Error("OpenAI tunnel bridge did not stop before the revocation deadline");
      }
    }

    tunnelCredentialRevoked = revokeOpenAITunnelToken(workspace.id);
  }

  return {
    transportMode,
    legacyTokensRevoked,
    tunnelCredentialRevoked,
    bridgeStopped,
  };
}
