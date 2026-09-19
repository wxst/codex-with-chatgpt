import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import { beginTaskSend, claimStandbyConversation, confirmTaskDelivery, confirmTaskReply, confirmTaskWorkspace,
  importStandbyConversation, newMessageId, readTaskSession, recordTaskReadback, resumeTaskSession,
  sessionLedgerFile, sessionRecoveryGuidance, prepareTaskInit, digestBusinessMessage, type ReadbackObservation } from "../src/session/state.js";
import { validateObservedReplyText } from "../src/session/reply-text.js";
import { createWorkspaceRouter } from "../src/router/state.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

let root: string, target: string, id: string, useId: string;
const taskId = "browser-task", source = "source-workspace", chat = "browser-chat", head = "a".repeat(40);
const current = () => readTaskSession(source, taskId)!;
const disk = () => fs.readFileSync(sessionLedgerFile(), "utf8");
const observation = (patch: Partial<ReadbackObservation> = {}): ReadbackObservation => ({ taskId, workspaceId: source,
  conversationId: chat, generation: 1, assignmentEpoch: 1, messageId: id, iteration: 1,
  readAt: new Date().toISOString(), result: "request_visible", useId, ...patch });
const browser = (patch: Partial<ReadbackObservation> = {}) => observation({ source: "browser", sourceUrl: current().url, result: "reply_visible", ...patch });
const reply = () => `TASK_ID: ${taskId}\nWORKSPACE_ID: ${source}\nITERATION: 1\nMESSAGE_ID: ${id}\nREVIEW_HEAD: ${head}\n\nSTATE: DONE\n\nEvidence-backed result.\n`;
const identity = () => ({ taskId, workspaceId: source, messageId: id, iteration: 1 });
const cli = (...args: string[]) => spawnSync(process.execPath,
  ["--import", "tsx/esm", "src/cli/index.ts", "session", ...args, "-w", target, "--task-id", taskId, "--json"],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: "", C2C_INTERNAL_STATE_DIR: "test" } });

beforeEach(async () => {
  root = isolateStateDir(); target = makeTmpDir("browser-target");
  await importStandbyConversation({ conversationId: chat, projectId: "g-p-browser", markerText: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "user" });
  await claimStandbyConversation({ workspaceId: source, taskId, connectorName: "C2C", workspaceName: "source", branch: "main" });
  const boot = newMessageId(); await beginTaskSend(source, taskId, boot, 0, { bootstrap: true });
  await confirmTaskDelivery(source, taskId, boot); await confirmTaskReply(source, taskId, boot, "DONE");
  await confirmTaskWorkspace(source, taskId, { workspaceId: source, routeTaskId: taskId, workspaceName: "source", branch: "main" });
  useId = (await resumeTaskSession(source, taskId)).useId;
  id = newMessageId(); await beginTaskSend(source, taskId, id, 1, { useId, reviewHead: head });
  await confirmTaskDelivery(source, taskId, id, undefined, useId);
});
afterEach(() => { cleanup(root); cleanup(target); });

it.each([{ chatStatus: "idle" }, { hostTurnStatus: "completed" }, { result: "empty", chatStatus: "idle" }] as const)("uses browser observer after incomplete host transcript %j", async patch => {
  await recordTaskReadback(source, taskId, observation(patch));
  expect(sessionRecoveryGuidance("exact", current(), useId).coordinatorAction).toBe("read_exact_chat_in_browser");
  expect(sessionRecoveryGuidance("workspace_switch_required", current(), useId)).toMatchObject({ nextAction: "reconcile_source_pending", coordinatorAction: "read_exact_chat_in_browser" });
  expect(current().readbackObservation!.source).toBe("host");
});

it("does not confuse active generation with the completed user-only host turn", async () => {
  await recordTaskReadback(source, taskId, observation({ chatStatus: "active", hostTurnStatus: "completed" }));
  expect(sessionRecoveryGuidance("exact", current(), useId).coordinatorAction).toBe("wait_then_read");
});

it("browser visibility only suggests confirmation; normal identity, lease and body proof complete it", async () => {
  await recordTaskReadback(source, taskId, browser());
  expect(current().pendingMessageId).toBe(id);
  expect(sessionRecoveryGuidance("exact", current(), useId).coordinatorAction).toBe("confirm_receipt");
  const before = disk();
  await expect(confirmTaskReply(source, taskId, id, "DONE", head, undefined, useId)).rejects.toThrow("OBSERVED_REPLY_FILE_REQUIRED");
  const digest = validateObservedReplyText(reply(), identity(), "DONE", head);
  await expect(confirmTaskReply(source, taskId, id, "DONE", head, undefined, undefined, digest)).rejects.toThrow("TASK_USE_STALE");
  expect(disk()).toBe(before);
  await confirmTaskReply(source, taskId, id, "DONE", head, undefined, useId, digest);
  expect(current()).toMatchObject({ iteration: 1, lastState: "DONE", lastReplyEvidence: { source: "browser", sha256: digest, messageId: id } });
  expect(current().pendingMessageId).toBeUndefined();
  expect(disk()).not.toContain("Evidence-backed result");
});

it.each([
  { sourceUrl: undefined }, { sourceUrl: "http://chatgpt.com/c/browser-chat" },
  { sourceUrl: "https://evil.test/c/browser-chat" }, { sourceUrl: "https://chatgpt.com/c/another-chat" },
  { sourceUrl: "https://chatgpt.com/g/g-p-other/c/browser-chat" }, { sourceUrl: "https://chatgpt.com/c/browser-chat" },
  { sourceUrl: "https://chatgpt.com:123/c/browser-chat" }, { sourceUrl: "https://secret@chatgpt.com/c/browser-chat" },
  { sourceUrl: "https://chatgpt.com/g/g-p-browser/c/browser-chat?token=secret" },
  { hostTurnId: "host-turn" }, { hostTurnStatus: "completed" }, { source: "unknown" },
  { source: "host" }, { generation: 2 }, { assignmentEpoch: 2 }, { useId: undefined },
  { readAt: "2000-01-01T00:00:00.000Z" }, { readAt: "2099-01-01T00:00:00.000Z" },
])("rejects wrong URL/source/ownership with zero writes %j", async patch => {
  const before = disk(); await expect(recordTaskReadback(source, taskId, { ...browser(), ...patch })).rejects.toThrow(); expect(disk()).toBe(before);
});

it("normalizes www and trailing slash without accepting another project", async () => {
  await recordTaskReadback(source, taskId, browser({ sourceUrl: current().url.replace("https://", "https://www.") + "/" }));
  expect(current().readbackObservation!.source).toBe("browser");
});

it("browser absent and unavailable remain pending; older host reads cannot undo browser evidence", async () => {
  const old = observation({ readAt: new Date(Date.now() - 1000).toISOString() });
  await recordTaskReadback(source, taskId, browser({ result: "request_visible", chatStatus: "idle" }));
  expect(sessionRecoveryGuidance("exact", current(), useId).coordinatorAction).toBe("wait_then_read");
  await expect(recordTaskReadback(source, taskId, old)).rejects.toThrow("STALE");
  await recordTaskReadback(source, taskId, browser({ sourceUrl: undefined, result: "observation_blocked", errorCategory: "unavailable", blockedReason: "supported browser unavailable" }));
  expect(sessionRecoveryGuidance("exact", current(), useId).coordinatorAction).toBe("restore_observation");
  expect(current().pendingMessageId).toBe(id);
  await expect(beginTaskSend(source, taskId, newMessageId(), 2, { useId })).rejects.toThrow("in-flight");
});

it.each([
  (s: string) => s.replace(taskId, "other-task"), (s: string) => s.replace(source, "other-workspace"),
  (s: string) => s.replace("ITERATION: 1", "ITERATION: 01"), (s: string) => s.replace(id, newMessageId()),
  (s: string) => s.replace("STATE: DONE", "STATE: PLAN"), (s: string) => s.replace(head, "b".repeat(40)),
  (s: string) => s + `\nMESSAGE_ID: ${id}`, (s: string) => s.replace("STATE: DONE", ""),
])("validates actual assistant body, not caller claims", transform => {
  expect(() => validateObservedReplyText(transform(reply()), identity(), "DONE", head)).toThrow();
});

it("reconciles source pending from current workspace, releases own lease, then migrates normally through CLI", async () => {
  makeGitRepo(target); await createWorkspaceRouter(target);
  await recordTaskReadback(source, taskId, observation({ chatStatus: "idle", hostTurnStatus: "completed" }));
  expect(JSON.parse(cli("get", "--brief", "--use-id", useId).stdout)).toMatchObject({ chatUrl: current().url, nextAction: "reconcile_source_pending", coordinatorAction: "read_exact_chat_in_browser" });
  const file = path.join(root, "browser.json"), body = path.join(root, "reply.txt");
  fs.writeFileSync(file, JSON.stringify(browser())); fs.writeFileSync(body, reply());
  expect(cli("record-readback", "--bound-workspace", "--observation-file", file).status).toBe(0);
  const flags = ["--message-id", id, "--observed-task-id", taskId, "--observed-workspace-id", source,
    "--observed-iteration", "1", "--state", "DONE", "--observed-review-head", head, "--use-id", useId, "--observed-reply-file", body];
  const before = disk(); expect(cli("confirm-reply", ...flags).status).not.toBe(0); expect(disk()).toBe(before);
  const confirmed = cli("confirm-reply", "--bound-workspace", ...flags);
  expect(confirmed.status, confirmed.stderr).toBe(0);
  expect(JSON.parse(cli("get", "--brief", "--use-id", useId).stdout).nextAction).toBe("switch_workspace");
  expect(cli("finish", "--bound-workspace", "--use-id", useId).status).toBe(0);
  const moved = cli("switch-workspace", "--from-workspace-id", source, "--expected-generation", "1",
    "--observed-conversation-id", chat, "--observed-task-id", taskId, "--observed-workspace-id", source,
    "--observed-at", new Date().toISOString());
  expect(moved.status, moved.stderr).toBe(0);
  expect(JSON.parse(moved.stdout)).toMatchObject({ conversationId: chat, generation: 2 });
});

it("keeps INIT delivery digest and memory validation on the browser path", async () => {
  await confirmTaskReply(source, taskId, id, "DONE", head, undefined, useId);
  const init = await prepareTaskInit(source, taskId, { goal: "Inspect", constraints: "Read only", successCriteria: "Evidence",
    repository: { provider: "github", name: "repo", branch: "main" }, localState: "clean", memoryProject: "repo" }, { useId });
  id = init.messageId;
  await recordTaskReadback(source, taskId, browser({ iteration: init.iteration, result: "request_visible" }));
  const before = disk();
  await expect(confirmTaskDelivery(source, taskId, id, digestBusinessMessage("wrong"), useId)).rejects.toThrow();
  expect(disk()).toBe(before);
  await confirmTaskDelivery(source, taskId, id, digestBusinessMessage(init.message), useId);
  const body = `TASK_ID: ${taskId}\nWORKSPACE_ID: ${source}\nITERATION: ${init.iteration}\nMESSAGE_ID: ${id}\nSTATE: PLAN\nMEMORY_PROJECT: repo\nMEMORY_STATUS: READY\nMEMORY_SOURCES: memory_start_task, read_file\n`;
  const memory = { project: "repo", status: "ready" as const, sources: ["memory_start_task", "read_file"] };
  expect(() => validateObservedReplyText(body.replace("MEMORY_PROJECT: repo", "MEMORY_PROJECT: other"), { ...identity(), iteration: init.iteration }, "PLAN", undefined, memory)).toThrow();
  await recordTaskReadback(source, taskId, browser({ iteration: init.iteration }));
  const digest = validateObservedReplyText(body, { ...identity(), iteration: init.iteration }, "PLAN", undefined, memory);
  await expect(confirmTaskReply(source, taskId, id, "PLAN", undefined, undefined, useId, digest)).rejects.toThrow("MEMORY_REPLY_OBSERVATION_REQUIRED");
  await confirmTaskReply(source, taskId, id, "PLAN", undefined, memory, useId, digest);
  expect(current().memoryInitialization).toMatchObject({ generation: 1, project: "repo", status: "ready" });
});

it("browser and host confirmations race with at most one winner", async () => {
  await recordTaskReadback(source, taskId, browser());
  const digest = validateObservedReplyText(reply(), identity(), "DONE", head);
  const results = await Promise.allSettled([
    confirmTaskReply(source, taskId, id, "DONE", head, undefined, useId, digest),
    confirmTaskReply(source, taskId, id, "DONE", head, undefined, useId, digest),
  ]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(current().iteration).toBe(1);
});

it("all CLI continuation surfaces agree on the source pending action and forbid task impersonation", async () => {
  await recordTaskReadback(source, taskId, observation({ chatStatus: "idle" }));
  for (const args of [["get", "--brief"], ["resume", "--brief"], ["host-control", "--result", "probe", "--tools", "read_thread,send_message_to_thread"]]) {
    const result = cli(...args, "--use-id", useId);
    expect(JSON.parse(result.stdout)).toMatchObject({ nextAction: "reconcile_source_pending", coordinatorAction: "read_exact_chat_in_browser" });
  }
  const before = disk();
  const impersonate = spawnSync(process.execPath, ["--import", "tsx/esm", "src/cli/index.ts", "session", "finish", "--bound-workspace", "--use-id", useId, "--task-id", "other-task", "--json"],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: taskId, C2C_INTERNAL_STATE_DIR: "test" } });
  expect(impersonate.status).not.toBe(0);
  expect(impersonate.stdout + impersonate.stderr).toContain("TASK_ID_IDENTITY_MISMATCH");
  expect(disk()).toBe(before);
});

it.each([
  "memory_start_task_fake, read_file", "memory_start_task, read_file_extra", "memory_start_task",
  "memory_start_task, read_file, git_status", "memory_start_task, read_file, read_file", "memory_start_task, , read_file",
])("rejects mem source substitution, omissions and duplicates: %s", sources => {
  const text = reply() + `MEMORY_PROJECT: repo\nMEMORY_STATUS: READY\nMEMORY_SOURCES: ${sources}\n`;
  expect(() => validateObservedReplyText(text, identity(), "DONE", head,
    { project: "repo", status: "ready", sources: ["memory_start_task", "read_file"] })).toThrow("MEMORY_MISMATCH");
});

it("compares exact mem source sets and READY/DEGRADED reasons", () => {
  const text = reply() + "MEMORY_PROJECT: repo\nMEMORY_STATUS: READY\nMEMORY_SOURCES: read_file, memory_start_task\n";
  const memory = { project: "repo", status: "ready" as const, sources: ["memory_start_task", "read_file"] };
  expect(validateObservedReplyText(text, identity(), "DONE", head, memory)).toMatch(/^[a-f0-9]{64}$/u);
  expect(() => validateObservedReplyText(text + "MEMORY_REASON: hidden failure\n", identity(), "DONE", head, memory)).toThrow("MEMORY_MISMATCH");
  for (const reason of ["", "MEMORY_REASON: wrong\n"]) {
    expect(() => validateObservedReplyText(text.replace("STATUS: READY", "STATUS: DEGRADED") + reason, identity(), "DONE", head,
      { ...memory, status: "degraded", reason: "unavailable" })).toThrow();
  }
  expect(validateObservedReplyText(text.replace("STATUS: READY", "STATUS: DEGRADED") + "MEMORY_REASON: unavailable\n", identity(), "DONE", head,
    { ...memory, status: "degraded", reason: "unavailable" })).toMatch(/^[a-f0-9]{64}$/u);
});
