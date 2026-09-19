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
    expect(sessionRecoveryGuidance("exact", current())).toMatchObject({ nextAction: "reply_readback_required", waitingMs: elapsed, diagnosticRequired: elapsed >= 900_000 && result !== "reply_visible" });
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
  expect(sessionRecoveryGuidance("workspace_switch_required", current()).nextAction).toBe("wait_for_coordinator_lease");
  expect(sessionRecoveryGuidance("workspace_switch_required", current(), leased.useId).nextAction).toBe("reconcile_source_pending");
  expect(sessionRecoveryGuidance("exact", current(), leased.useId).nextAction).toBe("delivery_readback_required");
});

it("runs observation files and recovery through real CLI with legacy degraded receipts and malformed UTF-8", async () => {
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true });
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

it("continues the same CLI lease through delivery, interruption and reply, fencing every receipt", async () => {
  const run = (...args: string[]) => {
    const r = cli(...args);
    expect(r.status, r.stdout + r.stderr).toBe(0);
    return JSON.parse(r.stdout);
  };
  const lease = run("resume", "--brief").useId;
  const beforeResume = disk();
  expect(run("resume", "--use-id", lease).useId).toBe(lease);
  expect(disk()).toBe(beforeResume);
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true, useId: lease });
  const identity = ["--message-id", messageId, "--observed-task-id", taskId, "--observed-workspace-id", workspace, "--observed-iteration", "0"];
  for (const args of [
    ["confirm-send-accepted", "--message-id", messageId],
    ["record-delivery-pending", "--message-id", messageId],
    ["confirm-delivery", ...identity],
    ["confirm-reply", ...identity, "--state", "DONE"],
    ["fail-delivery", "--message-id", messageId, "--kind", "host_rejected", "--reason", "explicit rejection"],
  ]) {
    const before = disk();
    expect(cli(...args).status).not.toBe(0);
    expect(cli(...args, "--use-id", "c2c_use_00000000-0000-0000-0000-000000000000").status).not.toBe(0);
    expect(disk()).toBe(before);
  }
  run("confirm-send-accepted", "--message-id", messageId, "--use-id", lease);
  run("record-delivery-pending", "--message-id", messageId, "--use-id", lease);
  expect(run("resume", "--use-id", lease)).toMatchObject({ useId: lease, nextAction: "delivery_readback_required", coordinatorAction: "read_now", businessGate: "await_boot" });
  run("confirm-delivery", ...identity, "--use-id", lease);
  const file = path.join(root, "continued.json");
  fs.writeFileSync(file, JSON.stringify(observation({ useId: lease, result: "reply_visible" })));
  run("record-readback", "--observation-file", file);
  for (const surface of ["get", "resume"]) {
    expect(run(surface, "--use-id", lease)).toMatchObject({ nextAction: "reply_readback_required", coordinatorAction: "confirm_receipt" });
  }
  expect(cli("finish", "--use-id", lease).status).not.toBe(0);
  await expect(beginTaskSend(workspace, taskId, newMessageId(), 0, { bootstrap: true, useId: lease })).rejects.toThrow();
  run("confirm-reply", ...identity, "--state", "DONE", "--use-id", lease);
  for (const surface of ["get", "resume"]) {
    expect(run(surface, "--use-id", lease)).toMatchObject({ nextAction: "workspace_confirmation_required", businessGate: "await_boot" });
  }
  const confirmWorkspace = ["confirm-workspace", "--observed-workspace-id", workspace, "--observed-route-task-id", taskId,
    "--observed-workspace-name", "repo", "--observed-branch", "main"];
  const beforeWorkspace = disk();
  expect(cli(...confirmWorkspace).status).not.toBe(0);
  expect(disk()).toBe(beforeWorkspace);
  run(...confirmWorkspace, "--use-id", lease);
  // A long real-CLI sequence may outlive the preflight; refresh it explicitly.
  run("host-control", "--result", "probe", "--tools", "read_thread,send_message_to_thread", "--use-id", lease);
  run("host-control", "--result", "read-ok", "--conversation-id", chat,
    "--observed-task-id", taskId, "--observed-workspace-id", workspace, "--use-id", lease);
  expect(run("resume", "--use-id", lease)).toMatchObject({ nextAction: "resume_bound_chat", businessGate: "assess_reply" });
  run("finish", "--use-id", lease);
  const finished = disk();
  expect(cli("resume", "--use-id", lease).status).not.toBe(0);
  expect(disk()).toBe(finished);
  expect(current().pendingMessageId).toBeUndefined();
});

it("does not mistake an old generation's DONE for the current BOOT", async () => {
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true });
  await confirmTaskDelivery(workspace, taskId, messageId);
  await confirmTaskReply(workspace, taskId, messageId, "DONE");
  expect(current().bootReplyGeneration).toBe(1);
  const changed = { ...current(), generation: 2 };
  expect(sessionRecoveryGuidance("exact", changed).nextAction).not.toBe("workspace_confirmation_required");
  expect(sessionRecoveryGuidance("exact", { ...changed, bootReplyGeneration: 2 }).nextAction).toBe("workspace_confirmation_required");
});

it("fences host recovery inside the state lock and ignores stale observation scheduling", async () => {
  const lease = await resumeTaskSession(workspace, taskId);
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true, useId: lease.useId });
  const before = disk();
  await expect(recordTaskHostControl(workspace, taskId, { result: "timeout" })).rejects.toThrow("TASK_USE_STALE");
  await expect(recordTaskHostControl(workspace, taskId, { result: "not-invoked", messageId })).rejects.toThrow("TASK_USE_STALE");
  expect(disk()).toBe(before);
  await recordTaskHostControl(workspace, taskId, { result: "timeout", useId: lease.useId });
  await recordTaskReadback(workspace, taskId, observation({ useId: lease.useId }));
  for (const patch of [{ generation: 2 }, { messageId: newMessageId() }, { readAt: new Date(Date.now() + 60_000).toISOString() }]) {
    const changed = { ...current(), readbackObservation: { ...current().readbackObservation!, ...patch } };
    expect(sessionRecoveryGuidance("exact", changed, lease.useId)).toMatchObject({ coordinatorAction: "read_now", observationAgeMs: null });
  }
});

it("makes diagnostics and concrete observation blockers resumable without turning them into send failure", async () => {
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true });
  await confirmTaskDelivery(workspace, taskId, messageId);
  const now = Date.now();
  expect(sessionRecoveryGuidance("exact", current(), undefined, now + 900_001)).toMatchObject({ coordinatorAction: "diagnose_readback", diagnosticRequired: true });
  await recordTaskReadback(workspace, taskId, observation({ result: "observation_blocked", errorCategory: "unavailable", blockedReason: "Host read tool unavailable after health check; exact result cannot be retrieved" }));
  expect(sessionRecoveryGuidance("exact", current())).toMatchObject({ coordinatorAction: "read_exact_chat_in_browser", businessGate: "await_boot", nextAction: "reply_readback_required" });
  expect(current().pendingMessageId).toBe(messageId);
  // Returning to a task never leaves it parked forever on an old blocker.
  expect(sessionRecoveryGuidance("exact", current(), undefined, Date.now() + 60_001).coordinatorAction).toBe("read_now");
  await recordTaskReadback(workspace, taskId, observation({ result: "request_visible", chatStatus: "idle", hostTurnStatus: "completed" }));
  expect(sessionRecoveryGuidance("exact", current()).coordinatorAction).toBe("read_exact_chat_in_browser");
  await recordTaskReadback(workspace, taskId, observation({ result: "reply_visible" }));
  expect(sessionRecoveryGuidance("exact", current()).coordinatorAction).toBe("confirm_receipt");
  await confirmTaskReply(workspace, taskId, messageId, "DONE");
});

it.each([
  { result: "observation_blocked" },
  { result: "observation_blocked", blockedReason: "", errorCategory: "unavailable" },
  { result: "observation_blocked", blockedReason: "idle", errorCategory: "timeout" },
  { result: "empty", blockedReason: "unexpected" },
])("rejects malformed diagnostic evidence without writes: %j", async patch => {
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true });
  const before = disk();
  await expect(recordTaskReadback(workspace, taskId, { ...observation(), ...patch })).rejects.toThrow("INVALID");
  expect(disk()).toBe(before);
});
