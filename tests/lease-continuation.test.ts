import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { Workspace } from "../src/workspace/manager.js";
import { afterEach, beforeEach, expect, it } from "vitest";
import { claimStandbyConversation, importStandbyConversation, readTaskSession, resumeTaskSession,
  sessionRecoveryGuidance, sessionLedgerFile, recordTaskHostControl, canAcquireContinuationLease, switchTaskWorkspace } from "../src/session/state.js";
import { cleanup, isolateStateDir } from "./helpers.js";
import { continuationFile, readContinuation, writeContinuation } from "../src/session/continuation.js";
import { beginTaskSend, confirmTaskDelivery, newMessageId, finishTaskSession } from "../src/session/state.js";

let root: string;
const workspace = new Workspace(process.cwd()).id, taskId = "lease-continuation", chat = "lease-chat";
const cli = (args: string[], hostTask = taskId) => spawnSync(process.execPath,
  ["--import", "tsx/esm", "src/cli/index.ts", "session", ...args, "--json"],
  { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: hostTask, C2C_INTERNAL_STATE_DIR: "test" } });
const current = () => readTaskSession(workspace, taskId)!;
beforeEach(async () => {
  root = isolateStateDir();
  await importStandbyConversation({ conversationId: chat, projectId: "g-p-lease", markerText: "C2C_STANDBY_READY", markerMessageId: "marker", markerRole: "user" });
  await claimStandbyConversation({ workspaceId: workspace, taskId, connectorName: "C2C", workspaceName: "repo", branch: "main" });
  await recordTaskHostControl(workspace, taskId, { result: "probe", tools: ["read_thread", "send_message_to_thread"] });
  await recordTaskHostControl(workspace, taskId, { result: "read-ok", conversationId: chat, observedTaskId: taskId, observedWorkspaceId: workspace });
});
afterEach(() => cleanup(root));

it("automatic CLI continuation acquires and persists only when no active lease exists and acquisition is safe", async () => {
  expect(sessionRecoveryGuidance("exact", current()).leaseStatus).toBe("none");
  const acquired = cli(["resume", "--recover-own"]);
  expect(acquired.status).toBe(0);
  const first = JSON.parse(acquired.stdout);
  expect(first).toMatchObject({ ok: true, leaseStatus: "own" });
  expect(readContinuation(taskId)).toMatchObject({ useId: first.useId, stage: "active" });
  await finishTaskSession(workspace, taskId, first.useId);
  const second = JSON.parse(cli(["resume", "--recover-own"]).stdout);
  expect(second).toMatchObject({ ok: true, leaseStatus: "own" });
  expect(second.useId).not.toBe(first.useId);
});

it("automatic CLI continuation cannot acquire over an unleased pending request", async () => {
  await beginTaskSend(workspace, taskId, newMessageId(), 0, { bootstrap: true });
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  expect(cli(["resume", "--recover-own"]).status).not.toBe(0);
  expect(readContinuation(taskId)).toBeNull();
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it("automatic acquisition preserves the requested workspace migration without creating a source lease", () => {
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  const result = cli(["resume", "--recover-own", "-w", root]);
  expect(result.status).not.toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, leaseStatus: "none", nextAction: "switch_workspace", businessGate: "connection_required" });
  expect(result.stdout).not.toContain("c2c_use_");
  expect(readContinuation(taskId)).toBeNull();
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it.each(["missing", "expired"])("automatic acquisition waits for %s preflight without writes", async mode => {
  const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  const task = ledger.registries.flatMap((r: { tasks: unknown[] }) => r.tasks).find((t: { taskId: string }) => t.taskId === taskId);
  if (mode === "missing") delete task.hostControl;
  else task.hostControl.checkedAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(sessionLedgerFile(), JSON.stringify(ledger));
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  const result = cli(["resume", "--recover-own"]);
  expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, nextAction: "probe_then_read_bound_chat", leaseStatus: "none" });
  await expect(resumeTaskSession(workspace, taskId, undefined, true)).rejects.toThrow("LEASE_ACQUISITION_PHASE_BLOCKED");
  expect(readContinuation(taskId)).toBeNull();
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it("lease acquisition permits only prepared BOOT, business and clarification phases", () => {
  const base = sessionRecoveryGuidance("exact", current());
  for (const nextAction of ["prepare_boot_required", "resume_boot_preparation", "resume_bound_chat", "review_head_clarification_required"]) {
    expect(canAcquireContinuationLease({ ...base, leaseStatus: "none", nextAction })).toBe(true);
  }
  for (const nextAction of ["switch_workspace", "migration_preflight_required", "workspace_confirmation_required", "reply_readback_required", "probe_then_read_bound_chat"]) {
    expect(canAcquireContinuationLease({ ...base, leaseStatus: "none", nextAction })).toBe(false);
  }
});

it("existing own lease restores across workspace and expired preflight without new acquisition", async () => {
  const { useId } = await resumeTaskSession(workspace, taskId);
  const ledger = JSON.parse(fs.readFileSync(sessionLedgerFile(), "utf8"));
  ledger.registries.flatMap((r: { tasks: any[] }) => r.tasks).find((t: { taskId: string }) => t.taskId === taskId).hostControl.checkedAt = "2000-01-01T00:00:00.000Z";
  fs.writeFileSync(sessionLedgerFile(), JSON.stringify(ledger));
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  expect(JSON.parse(cli(["resume", "--recover-own", "-w", root]).stdout)).toMatchObject({ ok: true, useId, nextAction: "release_own_lease_before_workspace_switch", businessGate: "connection_required" });
  expect(JSON.parse(cli(["resume", "--recover-own"]).stdout)).toMatchObject({ ok: true, useId, nextAction: "probe_then_read_bound_chat" });
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  await expect(switchTaskWorkspace({ fromWorkspaceId: workspace, toWorkspaceId: new Workspace(root).id, taskId,
    expectedGeneration: 1, connectorName: "C2C", workspaceName: "repo", branch: "main" })).rejects.toThrow("TASK_CHAT_BUSY");
  expect(cli(["finish", "-w", root, "--bound-workspace", "--use-id", "c2c_use_00000000-0000-4000-8000-000000000000"]).status).not.toBe(0);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  expect(cli(["finish", "-w", root, "--bound-workspace", "--use-id", useId]).status).toBe(0);
  expect(JSON.parse(cli(["get", "-w", root]).stdout)).toMatchObject({ leaseStatus: "none", nextAction: "switch_workspace" });
});

it("recovers the same private lease after output loss without rewriting the ledger", async () => {
  const first = await resumeTaskSession(workspace, taskId);
  expect(sessionRecoveryGuidance("exact", current()).leaseStatus).toBe("recoverable_own");
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  const recovered = await resumeTaskSession(workspace, taskId, undefined, true);
  expect(recovered.useId).toBe(first.useId);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it("classifies an explicit wrong lease as conflict without claiming another coordinator exists", async () => {
  await resumeTaskSession(workspace, taskId);
  const guidance = sessionRecoveryGuidance("exact", current(), "c2c_use_00000000-0000-4000-8000-000000000000");
  expect(guidance.leaseStatus).toBe("conflict");
  expect(guidance.recoveryReason).not.toContain("another coordinator");
  expect(guidance.businessGate).toBe("connection_required");
});

it.each(["after_record", "after_ledger", "before_output"] as const)("recovers interruption at %s with one lease", async fault => {
  await expect(resumeTaskSession(workspace, taskId, undefined, false, fault)).rejects.toThrow("LEASE_TEST_INTERRUPTION");
  const receipt = readContinuation(taskId)!;
  const recovered = await resumeTaskSession(workspace, taskId, undefined, true);
  expect(recovered.useId).toBe(receipt.useId);
  expect(readContinuation(taskId)?.stage).toBe("active");
});

it.each(["missing", "corrupt", "mismatch"])("never adopts an unproven %s continuation", async fault => {
  await resumeTaskSession(workspace, taskId);
  if (fault === "missing") fs.unlinkSync(continuationFile(taskId));
  else if (fault === "corrupt") fs.writeFileSync(continuationFile(taskId), "{}");
  else writeContinuation({ ...readContinuation(taskId)!, assignmentEpoch: 2 });
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  await expect(resumeTaskSession(workspace, taskId, undefined, true)).rejects.toThrow(/LEASE_/);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  expect(sessionRecoveryGuidance("exact", current()).businessGate).toBe("connection_required");
});

it("recovers pending and reads it even when the send tool disappears", async () => {
  const { useId } = await resumeTaskSession(workspace, taskId);
  const message = newMessageId();
  await beginTaskSend(workspace, taskId, message, 0, { bootstrap: true, useId });
  await confirmTaskDelivery(workspace, taskId, message, undefined, useId);
  await recordTaskHostControl(workspace, taskId, { result: "probe", tools: ["read_thread"], useId });
  const recovered = await resumeTaskSession(workspace, taskId, undefined, true);
  expect(recovered.pendingMessageId).toBe(message);
  expect(sessionRecoveryGuidance("exact", recovered, recovered.useId)).toMatchObject({ nextAction: "reply_readback_required", businessGate: "await_boot" });
  await expect(finishTaskSession(workspace, taskId, useId)).rejects.toThrow("TASK_CHAT_BUSY");
});

it("concurrent recoveries converge on the same lease", async () => {
  const recovered = await Promise.all([resumeTaskSession(workspace, taskId, undefined, true), resumeTaskSession(workspace, taskId, undefined, true)]);
  expect(recovered[0].useId).toBe(recovered[1].useId);
  await finishTaskSession(workspace, taskId, recovered[0].useId);
  expect(readContinuation(taskId)?.stage).toBe("released");
});

it("CLI get/resume/host-control agree without leaking an unproven lease", async () => {
  const { useId } = await resumeTaskSession(workspace, taskId);
  for (const args of [["get"], ["resume"], ["host-control", "--result", "probe", "--tools", "read_thread"]]) {
    const result = cli(args);
    expect(result.stdout).not.toContain(useId);
    expect(JSON.parse(result.stdout)).toMatchObject({ leaseStatus: "recoverable_own", nextAction: "recover_own_lease", businessGate: "connection_required" });
  }
  const recovered = cli(["resume", "--recover-own"]);
  expect(recovered.status).toBe(0);
  expect(JSON.parse(recovered.stdout)).toMatchObject({ ok: true, useId, leaseStatus: "own" });
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  expect(cli(["resume", "--recover-own", "--task-id", taskId], "").status).not.toBe(0);
  expect(cli(["resume", "--recover-own", "--use-id", useId]).status).not.toBe(0);
  expect(cli(["resume", "--recover-own", "--task-id", taskId], "other-task").status).not.toBe(0);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it("source workspace pending can recover through CLI without migrating or changing the message", async () => {
  const { useId } = await resumeTaskSession(workspace, taskId);
  const messageId = newMessageId();
  await beginTaskSend(workspace, taskId, messageId, 0, { bootstrap: true, useId });
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  const result = cli(["resume", "--recover-own", "-w", root]);
  expect(JSON.parse(result.stdout)).toMatchObject({ useId, boundWorkspaceId: workspace, nextAction: "reconcile_source_pending", businessGate: "await_boot" });
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it("known own lease can enroll a legacy binding, and a released receipt cannot resurrect its useId", async () => {
  const { useId } = await resumeTaskSession(workspace, taskId);
  fs.unlinkSync(continuationFile(taskId));
  expect(sessionRecoveryGuidance("exact", current()).leaseStatus).toBe("ownership_unproven");
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  const blocked = cli(["resume", "--recover-own"]);
  expect(blocked.status).not.toBe(0);
  expect(JSON.parse(blocked.stdout)).toMatchObject({ ok: false, leaseStatus: "ownership_unproven", nextAction: "lease_ownership_unproven", businessGate: "connection_required" });
  expect(blocked.stdout).not.toContain(useId);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  await resumeTaskSession(workspace, taskId, useId);
  await finishTaskSession(workspace, taskId, useId);
  const next = await resumeTaskSession(workspace, taskId, undefined, true);
  expect(next.useId).not.toBe(useId);
});

it.each(["boundWorkspaceId", "conversationId", "generation", "assignmentEpoch", "useId"] as const)("rejects changed private identity %s with no ledger writes", async field => {
  await resumeTaskSession(workspace, taskId);
  const r = readContinuation(taskId)!;
  writeContinuation({ ...r, [field]: typeof r[field] === "number" ? Number(r[field]) + 1 : field === "boundWorkspaceId" ? "0123456789ab" : field === "useId" ? "c2c_use_00000000-0000-4000-8000-000000000000" : "wrong-chat" });
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  await expect(resumeTaskSession(workspace, taskId, undefined, true)).rejects.toThrow("LEASE_CONFLICT");
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it("rejects hard-linked or publicly readable continuation material", async () => {
  await resumeTaskSession(workspace, taskId);
  const file = continuationFile(taskId), link = file + ".linked";
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  fs.linkSync(file, link);
  await expect(resumeTaskSession(workspace, taskId, undefined, true)).rejects.toThrow("LEASE_CONTINUATION_INVALID");
  fs.unlinkSync(link);
  if (process.platform === "win32") {
    expect(spawnSync("icacls.exe", [file, "/grant", "*S-1-1-0:R"], { windowsHide: true }).status).toBe(0);
  } else fs.chmodSync(file, 0o644);
  await expect(resumeTaskSession(workspace, taskId, undefined, true)).rejects.toThrow("LEASE_CONTINUATION_INVALID");
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});
