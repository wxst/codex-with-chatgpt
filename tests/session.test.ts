import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  beginTaskSend,
  clearTaskSession,
  deliveryReadbackPhase,
  FAST_DELIVERY_READBACK_INTERVAL_MS,
  FAST_DELIVERY_READBACK_WINDOW_MS,
  claimStandbyConversation,
  confirmTaskSendAccepted,
  confirmTaskDelivery,
  confirmTaskReply,
  failTaskDelivery,
  importStandbyConversation,
  newMessageId,
  migrateSessionLedger,
  markTaskUnavailable,
  recordTaskDeliveryPending,
  sessionLedgerFile,
  readSessionRegistry,
  readStandbyPool,
  recordTaskReadResult,
  restoreTaskConversation,
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
  it("defines a sixty-second initial delivery readback window", () => {
    expect(FAST_DELIVERY_READBACK_WINDOW_MS).toBe(60_000);
    expect(FAST_DELIVERY_READBACK_INTERVAL_MS).toBe(5_000);
  });

  it("uses the accepted-send clock at 30, 59, 60, 61 seconds and five minutes", async () => {
    reset();
    await claimedTask();
    const messageId = newMessageId();
    await beginTaskSend("workspace123", "task-a", messageId, 0, { bootstrap: true });
    const accepted = await confirmTaskSendAccepted("workspace123", "task-a", messageId);
    const acceptedAt = Date.parse(accepted.sendAcceptedAt!);

    expect(deliveryReadbackPhase(accepted, acceptedAt + 30_000)).toBe("fast");
    expect(deliveryReadbackPhase(accepted, acceptedAt + 59_000)).toBe("fast");
    expect(deliveryReadbackPhase(accepted, acceptedAt + 60_000)).toBe("active");
    expect(deliveryReadbackPhase(accepted, acceptedAt + 61_000)).toBe("active");
    expect(deliveryReadbackPhase(accepted, acceptedAt + 5 * 60_000)).toBe("deferred");
  });

  it("rejects an explicit task id that conflicts with the stable host task id", () => {
    expect(() => resolveCodexTaskId("explicit", { CODEX_THREAD_ID: "host-task" }))
      .toThrow(/TASK_ID_IDENTITY_MISMATCH/);
    expect(resolveCodexTaskId("host-task", { CODEX_THREAD_ID: "host-task" }))
      .toMatchObject({ taskId: "host-task", source: "CODEX_THREAD_ID" });
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

  it("retires the exact Chat after explicit conversation deletion", async () => {
    reset();
    const claimed = await claimedTask();
    const messageId = newMessageId();
    await beginTaskSend("workspace123", "task-a", messageId, 0, { bootstrap: true });
    await confirmTaskSendAccepted("workspace123", "task-a", messageId);

    const retired = await failTaskDelivery("workspace123", "task-a", messageId, "conversation_gone", "terminal host evidence");
    expect(retired.bindingState).toBe("unavailable");
    expect(retired.replacedConversations).toContainEqual(expect.objectContaining({ conversationId: claimed.task.conversationId }));
    expect(retired.pendingMessageId).toBeUndefined();
  });

  it("quarantines an identity mismatch until an operator explicitly retires it", async () => {
    reset();
    const claimed = await claimedTask();
    const messageId = newMessageId();
    await beginTaskSend("workspace123", "task-a", messageId, 0, { bootstrap: true });
    await confirmTaskSendAccepted("workspace123", "task-a", messageId);

    const quarantined = await failTaskDelivery("workspace123", "task-a", messageId, "identity_mismatch", "wrong task receipt");

    expect(quarantined.bindingState).toBe("quarantined");
    expect(readStandbyPool().entries.find((entry) => entry.id === claimed.task.poolEntryId)).toMatchObject({ status: "quarantined" });
    await expect(claimStandbyConversation({
      workspaceId: "workspace123", taskId: "task-a", connectorName: "C2C Router", workspaceName: "repo", branch: "main",
    })).rejects.toThrow(/TASK_CHAT_QUARANTINED/);
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

  it("keeps the exact Chat through repeated temporary read misses", async () => {
    reset();
    const claimed = await claimedTask();
    const bootId = newMessageId();
    await beginTaskSend("workspace123", "task-a", bootId, 0, { bootstrap: true });
    await confirmTaskDelivery("workspace123", "task-a", bootId);
    const completed = await confirmTaskReply("workspace123", "task-a", bootId, "DONE");

    let observed = completed;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      observed = await recordTaskReadResult(
        "workspace123",
        "task-a",
        "missing",
        `temporary read miss ${attempt + 1}`
      );
    }

    expect(observed.bindingState).toBe("bound");
    expect(observed.conversationId).toBe(claimed.task.conversationId);
    expect(observed.channelState).toBe("degraded");
    expect(observed.consecutiveReadFailures).toBe(4);
    expect(observed.lastDeliveredMessageId).toBe(bootId);
    expect(observed.iteration).toBe(0);
  });

  it("writes the task binding and pool ownership to one global assignment ledger", async () => {
    reset();
    await claimedTask();

    const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8")) as {
      version: number;
      registries: { workspaceId: string; tasks: { taskId: string; conversationId: string }[] }[];
      pool: { entries: { conversationId: string; status: string; claimedBy?: { taskId: string } }[] };
    };
    expect(ledger.version).toBe(1);
    expect(ledger.registries).toContainEqual(expect.objectContaining({
      workspaceId: "workspace123",
      tasks: [expect.objectContaining({ taskId: "task-a", conversationId: "standby-task-a" })],
    }));
    expect(ledger.pool.entries).toContainEqual(expect.objectContaining({
      conversationId: "standby-task-a",
      status: "claimed",
      claimedBy: expect.objectContaining({ taskId: "task-a" }),
    }));
  });

  it("keeps the permanent owner record when an operator retires a task Chat", async () => {
    reset();
    const claimed = await claimedTask();

    const result = await clearTaskSession("workspace123", "task-a");
    const retired = readSessionRegistry("workspace123").registry.tasks.find((task) => task.taskId === "task-a");
    const entry = readStandbyPool().entries.find((candidate) => candidate.id === claimed.task.poolEntryId);

    expect(result.cleared).toBe(true);
    expect(retired).toMatchObject({
      bindingState: "unavailable",
      conversationId: claimed.task.conversationId,
    });
    expect(entry).toMatchObject({ status: "retired", conversationId: claimed.task.conversationId });
  });

  it("restores a legacy read-miss retirement to its exact verified Chat", async () => {
    reset();
    const claimed = await claimedTask();
    await markTaskUnavailable("workspace123", "task-a", "legacy transient read miss");

    const restored = await restoreTaskConversation("workspace123", "task-a", claimed.task.conversationId);

    expect(restored).toMatchObject({ bindingState: "bound", conversationId: claimed.task.conversationId });
    expect(readStandbyPool().entries.find((entry) => entry.id === claimed.task.poolEntryId)).toMatchObject({ status: "claimed" });
  });

  it("stops pool operations when the global assignment ledger is malformed", async () => {
    reset();
    await claimedTask();
    fs.writeFileSync(sessionLedgerFile(), "{ incomplete");

    expect(() => readStandbyPool()).toThrow(/SESSION_LEDGER_CORRUPT/);
  });

  it("stops claims when a ledger records one Chat under two task owners", async () => {
    reset();
    await claimedTask();
    const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8")) as {
      registries: { workspaceId: string; tasks: { taskId: string }[] }[];
    };
    const duplicate = JSON.parse(JSON.stringify(ledger.registries[0])) as { workspaceId: string; tasks: { taskId: string }[] };
    duplicate.workspaceId = "other-workspace";
    duplicate.tasks[0].taskId = "other-task";
    ledger.registries.push(duplicate);
    fs.writeFileSync(sessionLedgerFile(), JSON.stringify(ledger));

    await expect(claimStandbyConversation({
      workspaceId: "third-workspace", taskId: "third-task", connectorName: "C2C", workspaceName: "repo", branch: "main",
    })).rejects.toThrow(/SESSION_LEDGER_CONFLICT/);
  });

  it("migrates legacy pool and task files into the ledger with a backup", async () => {
    reset();
    const claimed = await claimedTask();
    const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8")) as {
      pool: unknown;
      registries: { workspaceId: string }[];
    };
    const sessions = path.dirname(sessionLedgerFile());
    fs.writeFileSync(path.join(sessions, "standby-pool.json"), JSON.stringify(ledger.pool));
    for (const registry of ledger.registries) {
      fs.writeFileSync(path.join(sessions, `${registry.workspaceId}.json`), JSON.stringify(registry));
    }
    fs.rmSync(sessionLedgerFile());

    const migration = await migrateSessionLedger();
    const migrated = readSessionRegistry("workspace123").registry.tasks.find((task) => task.taskId === "task-a")!;

    expect(migration.migrated).toBe(true);
    expect(migrated.conversationId).toBe(claimed.task.conversationId);
    expect(fs.existsSync(sessionLedgerFile())).toBe(true);
    expect(fs.readdirSync(sessions).some((name) => name.startsWith("legacy-backup-"))).toBe(true);
    await expect(migrateSessionLedger()).resolves.toMatchObject({ migrated: false });
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
