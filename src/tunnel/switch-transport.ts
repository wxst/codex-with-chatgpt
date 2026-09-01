import { stopBridge as stopWorkspaceBridge } from "../process/daemon.js";
import { Workspace } from "../workspace/manager.js";
import {
  readTransportMode,
  writeTransportMode,
  type TransportMode,
} from "./transport-mode.js";

type StopBridge = (workspaceRoot: string) => Promise<boolean>;

export interface SwitchWorkspaceTransportDeps {
  stopBridge?: StopBridge;
}

export interface SwitchWorkspaceTransportResult {
  previous: TransportMode;
  mode: TransportMode;
  changed: boolean;
}

/**
 * Change the persisted transport while fencing every pending/live Bridge.
 *
 * The new mode is published before shutdown so a delayed child that reaches
 * startup during the transition cannot start with the old policy. If the
 * lifecycle-fenced shutdown fails, the previous persisted mode is restored
 * before the error is surfaced, preventing a retry from mistaking the failed
 * transition for an already-completed one.
 */
export async function switchWorkspaceTransport(
  workspaceRoot: string,
  next: TransportMode,
  deps: SwitchWorkspaceTransportDeps = {}
): Promise<SwitchWorkspaceTransportResult> {
  const workspace = new Workspace(workspaceRoot);
  const previous = readTransportMode(workspace.id);

  if (previous === next) {
    return { previous, mode: next, changed: false };
  }

  const stopBridge = deps.stopBridge ?? stopWorkspaceBridge;
  writeTransportMode(workspace.id, next);

  try {
    await stopBridge(workspace.root);
  } catch (stopError) {
    try {
      writeTransportMode(workspace.id, previous);
    } catch (rollbackError) {
      throw new AggregateError(
        [stopError, rollbackError],
        `Failed to switch workspace transport to ${next} and failed to restore ${previous}`
      );
    }
    throw stopError;
  }

  return { previous, mode: next, changed: true };
}
