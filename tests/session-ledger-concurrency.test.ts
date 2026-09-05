import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { importStandbyConversation, readStandbyPool } from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let stateRoot: string | undefined;

afterEach(() => {
  if (stateRoot) cleanup(stateRoot);
  stateRoot = undefined;
});

function runClaimWorker(taskId: string): Promise<{ conversationId: string }> {
  const worker = path.join(stateRoot!, `claim-${taskId}-${Math.random().toString(16).slice(2)}.mts`);
  const stateUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "session", "state.ts")).href;
  fs.writeFileSync(worker, `
import { claimStandbyConversation } from ${JSON.stringify(stateUrl)};
const result = await claimStandbyConversation({
  workspaceId: "shared-workspace",
  taskId: process.argv[2],
  connectorName: "C2C",
  workspaceName: "repo",
  branch: "main",
});
process.stdout.write(JSON.stringify({ conversationId: result.task.conversationId }));
`);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", worker, taskId], {
      env: { ...process.env, C2C_STATE_DIR: stateRoot, NODE_ENV: "test", VITEST: "true" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`claim worker exited ${code}: ${stderr}`));
        return;
      }
      resolve(JSON.parse(stdout) as { conversationId: string });
    });
  });
}

describe("global session assignment ledger", () => {
  it("serializes independent process claims and reuses the same task owner", async () => {
    stateRoot = isolateStateDir();
    await importStandbyConversation({
      conversationId: "ledger-chat-one", projectId: "g-p-ledgerpool123", markerText: "C2C_STANDBY_READY",
      markerMessageId: "ledger-marker-one", markerRole: "user", createdAt: "2026-01-01T00:00:00.000Z",
    });
    await importStandbyConversation({
      conversationId: "ledger-chat-two", projectId: "g-p-ledgerpool123", markerText: "C2C_STANDBY_READY",
      markerMessageId: "ledger-marker-two", markerRole: "user", createdAt: "2026-01-02T00:00:00.000Z",
    });

    const [first, duplicate, other] = await Promise.all([
      runClaimWorker("same-task"),
      runClaimWorker("same-task"),
      runClaimWorker("other-task"),
    ]);

    expect(first.conversationId).toBe(duplicate.conversationId);
    expect(other.conversationId).not.toBe(first.conversationId);
    expect(readStandbyPool().entries.filter((entry) => entry.status === "claimed")).toHaveLength(2);
  }, 30_000);
});
