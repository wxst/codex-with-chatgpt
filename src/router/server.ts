import { startBridge, type Bridge, type BridgeOptions } from "../bridge/server.js";
import path from "node:path";
import { createMcpServer } from "../mcp/server.js";
import { readWorkspaceRouter, resolveRouteCapability } from "./state.js";

/** A Router uses the established anchor Bridge transport for many workspaces. */
export type WorkspaceRouterBridge = Bridge;

export interface WorkspaceRouterBridgeOptions extends Omit<BridgeOptions, "workspaceRoot" | "mcpServerFactory"> {
  anchorRoot: string;
}

/**
 * Start the Router behind the existing Bridge transport. The anchor keeps its
 * existing OpenAI Tunnel identity; individual tool calls are resolved by the
 * task capability supplied in their input, never by title or recency.
 */
export async function startWorkspaceRouter(
  opts: WorkspaceRouterBridgeOptions
): Promise<WorkspaceRouterBridge> {
  const state = readWorkspaceRouter();
  if (!state) throw new Error("global workspace router is not initialized");
  if (path.resolve(state.anchor.root) !== path.resolve(opts.anchorRoot)) {
    throw new Error("global workspace router is anchored to another workspace");
  }

  return startBridge({
    ...opts,
    workspaceRoot: opts.anchorRoot,
    mcpServerFactory: ({ logger }) =>
      createMcpServer({
        logger,
        resolveRoute: async (token) => {
          const resolved = await resolveRouteCapability(token);
          return { workspace: resolved.workspace, taskId: resolved.capability.taskId };
        },
      }),
  });
}
