import { afterEach, beforeEach, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  beginTaskSend,
  claimStandbyConversation,
  confirmTaskDelivery,
  confirmTaskReply,
  confirmTaskWorkspace,
  digestBusinessMessage,
  importStandbyConversation,
  newMessageId,
  prepareTaskInit,
  readTaskSession,
  recordTaskHostControl,
  sessionLedgerFile,
  sessionRecoveryGuidance,
  switchTaskWorkspace,
} from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";

let root: string;
const workspace = "mem-workspace";
const taskId = "mem-task";
const chat = "mem-chat";
const input = {
  goal: "Locate the session delivery contract.",
  constraints: "Read-only analysis; do not write external systems.",
  successCriteria: "Cite the owner and receipt checks with tests.",
  repository: { provider: "gitea" as const, name: "wxst/codex-with-chatgpt", branch: "main" },
  localState: "clean main",
  memoryProject: "codex-with-chatgpt",
};

beforeEach(async () => {
  root = isolateStateDir();
  await importStandbyConversation({ conversationId: chat, projectId: "g-p-mem", markerText: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "user" });
  await claimStandbyConversation({ workspaceId: workspace, taskId, connectorName: "C2C", workspaceName: "repo", branch: "main" });
  const boot = newMessageId();
  await beginTaskSend(workspace, taskId, boot, 0, { bootstrap: true });
  await confirmTaskDelivery(workspace, taskId, boot);
  await confirmTaskReply(workspace, taskId, boot, "DONE");
  await confirmTaskWorkspace(workspace, taskId, { workspaceId: workspace, routeTaskId: taskId, workspaceName: "repo", branch: "main" });
});

afterEach(() => cleanup(root));

it("has a truthful analysis follow-up after weak PLAN without reinitializing mem or pretending execution", async () => {
  await expect(beginTaskSend(workspace, taskId, newMessageId(), 1, { messageKind: "analysis" })).rejects.toThrow("MEMORY_INIT_REQUIRED");
  const prepared = await prepareTaskInit(workspace, taskId, input);
  expect(sessionRecoveryGuidance("exact", prepared.task).businessGate).toBe("await_plan");
  await confirmTaskDelivery(workspace, taskId, prepared.messageId, prepared.messageDigest);
  const ready = await confirmTaskReply(workspace, taskId, prepared.messageId, "PLAN", undefined, {
    project: input.memoryProject, status: "ready", sources: ["memory_start_task"],
  });
  const analysisId = newMessageId();
  const analysis = await beginTaskSend(workspace, taskId, analysisId, 2, { messageKind: "analysis" });
  expect(analysis.memoryInitialization).toEqual(ready.memoryInitialization);
  expect(sessionRecoveryGuidance("exact", analysis).businessGate).toBe("await_plan");
  await confirmTaskDelivery(workspace, taskId, analysisId);
  await confirmTaskReply(workspace, taskId, analysisId, "PLAN");
  const executed = await beginTaskSend(workspace, taskId, newMessageId(), 3, { messageKind: "executed" });
  expect(sessionRecoveryGuidance("exact", executed).businessGate).toBe("await_review");
});

it("generates the fixed mem INIT, protects its exact readback, and unlocks EXECUTED only after READY", async () => {
  const prepared = await prepareTaskInit(workspace, taskId, input);
  expect(prepared.message).toContain("STATE: INIT");
  expect(prepared.message).toContain("memory_start_task");
  expect(prepared.message).toContain("memory_search");
  expect(prepared.message).toContain("codewiki_*");
  expect(prepared.message).toContain("gitea_*");
  expect(Buffer.byteLength(prepared.message, "utf8")).toBeLessThanOrEqual(1024);
  expect(prepared.messageDigest).toBe(digestBusinessMessage(prepared.message));
  expect(readTaskSession(workspace, taskId)).toMatchObject({
    pendingMessageId: prepared.messageId,
    pendingMessageKind: "init",
    pendingMessageDigest: prepared.messageDigest,
    pendingMemoryProject: input.memoryProject,
  });

  await expect(confirmTaskDelivery(workspace, taskId, prepared.messageId)).rejects.toThrow("C2C_INIT_READBACK_REQUIRED");
  await expect(confirmTaskDelivery(workspace, taskId, prepared.messageId, "0".repeat(64))).rejects.toThrow("C2C_INIT_READBACK_MISMATCH");
  expect(readTaskSession(workspace, taskId)?.pendingMessageId).toBe(prepared.messageId);
  await confirmTaskDelivery(workspace, taskId, prepared.messageId, digestBusinessMessage(prepared.message));
  await expect(confirmTaskReply(workspace, taskId, prepared.messageId, "PLAN")).rejects.toThrow("MEMORY_REPLY_OBSERVATION_REQUIRED");
  const ready = await confirmTaskReply(workspace, taskId, prepared.messageId, "PLAN", undefined, {
    project: input.memoryProject,
    status: "ready",
    sources: ["memory_start_task", "memory_search", "codewiki_repo_tree", "gitea_get_issue"],
  });
  expect(ready.memoryInitialization).toMatchObject({ generation: 1, project: input.memoryProject, status: "ready" });

  await expect(beginTaskSend(workspace, taskId, newMessageId(), 2, { messageKind: "executed" })).resolves.toMatchObject({ pendingMessageKind: "executed" });
});

it("turns a matching INIT reply that omits REVIEW_HEAD into a fenced clarification instead of a permanent pending receipt", async () => {
  const head = "a".repeat(40);
  const prepared = await prepareTaskInit(workspace, taskId, input, { reviewHead: head });
  expect(prepared.message).toContain("echo REVIEW_HEAD");
  await confirmTaskDelivery(workspace, taskId, prepared.messageId, prepared.messageDigest);

  const receipt = await confirmTaskReply(workspace, taskId, prepared.messageId, "PLAN", undefined, {
    project: input.memoryProject,
    status: "degraded",
    sources: ["memory_start_task", "memory_search", "workspace_info", "read_file"],
    reason: "acceptance connector was unavailable",
  });
  expect(receipt.reviewHeadClarification).toMatchObject({ generation: 1, expectedReviewHead: head, sourceMessageId: prepared.messageId });
  expect(sessionRecoveryGuidance("exact", receipt).nextAction).toBe("probe_then_read_bound_chat");
  await recordTaskHostControl(workspace, taskId, { result: "probe", tools: ["read_thread", "send_message_to_thread"] });
  const refreshed = await recordTaskHostControl(workspace, taskId, {
    result: "read-ok", conversationId: chat, observedTaskId: taskId, observedWorkspaceId: workspace,
  });
  expect(sessionRecoveryGuidance("exact", refreshed).nextAction).toBe("review_head_clarification_required");
  await expect(beginTaskSend(workspace, taskId, newMessageId(), 2, { messageKind: "executed" })).rejects.toThrow("REVIEW_HEAD_CLARIFICATION_REQUIRED");
  await expect(beginTaskSend(workspace, taskId, newMessageId(), 2, { messageKind: "analysis" })).rejects.toThrow("REVIEW_HEAD_CLARIFICATION_REQUIRED");

  const clarificationId = newMessageId();
  await beginTaskSend(workspace, taskId, clarificationId, 2, { messageKind: "analysis", reviewHead: head });
  await confirmTaskDelivery(workspace, taskId, clarificationId);
  const clarified = await confirmTaskReply(workspace, taskId, clarificationId, "PLAN", head);
  expect(clarified.reviewHeadClarification).toBeUndefined();
  expect(clarified.lastReviewHead).toBe(head);
  await expect(beginTaskSend(workspace, taskId, newMessageId(), 3, { messageKind: "executed" })).resolves.toMatchObject({ pendingMessageKind: "executed" });
});

it("permits explained DEGRADED memory while still fencing a changed generation", async () => {
  const prepared = await prepareTaskInit(workspace, taskId, input);
  await confirmTaskDelivery(workspace, taskId, prepared.messageId, prepared.messageDigest);
  const degraded = await confirmTaskReply(workspace, taskId, prepared.messageId, "PLAN", undefined, {
    project: input.memoryProject,
    status: "degraded",
    sources: ["memory_connector_unavailable"],
    reason: "project connector was unavailable",
  });
  expect(degraded.memoryInitialization).toMatchObject({ status: "degraded", reason: "project connector was unavailable" });
  const moved = await switchTaskWorkspace({ taskId, fromWorkspaceId: workspace, toWorkspaceId: "mem-next", expectedGeneration: 1, connectorName: "C2C", workspaceName: "next", branch: "main" });
  expect(moved.memoryInitialization).toBeUndefined();
  await expect(beginTaskSend("mem-next", taskId, newMessageId(), 2, { messageKind: "executed" })).rejects.toThrow("MEMORY_INIT_REQUIRED");
  await expect(beginTaskSend("mem-next", taskId, newMessageId(), 2, { messageKind: "analysis" })).rejects.toThrow("MEMORY_INIT_REQUIRED");
});

it("rejects malformed inputs, too-large generated bodies, and incomplete memory replies without changing the reservation", async () => {
  await expect(prepareTaskInit(workspace, taskId, { ...input, memoryProject: "" })).rejects.toThrow("C2C_INIT_MEMORY_PROJECT_REQUIRED");
  await expect(prepareTaskInit(workspace, taskId, {
    ...input,
    goal: "g".repeat(260), constraints: "c".repeat(260), successCriteria: "s".repeat(220),
    repository: { provider: "gitea", name: "n".repeat(160), branch: "b".repeat(120) },
    localState: "l".repeat(120), memoryProject: "m".repeat(120),
  })).rejects.toThrow("C2C_INIT_MESSAGE_TOO_LARGE");
  expect(readTaskSession(workspace, taskId)?.pendingMessageId).toBeUndefined();

  const prepared = await prepareTaskInit(workspace, taskId, input);
  await confirmTaskDelivery(workspace, taskId, prepared.messageId, prepared.messageDigest);
  await expect(confirmTaskReply(workspace, taskId, prepared.messageId, "PLAN", undefined, {
    project: input.memoryProject, status: "degraded", sources: ["memory_connector_unavailable"],
  })).rejects.toThrow("MEMORY_DEGRADED_REASON_REQUIRED");
  expect(readTaskSession(workspace, taskId)?.pendingMessageId).toBe(prepared.messageId);
});

it("rejects malformed persisted INIT and memory initialization metadata", async () => {
  const prepared = await prepareTaskInit(workspace, taskId, input);
  const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  ledger.registries[0].tasks[0].pendingMessageDigest = "not-a-digest";
  fs.writeFileSync(sessionLedgerFile(), JSON.stringify(ledger));
  expect(() => readTaskSession(workspace, taskId)).toThrow("C2C_INIT_PENDING_STATE_INVALID");
  expect(prepared.messageId).toMatch(/^c2c_msg_/u);
});

it("accepts only UTF-8 JSON through prepare-init and carries the generated receipt through CLI confirmation", async () => {
  const cli = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx/esm", "src/cli/index.ts", "session", ...args],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: "", C2C_INTERNAL_STATE_DIR: "test" } });
  const cliTask = "cli-mem-task";
  const workspaceId = JSON.parse(cli("get", "--task-id", cliTask, "--json").stdout).workspaceId;
  await importStandbyConversation({ conversationId: "cli-mem-chat", projectId: "g-p-mem", markerText: "C2C_STANDBY_READY", markerMessageId: "cli-marker", markerRole: "user" });
  await claimStandbyConversation({ workspaceId, taskId: cliTask, connectorName: "C2C", workspaceName: "repo", branch: "main" });
  await recordTaskHostControl(workspaceId, cliTask, { result: "probe", tools: ["read_thread", "send_message_to_thread"] });
  await recordTaskHostControl(workspaceId, cliTask, { result: "read-ok", conversationId: "cli-mem-chat", observedTaskId: cliTask, observedWorkspaceId: workspaceId });
  const boot = newMessageId();
  await beginTaskSend(workspaceId, cliTask, boot, 0, { bootstrap: true });
  await confirmTaskDelivery(workspaceId, cliTask, boot);
  await confirmTaskReply(workspaceId, cliTask, boot, "DONE");
  await confirmTaskWorkspace(workspaceId, cliTask, { workspaceId, routeTaskId: cliTask, workspaceName: "repo", branch: "main" });

  const invalid = path.join(root, "malformed.json");
  fs.writeFileSync(invalid, Buffer.from([0xff, 0xfe]));
  const malformed = cli("prepare-init", "--task-id", cliTask, "--input-file", invalid, "--json");
  expect(malformed.status).not.toBe(0);
  expect(malformed.stdout + malformed.stderr).toContain("C2C_INIT_INPUT_INVALID");

  const inputFile = path.join(root, "init.json");
  fs.writeFileSync(inputFile, JSON.stringify(input));
  const created = cli("prepare-init", "--task-id", cliTask, "--input-file", inputFile, "--json");
  expect(created.status).toBe(0);
  const payload = JSON.parse(created.stdout);
  expect(payload).toMatchObject({ reserved: true, task: { pendingMessageKind: "init", pendingMemoryProject: input.memoryProject } });
  const userReadback = path.join(root, "user-readback.txt");
  fs.writeFileSync(userReadback, payload.message);
  const receipt = ["--task-id", cliTask, "--message-id", payload.messageId, "--observed-task-id", cliTask,
    "--observed-workspace-id", workspaceId, "--observed-iteration", String(payload.iteration)];
  expect(cli("confirm-delivery", ...receipt, "--json").status).not.toBe(0);
  const delivered = cli("confirm-delivery", ...receipt, "--observed-message-file", userReadback, "--json");
  expect(delivered.status).toBe(0);
  const replied = cli("confirm-reply", ...receipt, "--state", "PLAN", "--memory-project", input.memoryProject,
    "--memory-status", "READY", "--memory-sources", "memory_start_task,memory_search", "--json");
  expect(replied.status).toBe(0);
  expect(JSON.parse(replied.stdout).task.memoryInitialization).toMatchObject({ status: "ready", project: input.memoryProject });
  const executed = cli("begin-send", "--task-id", cliTask, "--message-id", newMessageId(), "--iteration", "2", "--json");
  expect(executed.status).not.toBe(0);
  expect(executed.stdout + executed.stderr).toContain("BUSINESS_MESSAGE_KIND_REQUIRED");
  expect(cli("begin-send", "--task-id", cliTask, "--message-id", newMessageId(), "--iteration", "2", "--kind", "executed", "--json").status).toBe(0);
});
