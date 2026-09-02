import { afterAll, beforeAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { Logger } from "../src/logger/index.js";
import { openAITunnelTokenFile } from "../src/tunnel/transport-mode.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

let root: string;
let bridge: Bridge;

const tunnelToken = "test-openai-tunnel-token-0123456789";

async function initializeWithToken(target: Bridge, token: string): Promise<Response> {
  return await fetch(`${target.localBaseUrl()}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "x-c2c-tunnel-token": token,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "credential-reload-test", version: "1.0.0" },
      },
    }),
  });
}

async function initializeWithoutToken(target: Bridge): Promise<Response> {
  return await fetch(`${target.localBaseUrl()}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "credential-reload-test", version: "1.0.0" },
      },
    }),
  });
}

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

  it("records only boolean OpenAI tunnel rejection reasons", async () => {
    const auditRoot = makeTmpDir("openai-tunnel-audit-ws");
    const auditState = makeTmpDir("openai-tunnel-audit-state");
    const logFile = path.join(auditState, "audit.log");
    const expected = `c2c_tunnel_${"A".repeat(43)}`;
    const supplied = `c2c_tunnel_${"B".repeat(43)}`;
    makeGitRepo(auditRoot);
    const auditBridge = await startBridge({
      workspaceRoot: auditRoot,
      port: 0,
      persistRuntime: false,
      transportMode: "openai",
      openAITunnelToken: expected,
      logger: new Logger({ name: "openai-tunnel-audit", file: logFile }),
      authStoreFile: path.join(auditState, "store.json"),
    });

    try {
      const response = await fetch(`${auditBridge.localBaseUrl()}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-c2c-tunnel-token": supplied },
        body: JSON.stringify({ jsonrpc: "2.0", method: "ping", id: 1 }),
      });
      expect(response.status).toBe(401);
    } finally {
      await auditBridge.close();
    }

    const output = fs.readFileSync(logFile, "utf8");
    expect(output).toContain('"loopback":true');
    expect(output).toContain('"proxyMarker":false');
    expect(output).toContain('"tokenMatch":false');
    expect(output).not.toContain(expected);
    expect(output).not.toContain(supplied);
    cleanup(auditRoot);
    cleanup(auditState);
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

  it("reloads the canonical tunnel credential after an atomic rotation", async () => {
    const dynamicRoot = makeTmpDir("openai-tunnel-rotate-ws");
    const dynamicAuth = makeTmpDir("openai-tunnel-rotate-auth");
    makeGitRepo(dynamicRoot);
    const dynamicBridge = await startBridge({
      workspaceRoot: dynamicRoot,
      port: 0,
      persistRuntime: false,
      transportMode: "openai",
      authStoreFile: path.join(dynamicAuth, "store.json"),
    });

    try {
      const tokenFile = openAITunnelTokenFile(dynamicBridge.workspace.id);
      const original = fs.readFileSync(tokenFile, "utf8").trim();
      const replacement = `c2c_tunnel_${"R".repeat(43)}`;
      expect(replacement).not.toBe(original);

      const before = await initializeWithToken(dynamicBridge, original);
      expect(before.status).toBe(200);
      await before.body?.cancel();

      const replacementFile = `${tokenFile}.replacement`;
      fs.writeFileSync(replacementFile, `${replacement}\n`, { mode: 0o600 });
      fs.renameSync(replacementFile, tokenFile);

      const stale = await initializeWithToken(dynamicBridge, original);
      expect(stale.status).toBe(401);
      await stale.body?.cancel();

      const current = await initializeWithToken(dynamicBridge, replacement);
      expect(current.status).toBe(200);
      await current.body?.cancel();
    } finally {
      await dynamicBridge.close();
      cleanup(dynamicRoot);
      cleanup(dynamicAuth);
    }
  });

  it("fails closed when the canonical tunnel credential disappears", async () => {
    const dynamicRoot = makeTmpDir("openai-tunnel-missing-ws");
    const dynamicAuth = makeTmpDir("openai-tunnel-missing-auth");
    makeGitRepo(dynamicRoot);
    const dynamicBridge = await startBridge({
      workspaceRoot: dynamicRoot,
      port: 0,
      persistRuntime: false,
      transportMode: "openai",
      authStoreFile: path.join(dynamicAuth, "store.json"),
    });

    try {
      const tokenFile = openAITunnelTokenFile(dynamicBridge.workspace.id);
      const original = fs.readFileSync(tokenFile, "utf8").trim();
      fs.unlinkSync(tokenFile);

      const response = await initializeWithToken(dynamicBridge, original);
      expect(response.status).toBe(401);
      await response.body?.cancel();

      const headerless = await initializeWithoutToken(dynamicBridge);
      expect(headerless.status).toBe(401);
      await headerless.body?.cancel();
      expect(fs.existsSync(tokenFile)).toBe(false);
    } finally {
      await dynamicBridge.close();
      cleanup(dynamicRoot);
      cleanup(dynamicAuth);
    }
  });

  it("fails closed for a malformed canonical tunnel credential, including requests without a header", async () => {
    const dynamicRoot = makeTmpDir("openai-tunnel-malformed-ws");
    const dynamicAuth = makeTmpDir("openai-tunnel-malformed-auth");
    makeGitRepo(dynamicRoot);
    const dynamicBridge = await startBridge({
      workspaceRoot: dynamicRoot,
      port: 0,
      persistRuntime: false,
      transportMode: "openai",
      authStoreFile: path.join(dynamicAuth, "store.json"),
    });

    try {
      const tokenFile = openAITunnelTokenFile(dynamicBridge.workspace.id);
      fs.writeFileSync(tokenFile, "malformed\n", { mode: 0o600 });

      const headerless = await initializeWithoutToken(dynamicBridge);
      expect(headerless.status).toBe(401);
      await headerless.body?.cancel();
      expect(fs.readFileSync(tokenFile, "utf8")).toBe("malformed\n");
    } finally {
      await dynamicBridge.close();
      cleanup(dynamicRoot);
      cleanup(dynamicAuth);
    }
  });

  it("fails closed when the canonical tunnel credential is a symbolic link", async () => {
    const dynamicRoot = makeTmpDir("openai-tunnel-symlink-ws");
    const dynamicAuth = makeTmpDir("openai-tunnel-symlink-auth");
    makeGitRepo(dynamicRoot);
    const dynamicBridge = await startBridge({
      workspaceRoot: dynamicRoot,
      port: 0,
      persistRuntime: false,
      transportMode: "openai",
      authStoreFile: path.join(dynamicAuth, "store.json"),
    });

    try {
      const tokenFile = openAITunnelTokenFile(dynamicBridge.workspace.id);
      const linkedToken = `c2c_tunnel_${"S".repeat(43)}`;
      const linkedFile = path.join(dynamicAuth, "linked.token");
      fs.writeFileSync(linkedFile, `${linkedToken}\n`, { mode: 0o644 });
      fs.unlinkSync(tokenFile);
      try {
        fs.symlinkSync(linkedFile, tokenFile, "file");
      } catch (error) {
        if (["EPERM", "EACCES", "UNKNOWN"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
        throw error;
      }

      const linked = await initializeWithToken(dynamicBridge, linkedToken);
      expect(linked.status).toBe(401);
      await linked.body?.cancel();

      const headerless = await initializeWithoutToken(dynamicBridge);
      expect(headerless.status).toBe(401);
      await headerless.body?.cancel();
      expect(fs.readFileSync(linkedFile, "utf8")).toBe(`${linkedToken}\n`);
      if (process.platform !== "win32") {
        expect(fs.statSync(linkedFile).mode & 0o777).toBe(0o644);
      }
    } finally {
      await dynamicBridge.close();
      cleanup(dynamicRoot);
      cleanup(dynamicAuth);
    }
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
