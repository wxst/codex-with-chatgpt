import fs from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { localRegularFile } from "./verify-production-paths.mjs";

const EXPECTED_TOOLS = [
  "execution_summary",
  "git_diff",
  "git_status",
  "list_directory",
  "read_file",
  "search_workspace",
  "test_status",
  "workspace_info",
].sort();
const MAX_TOOL_PAGES = 32;
const MAX_TOOLS = 128;
const VERIFY_TIMEOUT_MS = 5_000;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} missing`);
  return value;
}

function loopbackEndpoint(port) {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("bridge port invalid");

  const endpoint = new URL(`http://127.0.0.1:${port}/mcp`);
  const expectedPort = port === 80 ? "" : String(port);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.port !== expectedPort ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.pathname !== "/mcp" ||
    endpoint.search !== "" ||
    endpoint.hash !== ""
  ) {
    throw new Error("bridge endpoint invalid");
  }
  return endpoint;
}

function requestUrl(input) {
  if (typeof input === "string") return new URL(input);
  if (input instanceof URL) return new URL(input.href);
  if (isRecord(input) && typeof input.url === "string") return new URL(input.url);
  throw new Error("request URL invalid");
}

function fencedFetch(endpoint, deadlineSignal) {
  return async (input, init) => {
    const requested = requestUrl(input);
    if (
      requested.origin !== endpoint.origin ||
      requested.username !== "" ||
      requested.password !== "" ||
      requested.pathname !== "/mcp" ||
      requested.search !== "" ||
      requested.hash !== ""
    ) {
      throw new Error("non-loopback MCP request blocked");
    }
    return await fetch(input, { ...init, redirect: "error", signal: deadlineSignal });
  };
}

async function listEveryTool(client, requestOptions) {
  const tools = [];
  const seenCursors = new Set();
  let cursor;

  for (let pageNumber = 0; pageNumber < MAX_TOOL_PAGES; pageNumber += 1) {
    const page =
      cursor === undefined
        ? await client.listTools(undefined, requestOptions)
        : await client.listTools({ cursor }, requestOptions);
    if (!isRecord(page) || !Array.isArray(page.tools)) throw new Error("tools page malformed");
    tools.push(...page.tools);
    if (tools.length > MAX_TOOLS) throw new Error("too many tools");

    if (page.nextCursor === undefined || page.nextCursor === null) return tools;
    if (typeof page.nextCursor !== "string" || page.nextCursor.length === 0) {
      throw new Error("tools cursor malformed");
    }
    if (seenCursors.has(page.nextCursor)) throw new Error("tools cursor repeated");
    seenCursors.add(page.nextCursor);
    cursor = page.nextCursor;
  }

  throw new Error("tools page limit exceeded");
}

function verifyTools(tools) {
  if (!tools.every((tool) => isRecord(tool) && typeof tool.name === "string")) {
    throw new Error("tool schema malformed");
  }
  const names = tools.map((tool) => tool.name).sort();
  const exactReadOnlyAllowlist =
    names.length === EXPECTED_TOOLS.length && names.every((name, index) => name === EXPECTED_TOOLS[index]);
  const allReadOnlyHints = tools.every(
    (tool) => {
      if (!isRecord(tool.annotations) || tool.annotations.readOnlyHint !== true) return false;
      const destructiveHint = tool.annotations.destructiveHint;
      return destructiveHint === undefined || destructiveHint === false;
    }
  );
  return { names, exactReadOnlyAllowlist, allReadOnlyHints };
}

function verifyWorkspaceResult(result, expectedWorkspaceName, expectedBranch) {
  if (!isRecord(result) || result.isError === true || !Array.isArray(result.content)) {
    throw new Error("workspace result malformed");
  }
  if (result.isError !== undefined && typeof result.isError !== "boolean") {
    throw new Error("workspace error flag malformed");
  }
  if (result.content.length !== 1) throw new Error("workspace content count invalid");
  const content = result.content[0];
  if (!isRecord(content) || content.type !== "text" || typeof content.text !== "string") {
    throw new Error("workspace text missing");
  }

  const info = JSON.parse(content.text);
  if (
    !isRecord(info) ||
    typeof info.workspaceId !== "string" ||
    info.workspaceId.trim().length === 0 ||
    typeof info.workspaceName !== "string" ||
    info.workspaceName.trim().length === 0 ||
    info.rootAlias !== "workspace:/" ||
    !isRecord(info.git) ||
    typeof info.git.branch !== "string" ||
    info.git.branch.trim().length === 0
  ) {
    throw new Error("workspace identity malformed");
  }

  return {
    workspaceMatches: info.workspaceName === expectedWorkspaceName,
    branchMatches: info.git.branch === expectedBranch,
  };
}

let client;
let deadlineTimer;
const deadlineController = new AbortController();
const requestOptions = { signal: deadlineController.signal, timeout: VERIFY_TIMEOUT_MS };

try {
  const stateFile = localRegularFile(requiredEnvironment("C2C_VERIFY_STATE_FILE"), "state file");
  const expectedWorkspaceName = requiredEnvironment("C2C_VERIFY_WORKSPACE_NAME");
  const expectedBranch = requiredEnvironment("C2C_VERIFY_BRANCH");

  const stateText = fs.readFileSync(stateFile, "utf8").replace(/^\uFEFF/, "");
  const state = JSON.parse(stateText);
  if (!isRecord(state)) throw new Error("state malformed");

  const endpoint = loopbackEndpoint(state.bridge_port);
  const tokenFile = localRegularFile(state.token_file, "token file");
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!/^c2c_tunnel_[A-Za-z0-9_-]{43}$/.test(token)) throw new Error("token file malformed");

  deadlineTimer = setTimeout(() => deadlineController.abort(), VERIFY_TIMEOUT_MS);
  client = new Client({ name: "c2c-production-verifier", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(endpoint, {
      requestInit: { headers: { "X-C2C-Tunnel-Token": token } },
      fetch: fencedFetch(endpoint, deadlineController.signal),
    }),
    requestOptions
  );

  const toolVerification = verifyTools(await listEveryTool(client, requestOptions));
  if (!toolVerification.exactReadOnlyAllowlist || !toolVerification.allReadOnlyHints) {
    throw new Error("read-only tool contract failed");
  }
  const workspaceVerification = verifyWorkspaceResult(
    await client.callTool({ name: "workspace_info", arguments: {} }, undefined, requestOptions),
    expectedWorkspaceName,
    expectedBranch
  );
  const ok =
    toolVerification.exactReadOnlyAllowlist &&
    toolVerification.allReadOnlyHints &&
    workspaceVerification.workspaceMatches &&
    workspaceVerification.branchMatches;

  console.log(
    JSON.stringify({
      ok,
      toolCount: toolVerification.names.length,
      tools: ok ? EXPECTED_TOOLS : [],
      exactReadOnlyAllowlist: toolVerification.exactReadOnlyAllowlist,
      allReadOnlyHints: toolVerification.allReadOnlyHints,
      workspaceSchemaValid: true,
      workspaceMatches: workspaceVerification.workspaceMatches,
      branchMatches: workspaceVerification.branchMatches,
    })
  );
  if (!ok) process.exitCode = 1;
} catch {
  console.log(JSON.stringify({ ok: false, error: "production_mcp_verification_failed" }));
  process.exitCode = 1;
} finally {
  if (client) await client.close().catch(() => undefined);
  if (deadlineTimer) clearTimeout(deadlineTimer);
  deadlineController.abort();
}
