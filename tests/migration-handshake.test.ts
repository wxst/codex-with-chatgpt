import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { beforeEach, afterEach, it, expect } from "vitest";
import { beginTaskSend, claimStandbyConversation, confirmTaskDelivery, confirmTaskReply, confirmTaskWorkspace,
  importStandbyConversation, newMessageId, recordTaskHostControl, readTaskSession, sessionLedgerFile,
  switchTaskWorkspace, type MigrationReadObservation } from "../src/session/state.js";
import { createWorkspaceRouter } from "../src/router/state.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";
let root: string, workspace: string, target: string, evidence: MigrationReadObservation;
const taskId = "migration-task", source = "migration-source";
const tools = ["read_thread", "send_message_to_thread"];
const probe = () => recordTaskHostControl(target, taskId, { result: "probe", tools });
const authorize = (o = evidence) => recordTaskHostControl(target, taskId, { result: "migration-read-ok", migrationObservation: o });
const cli = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx/esm", "src/cli/index.ts", "session", ...args, "-w", workspace, "--task-id", taskId, "--json"],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: "", C2C_INTERNAL_STATE_DIR: "test" } });
beforeEach(async () => {
  root = isolateStateDir(); workspace = makeTmpDir("migration"); makeGitRepo(workspace);
  target = (await (await createWorkspaceRouter(workspace)).register(workspace)).workspaceId;
  await importStandbyConversation({ conversationId: "migration-chat", projectId: "g-p-migration", markerText: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "user" });
  await claimStandbyConversation({ workspaceId: source, taskId, connectorName: "C2C", workspaceName: "repo", branch: "main" });
  const id = newMessageId();
  await beginTaskSend(source, taskId, id, 20, { bootstrap: true });
  await confirmTaskDelivery(source, taskId, id); await confirmTaskReply(source, taskId, id, "DONE");
  const moved = await switchTaskWorkspace({ taskId, fromWorkspaceId: source, toWorkspaceId: target, expectedGeneration: 1, connectorName: "C2C", workspaceName: "repo", branch: "main" });
  evidence = { taskId, conversationId: moved.conversationId, fromWorkspaceId: source, toWorkspaceId: target,
    generation: 2, assignmentEpoch: moved.migrationHandshake!.assignmentEpoch, iteration: 20, messageId: id, state: "DONE",
    chatReadAt: new Date().toISOString(), chatStatus: "idle", readbackClean: true };
});
afterEach(() => { cleanup(root); cleanup(workspace); });
it("reproduces the CLI identity deadlock and completes the migration BOOT through preflight", async () => {
  expect(cli("host-control", "--result", "probe", "--tools", tools.join(",")).status).toBe(0);
  const rejected = cli("host-control", "--result", "read-ok", "--conversation-id", evidence.conversationId,
    "--observed-task-id", taskId, "--observed-workspace-id", source);
  expect(rejected.stdout + rejected.stderr).toContain("HOST_CONTROL_IDENTITY_MISMATCH");
  const file = path.join(root, "observation.json"); fs.writeFileSync(file, JSON.stringify(evidence));
  const authorized = cli("host-control", "--result", "migration-read-ok", "--observation-file", file);
  expect(authorized.status, authorized.stderr).toBe(0);
  expect(JSON.parse(authorized.stdout).status).toBe("migration_boot_ready");
  const id = newMessageId();
  expect(cli("begin-send", "--message-id", id, "--iteration", "21", "--expected-generation", "2").status).not.toBe(0);
  const boot = cli("begin-send", "--message-id", id, "--iteration", "21", "--expected-generation", "2", "--bootstrap");
  expect(boot.status, boot.stderr).toBe(0);
  // Simulate a reservation written by the legacy client that allowed REVIEW_HEAD on BOOT.
  const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  ledger.registries.find((r: any) => r.workspaceId === target).tasks[0].pendingReviewHead = "a".repeat(40);
  fs.writeFileSync(sessionLedgerFile(), JSON.stringify(ledger));
  const receipt = ["--message-id", id, "--observed-task-id", taskId, "--observed-workspace-id", target, "--observed-iteration", "21"];
  expect(cli("confirm-delivery", ...receipt).status).toBe(0);
  expect(cli("confirm-reply", ...receipt, "--observed-workspace-id", "wrong", "--state", "DONE").status).not.toBe(0);
  expect(cli("confirm-reply", ...receipt, "--observed-review-head", "b".repeat(40), "--state", "DONE").status).not.toBe(0);
  expect(cli("confirm-reply", ...receipt, "--state", "DONE").status).toBe(0);
  const ready = cli("confirm-workspace", "--observed-workspace-id", target, "--observed-route-task-id", taskId, "--observed-workspace-name", "repo", "--observed-branch", "main");
  expect(ready.status, ready.stderr).toBe(0);
  expect(readTaskSession(target, taskId)?.migrationHandshake?.completedAt).toBeTruthy();
});
it.each([
  { taskId: "wrong" }, { conversationId: "wrong" }, { fromWorkspaceId: "wrong" }, { toWorkspaceId: "wrong" },
  { generation: 3 }, { assignmentEpoch: 999 }, { iteration: 21 }, { state: "PLAN" }, { messageId: "wrong" },
  { readbackClean: "true" }, { chatStatus: "active" }, { useId: "fake" }, { generation: "2" },
  { chatReadAt: new Date(0).toISOString() }, { chatReadAt: "2099-01-01T00:00:00.000Z" },
])("rejects conflicting evidence without writes: %j", async patch => {
  await probe(); const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  await expect(authorize({ ...evidence, ...patch } as MigrationReadObservation)).rejects.toThrow();
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});
it("restores legacy history without changing generation or conversation", async () => {
  const file = sessionLedgerFile(), ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  const t = ledger.registries.find((r: any) => r.workspaceId === target).tasks[0]; delete t.migrationHandshake;
  for (const h of ledger.assignmentHistory) { delete h.snapshot; delete h.toWorkspaceId; delete h.toTaskId; delete h.toConversationId; delete h.assignmentEpoch; }
  fs.writeFileSync(file, JSON.stringify(ledger));
  await probe(); const result = await authorize();
  expect(result.generation).toBe(2); expect(result.conversationId).toBe(evidence.conversationId);
});
it("requires migration evidence even when hostControl is absent, and rejects the old DONE as new BOOT", async () => {
  await expect(beginTaskSend(target, taskId, newMessageId(), 21, { bootstrap: true, expectedGeneration: 2 })).rejects.toThrow(/MIGRATION/);
  await expect(confirmTaskWorkspace(target, taskId, { workspaceId: target, routeTaskId: taskId, workspaceName: "repo", branch: "main" })).rejects.toThrow(/MIGRATION/);
});
it("consumes BOOT authorization with a single concurrent winner and preserves pending", async () => {
  await probe(); await authorize();
  const results = await Promise.allSettled([1, 2].map(() => beginTaskSend(target, taskId, newMessageId(), 21, { bootstrap: true, expectedGeneration: 2 })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  await probe(); const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  await expect(authorize()).rejects.toThrow(/UNRESOLVED/);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});
it("preserves the receipt origin across consecutive unbooted migrations", async () => {
  const next = await switchTaskWorkspace({ taskId, fromWorkspaceId: target, toWorkspaceId: "third-workspace", expectedGeneration: 2, connectorName: "C2C", workspaceName: "repo", branch: "main" });
  target = "third-workspace"; evidence = { ...evidence, toWorkspaceId: target, generation: 3, assignmentEpoch: next.migrationHandshake!.assignmentEpoch };
  await probe(); expect((await authorize()).migrationHandshake?.fromWorkspaceId).toBe(source);
});

it.each(["missing", "duplicate", "wrong-destination"])("rejects unproven legacy lineage %s without writes", async kind => {
  const file = sessionLedgerFile(), ledger = JSON.parse(fs.readFileSync(file, "utf8"));
  delete ledger.registries.find((r: any) => r.workspaceId === target).tasks[0].migrationHandshake;
  if (kind === "missing") ledger.assignmentHistory = [];
  if (kind === "duplicate") ledger.assignmentHistory.push({ ...ledger.assignmentHistory.at(-1) });
  if (kind === "wrong-destination") ledger.assignmentHistory.at(-1).toWorkspaceId = "wrong";
  fs.writeFileSync(file, JSON.stringify(ledger)); await probe();
  const before = fs.readFileSync(file, "utf8"); await expect(authorize()).rejects.toThrow(/HISTORY/);
  expect(fs.readFileSync(file, "utf8")).toBe(before);
});
it("refuses another workspace switch after migration BOOT until workspace confirmation", async () => {
  await probe(); await authorize(); const id = newMessageId();
  await beginTaskSend(target, taskId, id, 21, { bootstrap: true, expectedGeneration: 2 });
  await confirmTaskDelivery(target, taskId, id); await confirmTaskReply(target, taskId, id, "DONE");
  await expect(switchTaskWorkspace({ taskId, fromWorkspaceId: target, toWorkspaceId: "third", expectedGeneration: 2,
    connectorName: "C2C", workspaceName: "repo", branch: "main" })).rejects.toThrow(/TASK_CHAT_BUSY/);
});
it("rejects missing and malformed CLI evidence without writes", async () => {
  await probe(); const file = path.join(root, "bad.json"), before = fs.readFileSync(sessionLedgerFile(), "utf8");
  expect(cli("host-control", "--result", "migration-read-ok").status).not.toBe(0);
  for (const raw of ["null", "[]", "{}", "not-json"]) {
    fs.writeFileSync(file, raw);
    expect(cli("host-control", "--result", "migration-read-ok", "--observation-file", file).status).not.toBe(0);
  }
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});
