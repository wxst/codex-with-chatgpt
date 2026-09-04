import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startWorkspaceRouter, type WorkspaceRouterBridge } from "../src/router/server.js";
import { createWorkspaceRouter, issueRouteCapability } from "../src/router/state.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir, write } from "./helpers.js";

let stateRoot: string;
let authRoot: string;
let alphaRoot: string;
let betaRoot: string;
let bridge: WorkspaceRouterBridge;
let client: Client;
let alphaToken: string;
let betaToken: string;

function textOf(result: { content?: unknown }): string {
  const content = result.content as { type: string; text: string }[];
  return content?.[0]?.text ?? "";
}

beforeAll(async () => {
  stateRoot = isolateStateDir();
  authRoot = makeTmpDir("router-mcp-auth");
  alphaRoot = makeTmpDir("router-mcp-alpha");
  betaRoot = makeTmpDir("router-mcp-beta");
  makeGitRepo(alphaRoot);
  makeGitRepo(betaRoot);
  write(alphaRoot, "identity.txt", "alpha\n");
  write(betaRoot, "identity.txt", "beta\n");

  const router = await createWorkspaceRouter(alphaRoot);
  const alpha = await router.register(alphaRoot);
  const beta = await router.register(betaRoot);
  alphaToken = (await issueRouteCapability({
    workspaceId: alpha.workspaceId,
    taskId: "alpha-task",
    conversationId: "alpha-chat",
  })).token;
  betaToken = (await issueRouteCapability({
    workspaceId: beta.workspaceId,
    taskId: "beta-task",
    conversationId: "beta-chat",
  })).token;

  bridge = await startWorkspaceRouter({
    anchorRoot: alphaRoot,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(authRoot, "store.json"),
  });
  const access = bridge.authStore.issueTokens({
    clientId: "router-client",
    scopes: ["workspace.read", "workspace.search", "git.read", "execution.read"],
  });
  client = new Client({ name: "router-mcp-client", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${access.accessToken}` } },
  }));
});

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await bridge?.close().catch(() => undefined);
  for (const dir of [stateRoot, authRoot, alphaRoot, betaRoot]) cleanup(dir);
});

describe("router MCP capability boundary", () => {
  it("requires a route token on every read-only tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(8);
    for (const tool of tools) {
      expect(tool.inputSchema.required).toContain("route_token");
    }
  });

  it("routes concurrent calls to the capability workspace", async () => {
    const missing = await client.callTool({
      name: "workspace_info",
      arguments: { route_token: "c2c_route_invalid_capability_token_for_test" },
    });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toContain("ROUTE_ACCESS_DENIED");

    const [alpha, beta] = await Promise.all([
      client.callTool({ name: "read_file", arguments: { route_token: alphaToken, path: "identity.txt" } }),
      client.callTool({ name: "read_file", arguments: { route_token: betaToken, path: "identity.txt" } }),
    ]);
    expect(textOf(alpha)).toContain("alpha");
    expect(textOf(alpha)).not.toContain("beta");
    expect(textOf(beta)).toContain("beta");
    expect(textOf(beta)).not.toContain("alpha");
  });
});
