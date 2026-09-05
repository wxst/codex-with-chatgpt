import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const checkout = path.resolve(scriptDir, "..");
const cli = path.join(checkout, "bin", "c2c.js");
const builtEntry = path.join(checkout, "dist", "cli", "index.js");
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-install-state-"));
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-install-workspace-"));

function runCli(args, env) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: checkout,
    env,
    encoding: "utf8",
    windowsHide: true,
  });

  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      [
        `CLI failed: node bin/c2c.js ${args.join(" ")}`,
        `exit: ${result.status}`,
        result.stdout ? `stdout:\n${result.stdout}` : "",
        result.stderr ? `stderr:\n${result.stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  }
  return result.stdout.trim();
}

function parseLastJson(output) {
  const lines = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  assert.ok(lines.length > 0, "expected CLI JSON output");
  return JSON.parse(lines.at(-1));
}

try {
  assert.ok(fs.existsSync(cli), "bin/c2c.js is missing");
  assert.ok(fs.existsSync(builtEntry), "dist/cli/index.js is missing; run the build first");

  fs.writeFileSync(
    path.join(workspace, "package.json"),
    `${JSON.stringify({ name: "c2c-install-smoke", private: true }, null, 2)}\n`,
    "utf8"
  );

  const env = {
    ...process.env,
    C2C_STATE_DIR: stateDir,
    C2C_INTERNAL_STATE_DIR: "test",
    NO_COLOR: "1",
  };

  const version = runCli(["--version"], env);
  assert.match(version, /^\d+\.\d+\.\d+$/u, "unexpected CLI version output");

  const help = runCli(["--help"], env);
  assert.match(help, /Codex with ChatGPT/u, "CLI help did not identify the product");
  assert.match(help, /transport/u, "CLI help did not expose transport management");

  const sessionHelp = runCli(["session", "--help"], env);
  assert.match(sessionHelp, /pool/u, "session help did not expose the standby pool");
  assert.match(sessionHelp, /record-read/u, "session help did not expose exact-conversation health tracking");
  assert.match(sessionHelp, /confirm-send-accepted/u, "session help did not expose host acceptance tracking");
  assert.match(sessionHelp, /record-delivery-pending/u, "session help did not expose late-delivery tracking");
  assert.match(sessionHelp, /migrate/u, "session help did not expose assignment-ledger migration");

  const failDeliveryHelp = runCli(["session", "fail-delivery", "--help"], env);
  assert.match(failDeliveryHelp, /--kind <kind>/u, "fail-delivery did not require a terminal failure kind");
  const sessionState = parseLastJson(runCli(
    ["session", "get", "-w", workspace, "--task-id", "install-smoke-task", "--json"],
    { ...env, CODEX_THREAD_ID: "install-smoke-task" }
  ));
  assert.equal(sessionState.ok, true);
  assert.equal(sessionState.taskId, "install-smoke-task");
  assert.equal(sessionState.taskIdSource, "CODEX_THREAD_ID");
  assert.equal(sessionState.requiresPoolClaim, true);
  const conflictingTask = spawnSync(process.execPath, [cli, "session", "get", "-w", workspace, "--task-id", "other-task", "--json"], {
    cwd: checkout,
    env: { ...env, CODEX_THREAD_ID: "install-smoke-task" },
    encoding: "utf8",
    windowsHide: true,
  });
  assert.notEqual(conflictingTask.status, 0, "a conflicting explicit task id was accepted");
  assert.match(`${conflictingTask.stdout}\n${conflictingTask.stderr}`, /TASK_ID_IDENTITY_MISMATCH/u);

  const poolHelp = runCli(["session", "pool", "--help"], env);
  assert.match(poolHelp, /claim/u, "standby pool help did not expose claim");
  assert.match(poolHelp, /import/u, "standby pool help did not expose import");

  const routerHelp = runCli(["router", "--help"], env);
  assert.match(routerHelp, /ensure/u, "router help did not expose ensure");

  const initial = parseLastJson(runCli(["transport", "-w", workspace, "--json"], env));
  assert.equal(initial.ok, true);
  assert.equal(initial.mode, "openai");
  assert.equal(initial.defaultMode, "openai");
  assert.equal(initial.openai?.headerName, "X-C2C-Tunnel-Token");
  assert.ok(typeof initial.openai?.tokenFile === "string");
  assert.ok(fs.existsSync(initial.openai.tokenFile), "OpenAI local token file was not created");
  assert.ok(path.resolve(initial.openai.tokenFile).startsWith(path.resolve(stateDir)));

  const fallback = parseLastJson(
    runCli(["transport", "-w", workspace, "--mode", "cloudflare", "--json"], env)
  );
  assert.equal(fallback.ok, true);
  assert.equal(fallback.mode, "cloudflare");
  assert.equal(fallback.openai, null);

  const restored = parseLastJson(
    runCli(["transport", "-w", workspace, "--mode", "openai", "--json"], env)
  );
  assert.equal(restored.ok, true);
  assert.equal(restored.mode, "openai");
  assert.ok(fs.existsSync(restored.openai.tokenFile));

  const status = parseLastJson(runCli(["status", "-w", workspace, "--json"], env));
  assert.equal(status.ok, false);
  assert.equal(status.running, false);

  process.stdout.write(
    `Installation smoke passed on ${process.platform}/${process.arch} with C2C ${version}.\n`
  );
} finally {
  fs.rmSync(stateDir, { recursive: true, force: true });
  fs.rmSync(workspace, { recursive: true, force: true });
}
