import { AuthStore } from "./store.js";
import { probeBridge, readRuntimeState, type HealthPayload, type RuntimeState } from "../bridge/runtime.js";
import { adminFetch, stopBridgeRuntime } from "../process/daemon.js";
import { processGenerationMatches } from "../process/process-identity.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";
import { readTransportMode, revokeOpenAITunnelToken, type TransportMode } from "../tunnel/transport-mode.js";
import { Workspace } from "../workspace/manager.js";
import { SERVICE_NAME } from "../version.js";

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

export interface RevokeWorkspaceAccessDeps {
  readRuntimeState?: ReadRuntimeState;
  adminFetch?: AdminFetch;
  stopBridge?: StopBridgeRuntime;
  revokeTunnelToken?: RevokeTunnelToken;
  /** Test/compatibility override. Production uses process-generation identity. */
  isProcessAlive?: IsProcessAlive;
  /** Test override for the conservative same-workspace health fallback. */
  probeBridge?: ProbeBridge;
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

function runtimeIdentity(runtime: RuntimeState): string {
  return [
    runtime.workspaceId,
    runtime.pid,
    runtime.processGeneration ?? "",
    runtime.port,
    runtime.startedAt,
    runtime.adminToken,
  ].join("\u0000");
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
  const readRuntime = deps.readRuntimeState ?? readRuntimeState;
  const requestAdmin = deps.adminFetch ?? adminFetch;
  const stopExact = deps.stopBridge ?? stopBridgeRuntime;
  const healthProbe = deps.probeBridge ?? probeBridge;
  const revokeTunnel = deps.revokeTunnelToken ?? revokeOpenAITunnelToken;
  const makeStore = deps.authStoreFactory ?? ((workspaceId: string) => new AuthStore(workspaceId));
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const stopTimeoutMs = deps.stopTimeoutMs ?? 5_000;
  const maxRuntimeGenerations = deps.maxRuntimeGenerations ?? 4;
  const failures: Error[] = [];
  const processed = new Set<string>();

  const runtimeIsLive = async (runtime: RuntimeState): Promise<boolean> => {
    if (deps.isProcessAlive) return deps.isProcessAlive(runtime.pid);

    if (runtime.processGeneration && processGenerationMatches(runtime.pid, runtime.processGeneration)) {
      return true;
    }

    // An authenticated exact application identity proves the recorded runtime.
    // If it does not authenticate, do not immediately declare quiescence: a
    // stale runtime file can have been restored over a newer bridge whose admin
    // token/generation differs. Public loopback health intentionally exposes the
    // service+workspace identity needed for this conservative split-brain check.
    try {
      const info = await requestAdmin<RuntimeIdentityPayload>(runtime, "GET", "/admin/info", 1500);
      if (authenticatedRuntimeMatches(runtime, info)) return true;
    } catch {
      // Continue to conservative health detection below.
    }

    try {
      const health = await healthProbe(runtime.port, 1000);
      return Boolean(
        health &&
        health.service === SERVICE_NAME &&
        health.workspaceId === runtime.workspaceId &&
        health.status === "ok"
      );
    } catch {
      return false;
    }
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

  const readRuntimeSafely = (): RuntimeState | null => {
    try {
      return readRuntime(workspace.id);
    } catch (error) {
      failures.push(new Error(`Failed to read bridge runtime state: ${(error as Error).message}`, { cause: error }));
      return null;
    }
  };

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
    const aliveAtStart = await runtimeIsLive(current);

    if (processed.has(key)) {
      if (aliveAtStart) {
        failures.push(new Error(`Workspace bridge runtime ${current.pid} remained live after a revocation attempt`));
      } else {
        await sleep(50);
        const confirm = readRuntimeSafely();
        if (!confirm || (runtimeIdentity(confirm) === key && !(await runtimeIsLive(confirm)))) {
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
        if (!(await runtimeIsLive(current))) {
          bridgeStopped = true;
          break;
        }
        await sleep(50);
      }
      if (await runtimeIsLive(current)) {
        failures.push(new Error(`Workspace bridge process ${current.pid} did not exit before the revocation deadline`));
      }
    }

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

    if (!(await runtimeIsLive(next))) {
      await sleep(50);
      const confirm = readRuntimeSafely();
      if (!confirm || (runtimeIdentity(confirm) === nextKey && !(await runtimeIsLive(confirm)))) {
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
