#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const pipePath = process.env.CODEX_APP_TOOLS_PIPE_PATH?.trim();
if (!pipePath) {
  process.stderr.write("CODEX_APP_TOOLS_PIPE_PATH is not set; run this check inside Codex App.\n");
  process.exit(2);
}

const pluginRoot = path.join(
  process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
  "plugins",
  "cache",
  "openai-bundled",
  "codex-app-tools"
);
const candidates = fs.existsSync(pluginRoot)
  ? fs.readdirSync(pluginRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(pluginRoot, entry.name, "server.mjs"))
    .filter((file) => fs.existsSync(file))
    .sort()
    .reverse()
  : [];
if (candidates.length === 0) {
  process.stderr.write("Codex App tools proxy was not found.\n");
  process.exit(2);
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [candidates[0]],
  env: { ...process.env, CODEX_APP_TOOLS_PIPE_PATH: pipePath },
  stderr: "pipe",
});
const client = new Client({ name: "c2c-host-contract-verifier", version: "1.0.0" });

try {
  await client.connect(transport);
  const names = [];
  let cursor;
  const expected = ["list_threads", "read_thread", "send_message_to_thread"];
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    names.push(...page.tools.map((tool) => tool.name));
    cursor = page.nextCursor;
  } while (cursor);

  const missing = expected.filter((name) => !names.includes(name));
  if (missing.length > 0) {
    process.stderr.write(JSON.stringify({
      ok: false,
      missingTools: missing,
      availableToolCount: names.length,
    }) + "\n");
    process.exitCode = 1;
  } else {
    process.stdout.write(JSON.stringify({ ok: true, tools: expected }) + "\n");
  }
} finally {
  await client.close().catch(() => undefined);
}
