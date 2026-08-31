import { afterAll, beforeAll, describe, expect, it } from "vitest";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

let root: string;
let bridge: Bridge;

const tunnelToken = "test-openai-tunnel-token-0123456789";

beforeAll(async () => {
  isolateStateDir();
  root = makeTmpDir("openai-tunnel-ws");
  makeGitRepo(root);
  bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    transportMode: "openai",
    openAITunnelToken: tunnelToken,
    authStoreFile: path.join(makeTmpDir("openai-tunnel-auth"), "store.json"),
  });
});

afterAll(async () => {
  await bridge.close();
  cleanup(root);
});

describe("OpenAI Secure MCP Tunnel authentication", () => {
  it("rejects MCP requests without the per-workspace tunnel token", async () => {
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects requests carrying proxy marker headers even with the right token", async () => {
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-c2c-tunnel-token": tunnelToken,
        "x-forwarded-for": "203.0.113.10",
      },
      body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
    });

    expect(response.status).toBe(401);
  });

  it("accepts the official-tunnel style local header and exposes only read-only tools", async () => {
    const client = new Client({ name: "openai-tunnel-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${bridge.localBaseUrl()}/mcp`), {
      requestInit: { headers: { "X-C2C-Tunnel-Token": tunnelToken } },
    });

    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "execution_summary",
      "git_diff",
      "git_status",
      "list_directory",
      "read_file",
      "search_workspace",
      "test_status",
      "workspace_info",
    ]);
    for (const forbidden of ["write_file", "delete_file", "execute_shell", "git_commit", "install_package"]) {
      expect(names).not.toContain(forbidden);
    }

    await client.close();
  });

  it("refuses to start a Cloudflare public tunnel while OpenAI mode is selected", async () => {
    const response = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    const body = (await response.json()) as { error?: string };

    expect(response.status).toBe(409);
    expect(body.error).toBe("transport_mode_mismatch");
    expect(bridge.getPublicBaseUrl()).toBeNull();
  });
});
