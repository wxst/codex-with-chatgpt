import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { beginTaskSend, claimStandbyConversation, confirmTaskDelivery, confirmTaskReply,
  confirmTaskSendAccepted, importStandbyConversation, newMessageId, readTaskSession,
  recordTaskHostControl, readStandbyPool, recordTaskReadResult, failTaskDelivery } from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let root: string;
const w = "host-workspace", t = "host-task", c = "host-chat";
const tools = ["read_thread", "send_message_to_thread"];
beforeEach(async () => {
  root = isolateStateDir();
  await importStandbyConversation({ conversationId: c, projectId: "g-p-host", markerText: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "user" });
  await claimStandbyConversation({ workspaceId: w, taskId: t, connectorName: "C2C", workspaceName: "repo", branch: "main" });
});
afterEach(() => cleanup(root));
const probe = (names = tools) => recordTaskHostControl(w, t, { result: "probe", tools: names });
const recover = () => recordTaskHostControl(w, t, { result: "read-ok", conversationId: c, observedTaskId: t, observedWorkspaceId: w });

it.each([{ names: [] }, { names: [tools[0]] }, { names: [tools[1]] }])("degrades without reserving or replacing for tools $names", async ({ names }) => {
  const pool = readStandbyPool();
  const task = await probe(names);
  expect(task.hostControl?.status).toBe("tools_missing");
  expect(task.hostControl?.missingTools).toEqual(tools.filter(x => !names.includes(x)));
  expect(task.channelState).toBe("degraded");
  expect(task.pendingMessageId).toBeUndefined();
  expect(task.sendAcceptedAt).toBeUndefined();
  expect(readStandbyPool()).toEqual(pool);
  await expect(beginTaskSend(w, t, newMessageId(), 0, { bootstrap: true, probe: true })).rejects.toThrow(/HOST_CONTROL/);
  await recordTaskReadResult(w, t, "ok");
  expect(readTaskSession(w, t)?.channelState).toBe("degraded");
});

it("requires exact readback after recovery and retains the binding", async () => {
  await probe([]); await probe();
  await expect(beginTaskSend(w, t, newMessageId(), 0, { bootstrap: true, probe: true })).rejects.toThrow(/HOST_CONTROL/);
  await expect(recordTaskHostControl(w, t, { result: "read-ok", conversationId: "wrong", observedTaskId: t, observedWorkspaceId: w })).rejects.toThrow(/IDENTITY/);
  const task = await recover();
  expect(task.hostControl?.status).toBe("ready");
  expect(task.conversationId).toBe(c);
  expect(task.generation).toBe(1);
});

it("cancels only a proven uninvoked reservation without advancing iteration", async () => {
  await probe(); await recover();
  const id = newMessageId();
  await beginTaskSend(w, t, id, 0, { bootstrap: true });
  await probe([]);
  const task = await recordTaskHostControl(w, t, { result: "not-invoked", messageId: id });
  expect(task.pendingMessageId).toBeUndefined();
  expect(task.iteration).toBe(0);
  expect(task.sendAcceptedAt).toBeUndefined();
  await expect(confirmTaskSendAccepted(w, t, id)).rejects.toThrow();
});

it.each([false, true])("keeps uncertain/accepted sends in flight across timeout (%s)", async accepted => {
  await probe(); await recover();
  const id = newMessageId();
  await beginTaskSend(w, t, id, 0, { bootstrap: true });
  if (accepted) await confirmTaskSendAccepted(w, t, id);
  const task = await recordTaskHostControl(w, t, { result: "timeout" });
  expect(task.hostControl?.status).toBe("call_timeout");
  expect(task.channelState).toBe("degraded");
  expect(task.pendingMessageId).toBe(id);
  if (accepted) await expect(recordTaskHostControl(w, t, { result: "not-invoked", messageId: id })).rejects.toThrow();
  await probe(); await recover();
  await expect(recordTaskHostControl(w, t, { result: "not-invoked", messageId: id })).rejects.toThrow();
  await expect(beginTaskSend(w, t, newMessageId(), 0, { bootstrap: true })).rejects.toThrow(/in-flight/);
  await expect(confirmTaskDelivery(w, t, newMessageId())).rejects.toThrow();
  await confirmTaskDelivery(w, t, id);
  await recordTaskHostControl(w, t, { result: "call-failed" });
  await probe(); await recover();
  await expect(confirmTaskReply(w, t, newMessageId(), "DONE")).rejects.toThrow();
  expect((await confirmTaskReply(w, t, id, "DONE")).pendingMessageId).toBeUndefined();
});

it.each(["conversation_gone", "identity_mismatch"])("handles terminal %s while degraded", async kind => {
  const id = newMessageId();
  await beginTaskSend(w, t, id, 0, { bootstrap: true });
  await recordTaskHostControl(w, t, { result: "timeout" });
  expect((await failTaskDelivery(w, t, id, kind, "explicit host result")).bindingState)
    .toBe(kind === "conversation_gone" ? "unavailable" : "quarantined");
});

it("rejects a reply for an old HEAD even with current receipt identity", async () => {
  const id = newMessageId(), head = "a".repeat(40);
  await beginTaskSend(w, t, id, 0, { bootstrap: true, reviewHead: head });
  await confirmTaskDelivery(w, t, id);
  await expect(confirmTaskReply(w, t, id, "DONE")).rejects.toThrow(/HEAD/);
  await expect(confirmTaskReply(w, t, id, "DONE", "b".repeat(40))).rejects.toThrow(/HEAD/);
  const task = await confirmTaskReply(w, t, id, "DONE", head);
  expect(task.lastReviewHead).toBe(head);
});

it("CLI refuses missing preflight and reports actual unaccepted failures", async () => {
  const cli = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx/esm", "src/cli/index.ts", "session", ...args],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: "", C2C_INTERNAL_STATE_DIR: "test" } });
  // The CLI resolves the real workspace hash, so claim a separate fixture owner for it.
  const get = cli("get", "--task-id", "cli-task", "--json");
  expect(get.status).toBe(0);
  const workspaceId = JSON.parse(get.stdout).workspaceId;
  await importStandbyConversation({ conversationId: "cli-chat", projectId: "g-p-host", markerText: "C2C_STANDBY_READY", markerMessageId: "cli-marker", markerRole: "user" });
  await claimStandbyConversation({ workspaceId, taskId: "cli-task", connectorName: "C2C", workspaceName: "repo", branch: "main" });
  const id = newMessageId();
  const blocked = cli("begin-send", "--task-id", "cli-task", "--message-id", id, "--iteration", "0", "--bootstrap");
  expect(blocked.status).not.toBe(0);
  expect(blocked.stdout + blocked.stderr).toContain("HOST_CONTROL_PREFLIGHT_REQUIRED");
  const missing = cli("host-control", "--task-id", "cli-task", "--result", "probe", "--tools", "none", "--json");
  expect(JSON.parse(missing.stdout)).toMatchObject({ status: "tools_missing", accepted: false, reserved: false });
  await recordTaskHostControl(workspaceId, "cli-task", { result: "probe", tools });
  await recordTaskHostControl(workspaceId, "cli-task", { result: "read-ok", conversationId: "cli-chat", observedTaskId: "cli-task", observedWorkspaceId: workspaceId });
  const started = cli("begin-send", "--task-id", "cli-task", "--message-id", id, "--iteration", "0", "--bootstrap", "--json");
  expect(started.status).toBe(0);
  const failed = cli("fail-delivery", "--task-id", "cli-task", "--message-id", id, "--kind", "host_rejected", "--reason", "explicit rejection", "--json");
  expect(JSON.parse(failed.stdout).accepted).toBe(false);
});
