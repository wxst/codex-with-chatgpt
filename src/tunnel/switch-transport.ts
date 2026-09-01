import { stopBridgeWithinLifecycleLock } from "../process/daemon.js";
import {
  acquireWorkspaceLifecycleLock,
  type WorkspaceLifecycleLock,
} from "../process/workspace-lock.js";
import { Workspace } from "../workspace/manager.js";
import {
  ensureOpenAITunnelToken,
  readTransportMode,
  writeTransportMode,
  type TransportMode,
} from "./transport-mode.js";

type StopBridge = (workspaceRoot: string) => Promise<boolean>;
type AcquireLock = (workspaceId: string) => Promise<WorkspaceLifecycleLock>;
type EnsureToken = (workspaceId: string) => string;

export interface SwitchWorkspaceTransportDeps {
  /** Test seam; production uses the stop path that assumes this transaction owns the lifecycle lock. */
  stopBridge?: StopBridge;
  acquireLock?: AcquireLock;
  ensureToken?: EnsureToken;
  /** Fence pending/live generations even when the selected transport is unchanged. */
  forceFence?: boolean;
}

export interface SwitchWorkspaceTransportResult {
  previous: TransportMode;
  mode: TransportMode;
  changed: boolean;
}

/**
 * Change transport as one workspace lifecycle transaction.
 *
 * The lifecycle lock serializes the committed-mode read, provisional write,
 * pending/runtime drain, rollback, and OpenAI-token provisioning. A concurrent
 * command can therefore never observe a provisional mode as committed or
 * recreate a tunnel token while unpair owns the same workspace fence.
 */
export async function switchWorkspaceTransport(
  workspaceRoot: string,
  next: TransportMode,
  deps: SwitchWorkspaceTransportDeps = {}
): Promise<SwitchWorkspaceTransportResult> {
  const workspace = new Workspace(workspaceRoot);
  const acquireLock = deps.acquireLock ?? acquireWorkspaceLifecycleLock;
  const stopBridge = deps.stopBridge ?? stopBridgeWithinLifecycleLock;
  const ensureToken = deps.ensureToken ?? ensureOpenAITunnelToken;
  const lock = await acquireLock(workspace.id);

  try {
    const previous = readTransportMode(workspace.id);
    const changed = previous !== next;
    if (changed) writeTransportMode(workspace.id, next);

    try {
      if (changed || deps.forceFence) await stopBridge(workspace.root);
      if (next === "openai") ensureToken(workspace.id);
    } catch (error) {
      if (changed) {
        try {
          writeTransportMode(workspace.id, previous);
        } catch (rollbackError) {
          throw new AggregateError(
            [error, rollbackError],
            `Failed to switch workspace transport to ${next} and failed to restore ${previous}`
          );
        }
      }
      throw error;
    }

    return { previous, mode: next, changed };
  } finally {
    lock.release();
  }
}

/**
 * Create/read the OpenAI local tunnel token while holding the same lifecycle
 * fence used by startup, transport mutation, stop, and unpair.
 */
export async function ensureWorkspaceOpenAITunnelToken(
  workspaceRoot: string,
  deps: Pick<SwitchWorkspaceTransportDeps, "acquireLock" | "ensureToken"> = {}
): Promise<string> {
  const workspace = new Workspace(workspaceRoot);
  const acquireLock = deps.acquireLock ?? acquireWorkspaceLifecycleLock;
  const ensureToken = deps.ensureToken ?? ensureOpenAITunnelToken;
  const lock = await acquireLock(workspace.id);

  try {
    if (readTransportMode(workspace.id) !== "openai") {
      throw new Error("OpenAI tunnel token requested while the workspace transport is not openai");
    }
    return ensureToken(workspace.id);
  } finally {
    lock.release();
  }
}
