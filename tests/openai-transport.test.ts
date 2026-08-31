import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { ensureOpenAITunnelToken } from "../src/tunnel/transport-mode.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const bridges: Bridge[] = [];
const roots: string[] = [];

async function makeBridge(mode: "openai" | "cloudflare"): Promise<Bridge> {
  isolateStateDir();
  const root = makeTmpDir(`transport-${mode}`);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), '{"name":"transport-test"}');
  const bridge = await startBridge({
    workspaceRoot: root,
    port: 0,
    persistRuntime: false,
    authStoreFile: path.join(makeTmpDir("auth"), "store.json"),
    transportMode: mode,
  });
  bridges.push(bridge);
  return bridge;
}

afterEach(async () => {
  while (bridges.length > 0) await bridges.pop()!.close();
  for (const root of roots.splice(0)) cleanup(root);
});

describe("OpenAI Secure MCP Tunnel transport", () => {
  it("rejects direct loopback requests without the per-workspace tunnel token", async () => {
    const bridge = await makeBridge("openai");
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`);
    expect(response.status).toBe(401);
  });

  it("accepts a direct loopback request carrying the per-workspace tunnel token", async () => {
    const bridge = await makeBridge("openai");
    const token = ensureOpenAITunnelToken(bridge.workspace.id);
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      headers: { "x-c2c-tunnel-token": token },
    });
    expect(response.status).toBe(405);
  });

  it("rejects proxy-marked requests even when the tunnel token is correct", async () => {
    const bridge = await makeBridge("openai");
    const token = ensureOpenAITunnelToken(bridge.workspace.id);
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`, {
      headers: {
        "x-c2c-tunnel-token": token,
        "x-forwarded-for": "203.0.113.10",
      },
    });
    expect(response.status).toBe(401);
  });

  it("keeps Cloudflare mode OAuth-protected", async () => {
    const bridge = await makeBridge("cloudflare");
    const response = await fetch(`${bridge.localBaseUrl()}/mcp`);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("refuses to start a public Cloudflare tunnel while OpenAI mode is selected", async () => {
    const bridge = await makeBridge("openai");
    const response = await fetch(`${bridge.localBaseUrl()}/admin/tunnel/start`, {
      method: "POST",
      headers: { authorization: `Bearer ${bridge.adminToken}` },
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: "transport_mode_mismatch" });
  });
});
