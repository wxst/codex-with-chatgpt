import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginTaskSend,
  claimStandbyConversation,
  confirmTaskSendAccepted,
  confirmTaskDelivery,
  confirmTaskReply,
  failTaskDelivery,
  importStandbyConversation,
  newMessageId,
  recordTaskDeliveryPending,
  readSessionRegistry,
  recordTaskReadResult,
  resolveCodexTaskId,
} from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let stateRoot: string | undefined;
afterEach(() => { if (stateRoot) cleanup(stateRoot); stateRoot = undefined; });
const reset = (): void => { stateRoot = isolateStateDir(); };

async function claimedTask(workspaceId = "workspace123", taskId = "task-a") {
  await importStandbyConversation({
    conversationId: `standby-${taskId}`, projectId: "g-p-sessionpool123",
    markerText: "C2C_STANDBY_READY", markerMessageId: `marker-${taskId}`, markerRole: "user",
  });
  return claimStandbyConversation({ workspaceId, taskId, connectorName: "C2C Router", workspaceName: "repo", branch: "main" });
}

describe("task-scoped standby session registry", () => {
  it("uses the stable host task id before an explicit or generated id", () => {
    expect(resolveCodexTaskId("explicit", { CODEX_THREAD_ID: "host-task" })).toMatchObject({ taskId: "host-task", source: "CODEX_THREAD_ID" });
    expect(resolveCodexTaskId("explicit", {})).toMatchObject({ taskId: "explicit", source: "explicit" });
    expect(resolveCodexTaskId(undefined, {}).generated).toBe(true);
  });

  it("accepts task content only after a user-confirmed xhigh pool claim is ready", async () => {
    reset();
    const claimed = await claimedTask();
    const messageId = newMessageId();
    await expect(beginTaskSend("workspace123", "task-a", messageId, 1)).rejects.toThrow(/workspace verification/);
    const bootId = newMessageId();
    await beginTaskSend("workspace123", "task-a", bootId, 0, { bootstrap: true });
    await confirmTaskDelivery("workspace123", "task-a", bootId);
    const completed = await confirmTaskReply("workspace123", "task-a", bootId, "DONE");
    expect(completed.lastState).toBe("DONE");
    expect(claimed.task.settingsSource).toBe("user_confirmed");
    expect(claimed.task.thinkingLevel).toBe("xhigh");
  });

  it("keeps an accepted send in flight when the initial delivery check sees no message", async () => {
    reset();
    await claimedTask();
    const messageId = newMessageId();
    await beginTaskSend("workspace123", "task-a", messageId, 0, { bootstrap: true });
    const accepted = await confirmTaskSendAccepted("workspace123", "task-a", messageId);
    const pending = await recordTaskDeliveryPending("workspace123", "task-a", messageId);

    expect(accepted.sendAcceptedAt).toBeTruthy();
    expect(pending.channelState).toBe("sending");
    expect(pending.pendingMessageId).toBe(messageId);
    expect(pending.deliveryPendingSince).toBeTruthy();
    await expect(beginTaskSend("workspace123", "task-a", newMessageId(), 0, { bootstrap: true }))
      .rejects.toThrow(/in-flight/);
  });

  it("confirms a delayed message after it was recorded as pending", async () => {
    reset();
    await claimedTask();
    const messageId = newMessageId();
    await beginTaskSend("workspace123", "task-a", messageId, 0, { bootstrap: true });
    await confirmTaskSendAccepted("workspace123", "task-a", messageId);
    await recordTaskDeliveryPending("workspace123", "task-a", messageId);
    const delivered = await confirmTaskDelivery("workspace123", "task-a", messageId);
    expect(delivered.channelState).toBe("awaiting_reply");
    expect(delivered.deliveryPendingSince).toBeUndefined();
    const completed = await confirmTaskReply("workspace123", "task-a", messageId, "DONE");

    expect(completed.channelState).toBe("ready");
    expect(completed.pendingMessageId).toBeUndefined();
    expect(completed.deliveryPendingSince).toBeUndefined();
  });

  it("quarantines a send only for a terminal host rejection", async () => {
    reset();
    await claimedTask();
    const messageId = newMessageId();
    await beginTaskSend("workspace123", "task-a", messageId, 0, { bootstrap: true });
    await confirmTaskSendAccepted("workspace123", "task-a", messageId);

    await expect(
      failTaskDelivery("workspace123", "task-a", messageId, "delivery_absent", "short readback window elapsed")
    ).rejects.toThrow(/terminal/);

    const rejected = await failTaskDelivery(
      "workspace123", "task-a", messageId, "host_rejected", "host returned a terminal send error"
    );
    expect(rejected.channelState).toBe("degraded");
    expect(rejected.pendingMessageId).toBeUndefined();
  });

  it.each(["conversation_gone", "identity_mismatch"])("retires the exact Chat after %s", async (kind) => {
    reset();
    const claimed = await claimedTask();
    const messageId = newMessageId();
    await beginTaskSend("workspace123", "task-a", messageId, 0, { bootstrap: true });
    await confirmTaskSendAccepted("workspace123", "task-a", messageId);

    const retired = await failTaskDelivery("workspace123", "task-a", messageId, kind, "terminal host evidence");
    expect(retired.bindingState).toBe("unavailable");
    expect(retired.replacedConversations).toContainEqual(expect.objectContaining({ conversationId: claimed.task.conversationId }));
    expect(retired.pendingMessageId).toBeUndefined();
  });

  it("retains a degraded exact Chat and retires it only after deletion", async () => {
    reset();
    const claimed = await claimedTask();
    const timeout = await recordTaskReadResult("workspace123", "task-a", "timeout", "host timeout");
    expect(timeout.conversationId).toBe(claimed.task.conversationId);
    expect(timeout.bindingState).toBe("bound");
    const gone = await recordTaskReadResult("workspace123", "task-a", "gone", "deleted");
    expect(gone.bindingState).toBe("unavailable");
  });

  it("recognizes old per-workspace session files only as migration data", () => {
    reset();
    const file = path.join(process.env.C2C_STATE_DIR!, "sessions", "workspace123.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: 1, url: "https://chatgpt.com/c/legacy" }));
    const state = readSessionRegistry("workspace123");
    expect(state.legacyDetected).toBe(true);
    expect(state.registry.tasks).toEqual([]);
  });

  it("keeps a v3 legacy provision inert and lets the task claim standby inventory", async () => {
    reset();
    const file = path.join(process.env.C2C_STATE_DIR!, "sessions", "workspace123.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({
      version: 3,
      workspaceId: "workspace123",
      tasks: [],
      provisions: [{
        taskId: "task-a", generation: 1,
        provisionId: "c2c_provision_00000000-0000-4000-8000-000000000001",
        bindingCodeDigest: "legacy", bindingState: "provisioning", creationState: "pending",
        receiptMessageId: "c2c_msg_00000000-0000-4000-8000-000000000001",
        clientThreadId: "legacy-client", allowPro: false, seenConversationIds: [],
        createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      }],
      savedAt: "2026-01-01T00:00:00.000Z",
    }));
    await importStandbyConversation({
      conversationId: "standby-migrated", projectId: "g-p-sessionpool123",
      markerText: "C2C_STANDBY_READY", markerMessageId: "marker-migrated", markerRole: "user",
    });
    const claimed = await claimStandbyConversation({
      workspaceId: "workspace123", taskId: "task-a", connectorName: "C2C", workspaceName: "repo", branch: "main",
    });
    expect(claimed.task.conversationId).toBe("standby-migrated");
    expect(readSessionRegistry("workspace123").registry.provisions).toEqual([]);
  });
});
