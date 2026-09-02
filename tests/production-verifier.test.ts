import { afterEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { localRegularFile } from "../scripts/verify-production-paths.mjs";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const verifierPath = path.resolve(testDirectory, "../scripts/verify-production-mcp.mjs");
const roots = [];
const servers = [];
const fixtureToken = `c2c_tunnel_${"A".repeat(43)}`;
const expectedTools = [
  "execution_summary",
  "git_diff",
  "git_status",
  "list_directory",
  "read_file",
  "search_workspace",
  "test_status",
  "workspace_info",
];

function makeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-production-verifier-"));
  roots.push(root);
  const tokenFile = path.join(root, "tunnel-token");
  fs.writeFileSync(tokenFile, `${fixtureToken}\n`, "utf8");
  return { root, tokenFile };
}

async function listen(handler) {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return server.address().port;
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for test fixture state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function runVerifier({ root, state, stateText, env = {} }) {
  const stateFile = path.join(root, "state.json");
  fs.writeFileSync(stateFile, stateText ?? JSON.stringify(state), "utf8");

  return await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [verifierPath], {
      cwd: root,
      env: {
        ...process.env,
        C2C_VERIFY_STATE_FILE: stateFile,
        C2C_VERIFY_WORKSPACE_NAME: "codex-with-chatgpt",
        C2C_VERIFY_BRANCH: "main",
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, 15_000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      const line = stdout.trim().split(/\r?\n/).filter(Boolean).at(-1);
      let output;
      try {
        output = line ? JSON.parse(line) : undefined;
      } catch {
        output = undefined;
      }
      resolve({ code, output, stdout, stderr, timedOut });
    });
  });
}

function sendJson(res, value, headers = {}) {
  const payload = JSON.stringify(value);
  res.writeHead(200, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function readOnlyTool(name) {
  return {
    name,
    description: `${name} fixture`,
    inputSchema: { type: "object" },
    annotations: { readOnlyHint: true, destructiveHint: false },
  };
}

async function startMcpFixture({ listTools, workspaceResult, sessionId, metrics = {}, getRedirect }) {
  return await listen(async (req, res) => {
    if (
      req.url !== "/mcp" ||
      req.socket.remoteAddress !== "127.0.0.1" ||
      req.headers["x-c2c-tunnel-token"] !== fixtureToken
    ) {
      res.writeHead(401).end();
      return;
    }

    if (req.method === "GET") {
      metrics.getRequests = (metrics.getRequests ?? 0) + 1;
      if (getRedirect) {
        res.writeHead(307, { location: getRedirect }).end();
      } else {
        res.writeHead(405).end();
      }
      return;
    }

    if (req.method === "DELETE") {
      if (sessionId && req.headers["mcp-session-id"] !== sessionId) {
        res.writeHead(400).end();
        return;
      }
      metrics.deleteRequests = (metrics.deleteRequests ?? 0) + 1;
      res.writeHead(200).end();
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;
    const message = raw ? JSON.parse(raw) : undefined;

    if (message?.method === "notifications/initialized") {
      res.writeHead(202).end();
      return;
    }

    if (message?.method === "initialize") {
      sendJson(
        res,
        {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "production-verifier-fixture", version: "1.0.0" },
          },
        },
        sessionId ? { "mcp-session-id": sessionId } : undefined
      );
      return;
    }

    if (message?.method === "tools/list") {
      metrics.listRequests = (metrics.listRequests ?? 0) + 1;
      sendJson(res, { jsonrpc: "2.0", id: message.id, result: listTools(message.params?.cursor) });
      return;
    }

    if (message?.method === "tools/call" && message.params?.name === "workspace_info") {
      metrics.toolCalls = (metrics.toolCalls ?? 0) + 1;
      sendJson(res, { jsonrpc: "2.0", id: message.id, result: workspaceResult });
      return;
    }

    res.writeHead(404).end();
  });
}

function validWorkspaceInfo() {
  return {
    workspaceId: "workspace-fixture-id",
    workspaceName: "codex-with-chatgpt",
    rootAlias: "workspace:/",
    git: { branch: "main" },
  };
}

function workspaceResult(info, overrides = {}) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(info),
      },
    ],
    ...overrides,
  };
}

function validWorkspaceResult(overrides = {}) {
  return workspaceResult(validWorkspaceInfo(), overrides);
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("production MCP verifier input and transport fences", () => {
  it("rejects a mapped Windows drive whose native realpath is a network share", () => {
    expect(() =>
      localRegularFile("Y:\\token", "token file", {
        platform: "win32",
        lstatSync: () => ({ isFile: () => true }),
        realpathSync: () => "Y:\\token",
        realpathNativeSync: () => "\\\\HOST\\share\\token",
      })
    ).toThrow(/resolved path unsafe/);
  });

  it("rejects a string bridge port before making a request", async () => {
    let requestCount = 0;
    const port = await listen((_req, res) => {
      requestCount += 1;
      res.writeHead(500).end();
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: String(port), token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(requestCount).toBe(0);
  });

  it("rejects a relative token path before making a request", async () => {
    let requestCount = 0;
    const port = await listen((_req, res) => {
      requestCount += 1;
      res.writeHead(500).end();
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: path.basename(fixture.tokenFile) },
    });

    expect(result.code).toBe(1);
    expect(requestCount).toBe(0);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["numeric file descriptor", 0],
    ["empty", ""],
  ])("rejects a %s token_file before making a request", async (_caseName, tokenFile) => {
    let requestCount = 0;
    const port = await listen((_req, res) => {
      requestCount += 1;
      res.writeHead(500).end();
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: tokenFile },
    });

    expect(result.code).toBe(1);
    expect(requestCount).toBe(0);
  });

  it("rejects a relative state-file path before making a request", async () => {
    let requestCount = 0;
    const port = await listen((_req, res) => {
      requestCount += 1;
      res.writeHead(500).end();
    });
    const fixture = makeFixture();
    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
      env: { C2C_VERIFY_STATE_FILE: "state.json" },
    });

    expect(result.code).toBe(1);
    expect(requestCount).toBe(0);
  });

  it.each(["\\\\HOST\\share\\file", "\\\\?\\C:\\fixture\\file", "\\??\\C:\\fixture\\file", "\\Device\\fixture"])(
    "rejects an unsafe Windows path before lstat: %s",
    (unsafePath) => {
      let lstatCalls = 0;
      expect(() =>
        localRegularFile(unsafePath, "state file", {
          platform: "win32",
          lstatSync: () => {
            lstatCalls += 1;
            return { isFile: () => true };
          },
          realpathNativeSync: () => unsafePath,
        })
      ).toThrow(/path unsafe/);
      expect(lstatCalls).toBe(0);
    }
  );

  it("rejects a non-regular file before native realpath", () => {
    let realpathCalls = 0;
    expect(() =>
      localRegularFile("C:\\fixture\\directory", "token file", {
        platform: "win32",
        lstatSync: () => ({ isFile: () => false }),
        realpathNativeSync: () => {
          realpathCalls += 1;
          return "C:\\fixture\\directory";
        },
      })
    ).toThrow(/not a regular file/);
    expect(realpathCalls).toBe(0);
  });

  it("rejects a symbolic-link lstat result without a platform privilege dependency", () => {
    expect(() =>
      localRegularFile("C:\\fixture\\token-link", "token file", {
        platform: "win32",
        lstatSync: () => ({ isFile: () => false, isSymbolicLink: () => true }),
        realpathNativeSync: () => "C:\\fixture\\token",
      })
    ).toThrow(/not a regular file/);
  });

  it.each([0, 65_536, 1.5])("rejects invalid bridge port %s", async (bridgePort) => {
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: bridgePort, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
  });

  it("rejects a malformed token before making a request", async () => {
    let requestCount = 0;
    const port = await listen((_req, res) => {
      requestCount += 1;
      res.writeHead(500).end();
    });
    const fixture = makeFixture();
    fs.writeFileSync(fixture.tokenFile, "malformed-token\n", "utf8");

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(requestCount).toBe(0);
  });

  it("rejects non-object and malformed state with one fixed JSON error", async () => {
    const fixture = makeFixture();
    const nonObject = await runVerifier({ root: fixture.root, state: null });
    const arrayState = await runVerifier({ root: fixture.root, state: [] });
    const malformed = await runVerifier({ root: fixture.root, stateText: "{" });

    for (const result of [nonObject, arrayState, malformed]) {
      expect(result.code).toBe(1);
      expect(result.timedOut).toBe(false);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
      expect(result.output).toEqual({ ok: false, error: "production_mcp_verification_failed" });
    }
  });

  it("stops an MCP redirect before the destination receives a request", async () => {
    let destinationRequests = 0;
    const destinationPort = await listen((_req, res) => {
      destinationRequests += 1;
      res.writeHead(500).end();
    });
    const redirectPort = await listen((_req, res) => {
      res.writeHead(307, { location: `http://127.0.0.1:${destinationPort}/capture` }).end();
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: redirectPort, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(destinationRequests).toBe(0);
  });

  it("stops the SDK SSE GET redirect before the destination receives a request", async () => {
    let destinationRequests = 0;
    const destinationPort = await listen((_req, res) => {
      destinationRequests += 1;
      res.writeHead(500).end();
    });
    const fixture = makeFixture();
    const metrics = {};
    const port = await startMcpFixture({
      listTools: () => ({ tools: expectedTools.map(readOnlyTool) }),
      workspaceResult: validWorkspaceResult(),
      metrics,
      getRedirect: `http://127.0.0.1:${destinationPort}/capture`,
    });

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(0);
    expect(metrics.getRequests).toBeGreaterThanOrEqual(1);
    expect(destinationRequests).toBe(0);
  });

  it("times out and closes a hanging initialized notification request", async () => {
    let requestClosed = false;
    let initializedRequests = 0;
    const port = await listen(async (req, res) => {
      if (req.url !== "/mcp" || req.headers["x-c2c-tunnel-token"] !== fixtureToken) {
        res.writeHead(401).end();
        return;
      }
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const message = JSON.parse(raw);
      if (message.method === "initialize") {
        sendJson(res, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "hanging-fixture", version: "1.0.0" },
          },
        });
        return;
      }
      if (message.method === "notifications/initialized") {
        initializedRequests += 1;
        res.once("close", () => {
          requestClosed = true;
        });
      }
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
    expect(initializedRequests).toBe(1);
    await waitFor(() => requestClosed);
    expect(requestClosed).toBe(true);
  }, 20_000);

  it("times out and closes an MCP response body that never ends", async () => {
    let requestClosed = false;
    const port = await listen((req, res) => {
      if (req.url !== "/mcp" || req.headers["x-c2c-tunnel-token"] !== fixtureToken) {
        res.writeHead(401).end();
        return;
      }
      res.once("close", () => {
        requestClosed = true;
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.flushHeaders();
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.timedOut).toBe(false);
    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
    await waitFor(() => requestClosed);
    expect(requestClosed).toBe(true);
  }, 20_000);
});

describe("production MCP verifier complete contract", () => {
  it("accepts a complete two-page read-only contract", async () => {
    const port = await startMcpFixture({
      listTools: (cursor) =>
        cursor === "page-2"
          ? { tools: expectedTools.slice(0, 4).reverse().map(readOnlyTool) }
          : { tools: expectedTools.slice(4).reverse().map(readOnlyTool), nextCursor: "page-2" },
      workspaceResult: validWorkspaceResult(),
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(0);
    expect(result.output).toEqual({
      ok: true,
      toolCount: 8,
      tools: [...expectedTools].sort(),
      exactReadOnlyAllowlist: true,
      allReadOnlyHints: true,
      workspaceSchemaValid: true,
      workspaceMatches: true,
      branchMatches: true,
    });
    expect(result.stdout.trim().split(/\r?\n/)).toHaveLength(1);
    expect(result.stderr).toBe("");
    expect(result.timedOut).toBe(false);
  });

  it("reads every tools/list page before enforcing the exact allowlist", async () => {
    const metrics = {};
    const port = await startMcpFixture({
      listTools: (cursor) =>
        cursor === "page-2"
          ? { tools: [readOnlyTool("write_file")] }
          : { tools: expectedTools.map(readOnlyTool), nextCursor: "page-2" },
      workspaceResult: validWorkspaceResult(),
      metrics,
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(metrics.listRequests).toBe(2);
    expect(metrics.toolCalls ?? 0).toBe(0);
  });

  it("rejects a duplicate allowed name that hides a missing tool", async () => {
    const metrics = {};
    const listedTools = expectedTools.map(readOnlyTool);
    listedTools[0] = readOnlyTool(expectedTools[1]);
    const port = await startMcpFixture({
      listTools: () => ({ tools: listedTools }),
      workspaceResult: validWorkspaceResult(),
      metrics,
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
    expect(metrics.listRequests).toBe(1);
    expect(metrics.toolCalls ?? 0).toBe(0);
  });

  it("rejects a repeated tools/list cursor", async () => {
    const metrics = {};
    const port = await startMcpFixture({
      listTools: () => ({ tools: expectedTools.map(readOnlyTool), nextCursor: "same-cursor" }),
      workspaceResult: validWorkspaceResult(),
      metrics,
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(metrics.listRequests).toBe(2);
    expect(metrics.toolCalls ?? 0).toBe(0);
  });

  it("rejects more than 32 distinct tools/list cursors", async () => {
    const metrics = {};
    const port = await startMcpFixture({
      listTools: (cursor) => {
        const page = cursor ? Number(cursor.slice("page-".length)) : 0;
        return { tools: [], nextCursor: `page-${page + 1}` };
      },
      workspaceResult: validWorkspaceResult(),
      metrics,
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(metrics.listRequests).toBe(32);
    expect(metrics.toolCalls ?? 0).toBe(0);
  });

  it.each([
    ["missing readOnlyHint", (tool) => delete tool.annotations.readOnlyHint],
    ["false readOnlyHint", (tool) => (tool.annotations.readOnlyHint = false)],
    ["true destructiveHint", (tool) => (tool.annotations.destructiveHint = true)],
    ["non-boolean destructiveHint", (tool) => (tool.annotations.destructiveHint = "false")],
  ])("rejects %s before calling workspace_info", async (_caseName, mutate) => {
    const metrics = {};
    const listedTools = expectedTools.map(readOnlyTool);
    mutate(listedTools[0]);
    const port = await startMcpFixture({
      listTools: () => ({ tools: listedTools }),
      workspaceResult: validWorkspaceResult(),
      metrics,
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
    expect(metrics.toolCalls ?? 0).toBe(0);
  });

  it("does not echo an untrusted tool name on contract failure", async () => {
    const untrustedName = "UNTRUSTED_TOOL_NAME_SENTINEL";
    const listedTools = expectedTools.map(readOnlyTool);
    listedTools[0] = readOnlyTool(untrustedName);
    const port = await startMcpFixture({
      listTools: () => ({ tools: listedTools }),
      workspaceResult: validWorkspaceResult(),
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain(untrustedName);
    expect(result.stderr).not.toContain(untrustedName);
  });

  it("rejects workspace_info tool errors even when their text looks valid", async () => {
    const port = await startMcpFixture({
      listTools: () => ({ tools: expectedTools.map(readOnlyTool) }),
      workspaceResult: validWorkspaceResult({ isError: true }),
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
  });

  it("rejects a non-boolean workspace_info isError field", async () => {
    const port = await startMcpFixture({
      listTools: () => ({ tools: expectedTools.map(readOnlyTool) }),
      workspaceResult: validWorkspaceResult({ isError: "false" }),
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
  });

  it.each([
    ["missing workspaceId", (info) => delete info.workspaceId],
    ["empty workspaceId", (info) => (info.workspaceId = "")],
    ["missing workspaceName", (info) => delete info.workspaceName],
    ["non-string workspaceName", (info) => (info.workspaceName = 42)],
    ["missing rootAlias", (info) => delete info.rootAlias],
    ["wrong rootAlias", (info) => (info.rootAlias = "file:///")],
    ["missing git", (info) => delete info.git],
    ["missing git.branch", (info) => delete info.git.branch],
    ["empty git.branch", (info) => (info.git.branch = "")],
  ])("rejects workspace_info schema with %s", async (_caseName, mutate) => {
    const info = validWorkspaceInfo();
    mutate(info);
    const port = await startMcpFixture({
      listTools: () => ({ tools: expectedTools.map(readOnlyTool) }),
      workspaceResult: workspaceResult(info),
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
  });

  it("rejects multiple workspace_info text payloads", async () => {
    const duplicate = validWorkspaceResult();
    duplicate.content.push({ ...duplicate.content[0] });
    const port = await startMcpFixture({
      listTools: () => ({ tools: expectedTools.map(readOnlyTool) }),
      workspaceResult: duplicate,
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
  });

  it.each([
    ["workspace", { C2C_VERIFY_WORKSPACE_NAME: "" }],
    ["branch", { C2C_VERIFY_BRANCH: "" }],
  ])("requires an explicit expected %s input", async (_caseName, env) => {
    const port = await startMcpFixture({
      listTools: () => ({ tools: expectedTools.map(readOnlyTool) }),
      workspaceResult: validWorkspaceResult(),
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
      env,
    });

    expect(result.code).toBe(1);
    expect(result.output?.ok).toBe(false);
  });

  it.each(["workspaceName", "branch"])("does not echo a mismatched %s", async (field) => {
    const sentinel = `UNTRUSTED_${field.toUpperCase()}_SENTINEL`;
    const info = validWorkspaceInfo();
    if (field === "workspaceName") info.workspaceName = sentinel;
    else info.git.branch = sentinel;
    const port = await startMcpFixture({
      listTools: () => ({ tools: expectedTools.map(readOnlyTool) }),
      workspaceResult: workspaceResult(info),
    });
    const fixture = makeFixture();

    const result = await runVerifier({
      root: fixture.root,
      state: { bridge_port: port, token_file: fixture.tokenFile },
    });

    expect(result.code).toBe(1);
    expect(result.output?.workspaceMatches).toBe(field !== "workspaceName");
    expect(result.output?.branchMatches).toBe(field !== "branch");
    expect(result.stdout).not.toContain(sentinel);
    expect(result.stderr).not.toContain(sentinel);
  });
});
