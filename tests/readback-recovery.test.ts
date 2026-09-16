import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { beginTaskSend, claimStandbyConversation, confirmTaskDelivery, confirmTaskReply,
  confirmTaskSendAccepted, importStandbyConversation, newMessageId, readTaskSession,
  recordTaskHostControl, recordTaskReadback, resumeTaskSession, sessionLedgerFile,
  sessionRecoveryGuidance, failTaskDelivery, type ReadbackObservation } from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let root: string, workspace: string, messageId: string;
const taskId = "readback-task", chat = "readback-chat";
const cli = (...args: string[]) => spawnSync(process.execPath,
  ["--import", "tsx/esm", "src/cli/index.ts", "session", ...args, "--task-id", taskId, "--json"],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: "", C2C_INTERNAL_STATE_DIR: "test" } });
const current = () => readTaskSession(workspace, taskId)!;
const observation = (overrides: Partial<ReadbackObservation> = {}): ReadbackObservation => ({
  taskId, workspaceId: workspace, conversationId: chat, generation: 1, assignmentEpoch: 1,
  messageId, iteration: 0, readAt: new Date().toISOString(), result: "empty", ...overrides,
});
const disk = () => fs.readFileSync(sessionLedgerFile(), "utf8");

beforeEach(async () => {
  root = isolateStateDir();
  workspace = JSON.parse(cli("get", "--brief").stdout).requestedWorkspaceId;
  await importStandbyConversation({ conversationId: chat, projectId: "g-p-readback", markerText: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "user" });
  await claimStandbyConversation({ workspaceId: workspace, taskId, connectorName: "C2C", workspaceName: "repo", branch: "main" });
  await recordTaskHostControl(workspace, taskId, { result: "probe", tools: ["read_thread", "send_message_to_thread"] });
  await recordTaskHostControl(workspace, taskId, { result: "read-ok", conversationId: chat, observedTaskId: taskId, observedWorkspaceId: workspace });
  messageId = newMessageId();
});
afterEach(() => { vi.useRealTimers(); cleanup(root); });

it("refreshes expired preflight only before a new send, never instead of pending readback", async () => {
  const task = current();
  const later = Date.parse(task.hostControl!.checkedAt) + 60_001;
  expect(sessionRecoveryGuidance("exact", task, undefined, later).nextAction).toBe("probe_then_read_bound_chat");
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true });
  expect(sessionRecoveryGuidance("exact", current(), undefined, later).nextAction).toBe("delivery_readback_required");
  await confirmTaskDelivery(workspace, taskId, messageId);
  expect(sessionRecoveryGuidance("exact", current(), undefined, later).nextAction).toBe("reply_readback_required");
});

it("replays late delivery and >6-minute reply, idle/completed empty pages and timeout without a second reservation", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const start = Date.now();
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true });
  await confirmTaskSendAccepted(workspace, taskId, messageId);
  for (const elapsed of [0, 60_000, 300_000, 367_000]) {
    vi.setSystemTime(start + elapsed);
    await recordTaskReadback(workspace, taskId, observation({ chatStatus: "idle", hostTurnStatus: "completed", paginationComplete: false }));
    expect(sessionRecoveryGuidance("exact", current())).toMatchObject({ nextAction: "delivery_readback_required",
      nextReadInMs: elapsed < 60_000 ? 5000 : elapsed < 300_000 ? 15000 : 30000 });
    await expect(beginTaskSend(workspace, taskId, newMessageId(), 0, { bootstrap: true })).rejects.toThrow(/in-flight/);
  }
  await confirmTaskDelivery(workspace, taskId, messageId);
  const deliveredAt = current().replyWaitingSince;
  await recordTaskHostControl(workspace, taskId, { result: "timeout" });
  expect(current().channelState).toBe("awaiting_reply");
  expect(sessionRecoveryGuidance("exact", current()).waitingMs).toBe(0);
  for (const [elapsed, result] of [[60_000, "timeout"], [300_000, "empty"], [367_000, "reply_visible"], [900_000, "reply_visible"]] as const) {
    vi.setSystemTime(start + 367_000 + elapsed);
    await recordTaskReadback(workspace, taskId, observation({ result, chatStatus: "idle", hostTurnStatus: "completed", paginationComplete: false }));
    expect(current()).toMatchObject({ channelState: "awaiting_reply", pendingMessageId: messageId, lastDeliveredMessageId: messageId, replyWaitingSince: deliveredAt });
    expect(sessionRecoveryGuidance("exact", current())).toMatchObject({ nextAction: "reply_readback_required", waitingMs: elapsed, diagnosticRequired: elapsed >= 900_000 });
  }
  const before = disk();
  await expect(confirmTaskReply(workspace, taskId, newMessageId(), "DONE")).rejects.toThrow();
  expect(disk()).toBe(before);
  const results = await Promise.allSettled([confirmTaskReply(workspace, taskId, messageId, "DONE"), confirmTaskReply(workspace, taskId, messageId, "DONE")]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(current()).toMatchObject({ channelState: "ready", lastState: "DONE" });
  expect(current().pendingMessageId).toBeUndefined();
  expect(current().pendingDispatchUncertain).toBeUndefined();
  expect(current().readbackObservation).toBeUndefined();
});

it.each(["not-invoked", "host_rejected", "conversation_gone", "identity_mismatch"] as const)("cleans phase metadata only on proven terminal %s", async kind => {
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true });
  await recordTaskReadback(workspace, taskId, observation());
  if (kind === "not-invoked") await recordTaskHostControl(workspace, taskId, { result: kind, messageId });
  else await failTaskDelivery(workspace, taskId, messageId, kind, "explicit terminal host evidence");
  const task = current();
  for (const key of ["pendingMessageId", "pendingStartedAt", "replyWaitingSince", "readbackObservation"] as const) expect(task[key]).toBeUndefined();
});

it.each([
  { taskId: "wrong" }, { workspaceId: "wrong" }, { conversationId: "wrong" },
  { generation: 2 }, { assignmentEpoch: 2 }, { messageId: "wrong" }, { iteration: 1 },
  { generation: 1.5 }, { paginationComplete: "false" }, { hostTurnStatus: "unknown" },
  { readAt: "tomorrow" }, { result: "DONE" }, { routeToken: "forbidden" },
])("rejects invalid/changed observation with zero writes: %j", async patch => {
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true });
  const before = disk();
  await expect(recordTaskReadback(workspace, taskId, { ...observation(), ...patch })).rejects.toThrow();
  expect(disk()).toBe(before);
});

it("fences leases, future/expired and reordered reads, but accepts repeated observations", async () => {
  const leased = await resumeTaskSession(workspace, taskId);
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true, useId: leased.useId });
  const before = disk();
  await expect(recordTaskReadback(workspace, taskId, observation())).rejects.toThrow("TASK_USE_STALE");
  expect(disk()).toBe(before);
  for (const offset of [-60_001, 60_000]) {
    await expect(recordTaskReadback(workspace, taskId, observation({ useId: leased.useId, readAt: new Date(Date.now() + offset).toISOString() }))).rejects.toThrow("EXPIRED");
    expect(disk()).toBe(before);
  }
  const o = observation({ useId: leased.useId });
  await recordTaskReadback(workspace, taskId, o);
  await recordTaskReadback(workspace, taskId, o);
  const after = disk();
  await expect(recordTaskReadback(workspace, taskId, { ...o, readAt: new Date(Date.parse(o.readAt) - 1).toISOString() })).rejects.toThrow("STALE");
  expect(disk()).toBe(after);
  expect(sessionRecoveryGuidance("exact", current()).nextAction).toBe("wait_for_coordinator_lease");
  expect(sessionRecoveryGuidance("workspace_switch_required", current()).nextAction).toBe("switch_workspace");
  expect(sessionRecoveryGuidance("exact", current(), leased.useId).nextAction).toBe("delivery_readback_required");
});

it("runs observation files and recovery through real CLI with legacy degraded receipts and malformed UTF-8", async () => {
  expect(cli("begin-send", "--message-id", messageId, "--iteration", "0", "--bootstrap").status).toBe(0);
  const receipt = ["--message-id", messageId, "--observed-task-id", taskId, "--observed-workspace-id", workspace, "--observed-iteration", "0"];
  expect(cli("confirm-delivery", ...receipt).status).toBe(0);
  // A persisted old client could degrade the already-delivered message.
  const ledger = JSON.parse(disk());
  ledger.registries[0].tasks[0].channelState = "degraded";
  delete ledger.registries[0].tasks[0].replyWaitingSince;
  fs.writeFileSync(sessionLedgerFile(), JSON.stringify(ledger));
  const file = path.join(root, "readback.json");
  fs.writeFileSync(file, JSON.stringify(observation({ result: "empty", hostTurnStatus: "completed", chatStatus: "idle" })));
  const observed = cli("record-readback", "--observation-file", file);
  expect(observed.status, observed.stdout + observed.stderr).toBe(0);
  expect(JSON.parse(observed.stdout)).toMatchObject({ nextAction: "reply_readback_required", waitingMs: null, diagnosticRequired: true });
  expect(current().channelState).toBe("awaiting_reply");
  for (const args of [["get", "--brief"], ["resume", "--brief"], ["host-control", "--result", "probe", "--tools", "read_thread,send_message_to_thread"]]) {
    expect(JSON.parse(cli(...args).stdout).nextAction).toBe("reply_readback_required");
  }
  const before = disk();
  fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0x7b]));
  expect(cli("record-readback", "--observation-file", file).status).not.toBe(0);
  expect(disk()).toBe(before);
  expect(cli("confirm-reply", ...receipt, "--state", "DONE").status).toBe(0);
  expect(current().pendingMessageId).toBeUndefined();
});
