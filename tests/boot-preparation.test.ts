import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, expect, it } from "vitest";
import {
  beginTaskSend,
  claimStandbyConversation,
  confirmTaskDelivery,
  confirmTaskReply,
  confirmTaskWorkspace,
  importStandbyConversation,
  newMessageId,
  recordTaskHostControl,
  readTaskSession,
  resumeTaskSession,
  sessionRecoveryGuidance,
  sessionLedgerFile,
  switchTaskWorkspace,
  type MigrationReadObservation,
} from "../src/session/state.js";
import { prepareTaskBoot } from "../src/session/boot.js";
import { bootMaterialFile } from "../src/session/boot-material.js";
import { createWorkspaceRouter, readWorkspaceRouter, resolveRouteCapability } from "../src/router/state.js";
import { cleanup, isolateStateDir, makeGitRepo, makeTmpDir } from "./helpers.js";

let stateRoot: string;
let sourceRoot: string;
let targetRoot: string;
let sourceWorkspace: string;
let targetWorkspace: string;
let evidence: MigrationReadObservation;
const taskId = "boot-preparation-task";
const tools = ["read_thread", "send_message_to_thread"];

async function establishMigration(): Promise<void> {
  const router = await createWorkspaceRouter(sourceRoot);
  sourceWorkspace = (await router.register(sourceRoot)).workspaceId;
  targetWorkspace = (await router.register(targetRoot)).workspaceId;
  await importStandbyConversation({
    conversationId: "boot-preparation-chat",
    projectId: "g-p-bootpreparation",
    markerText: "C2C_STANDBY_READY",
    markerMessageId: "boot-preparation-marker",
    markerRole: "user",
  });
  await claimStandbyConversation({
    workspaceId: sourceWorkspace,
    taskId,
    connectorName: "C2C",
    workspaceName: "source",
    branch: "main",
  });
  const sourceBoot = newMessageId();
  await beginTaskSend(sourceWorkspace, taskId, sourceBoot, 0, { bootstrap: true });
  await confirmTaskDelivery(sourceWorkspace, taskId, sourceBoot);
  await confirmTaskReply(sourceWorkspace, taskId, sourceBoot, "DONE");
  await confirmTaskWorkspace(sourceWorkspace, taskId, {
    workspaceId: sourceWorkspace,
    routeTaskId: taskId,
    workspaceName: "source",
    branch: "main",
  });

  const moved = await switchTaskWorkspace({
    taskId,
    fromWorkspaceId: sourceWorkspace,
    toWorkspaceId: targetWorkspace,
    expectedGeneration: 1,
    connectorName: "C2C",
    workspaceName: "target",
    branch: "main",
  });
  evidence = {
    taskId,
    conversationId: moved.conversationId,
    fromWorkspaceId: sourceWorkspace,
    toWorkspaceId: targetWorkspace,
    generation: moved.generation,
    assignmentEpoch: moved.migrationHandshake!.assignmentEpoch,
    iteration: 0,
    messageId: sourceBoot,
    state: "DONE",
    chatReadAt: new Date().toISOString(),
    chatStatus: "idle",
    readbackClean: true,
  };
  await recordTaskHostControl(targetWorkspace, taskId, { result: "probe", tools });
  await recordTaskHostControl(targetWorkspace, taskId, { result: "migration-read-ok", migrationObservation: evidence });
}

beforeEach(async () => {
  stateRoot = isolateStateDir();
  sourceRoot = makeTmpDir("boot-preparation-source");
  targetRoot = makeTmpDir("boot-preparation-target");
  makeGitRepo(sourceRoot);
  makeGitRepo(targetRoot);
  await establishMigration();
});

afterEach(() => {
  cleanup(stateRoot);
  cleanup(sourceRoot);
  cleanup(targetRoot);
});

it("prepares one private BOOT material record and never returns its route token", async () => {
  const prepared = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  expect(prepared).toMatchObject({
    taskId,
    workspaceId: targetWorkspace,
    generation: 2,
    sendAllowed: true,
    nextAction: "send_prepared_boot",
  });
  expect(fs.existsSync(prepared.messageFile)).toBe(true);
  const material = JSON.parse(fs.readFileSync(prepared.messageFile, "utf8")) as { token: string; body: string };
  expect(material.body).toContain(prepared.messageId);
  expect(JSON.stringify(prepared)).not.toContain(material.token);
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).not.toContain(material.token);

  const task = readTaskSession(targetWorkspace, taskId)!;
  expect(task.pendingMessageId).toBe(prepared.messageId);
  expect(task.bootPreparation).toMatchObject({
    messageId: prepared.messageId,
    generation: 2,
    assignmentEpoch: prepared.assignmentEpoch,
    stage: "reserved",
  });
  expect(readWorkspaceRouter()!.capabilities.filter(capability => !capability.revokedAt && capability.taskId === taskId)).toHaveLength(1);
});

it("uses shared recovery actions for fresh and interrupted BOOT preparation", async () => {
  expect(sessionRecoveryGuidance("exact", readTaskSession(targetWorkspace, taskId)).nextAction).toBe("prepare_boot_required");
  await expect(prepareTaskBoot({
    workspaceId: targetWorkspace,
    taskId,
    expectedGeneration: 2,
    faultAt: "after_material_written",
  })).rejects.toThrow("BOOT_PREPARATION_TEST_FAULT");
  expect(sessionRecoveryGuidance("exact", readTaskSession(targetWorkspace, taskId)).nextAction).toBe("resume_boot_preparation");
});

it("rejects a stale generation before it writes any BOOT preparation state", async () => {
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  await expect(prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 1 }))
    .rejects.toThrow("TASK_GENERATION_STALE");
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
  expect(readWorkspaceRouter()!.capabilities).toHaveLength(0);
});

it("recovers the same material and reservation after output is lost without authorizing a resend", async () => {
  const first = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  const recovered = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  expect(recovered).toMatchObject({
    preparationId: first.preparationId,
    messageId: first.messageId,
    iteration: first.iteration,
    messageFile: first.messageFile,
    sendAllowed: false,
    nextAction: "reconcile_boot_receipt",
  });
  expect(readWorkspaceRouter()!.capabilities.filter(capability => !capability.revokedAt && capability.taskId === taskId)).toHaveLength(1);
});

it("reuses the same BOOT after a proven not-invoked reservation and fresh migration evidence", async () => {
  const first = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  await recordTaskHostControl(targetWorkspace, taskId, { result: "not-invoked", messageId: first.messageId });
  await recordTaskHostControl(targetWorkspace, taskId, { result: "probe", tools });
  await recordTaskHostControl(targetWorkspace, taskId, {
    result: "migration-read-ok",
    migrationObservation: { ...evidence, chatReadAt: new Date().toISOString() },
  });
  const retried = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  expect(retried).toMatchObject({
    preparationId: first.preparationId,
    messageId: first.messageId,
    iteration: first.iteration,
    messageFile: first.messageFile,
    sendAllowed: true,
  });
});

it("recovers a material-write interruption with one preparation and one capability", async () => {
  await expect(prepareTaskBoot({
    workspaceId: targetWorkspace,
    taskId,
    expectedGeneration: 2,
    faultAt: "after_material_written",
  })).rejects.toThrow("BOOT_PREPARATION_TEST_FAULT");
  const afterFailure = readTaskSession(targetWorkspace, taskId)!;
  const recovered = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  expect(recovered.preparationId).toBe(afterFailure.bootPreparation!.id);
  expect(recovered.messageId).toBe(afterFailure.bootPreparation!.messageId);
  expect(readWorkspaceRouter()!.capabilities.filter(capability => !capability.revokedAt && capability.taskId === taskId)).toHaveLength(1);
});

it.each(["after_capability_registered", "after_attached", "before_output"] as const)("recovers %s without creating a second BOOT", async faultAt => {
  await expect(prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2, faultAt }))
    .rejects.toThrow("BOOT_PREPARATION_TEST_FAULT");
  const before = readTaskSession(targetWorkspace, taskId)!.bootPreparation!;
  const recovered = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  expect(recovered.preparationId).toBe(before.id);
  expect(recovered.messageId).toBe(before.messageId);
  expect(readWorkspaceRouter()!.capabilities.filter(capability => !capability.revokedAt && capability.taskId === taskId)).toHaveLength(1);
  if (faultAt === "after_attached" || faultAt === "before_output") {
    expect(recovered).toMatchObject({ sendAllowed: false, nextAction: "reconcile_boot_receipt" });
  } else {
    expect(recovered).toMatchObject({ sendAllowed: true, nextAction: "send_prepared_boot" });
  }
});

it("keeps a Router capability inert until the session transaction attaches it", async () => {
  await expect(prepareTaskBoot({
    workspaceId: targetWorkspace,
    taskId,
    expectedGeneration: 2,
    faultAt: "after_capability_registered",
  })).rejects.toThrow("BOOT_PREPARATION_TEST_FAULT");
  const task = readTaskSession(targetWorkspace, taskId)!;
  const raw = JSON.parse(fs.readFileSync(bootMaterialFile(task.bootPreparation!.id), "utf8")) as { token: string };
  await expect(resolveRouteCapability(raw.token)).rejects.toThrow("ROUTE_ACCESS_DENIED");

  const recovered = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  expect(recovered.sendAllowed).toBe(true);
  await expect(resolveRouteCapability(raw.token)).resolves.toMatchObject({ capability: { id: task.bootPreparation!.capabilityId } });
});

it("fences an interrupted preparation from workspace migration while allowing its own lease to resume it", async () => {
  await expect(prepareTaskBoot({
    workspaceId: targetWorkspace,
    taskId,
    expectedGeneration: 2,
    faultAt: "after_material_written",
  })).rejects.toThrow("BOOT_PREPARATION_TEST_FAULT");
  await expect(switchTaskWorkspace({
    taskId,
    fromWorkspaceId: targetWorkspace,
    toWorkspaceId: sourceWorkspace,
    expectedGeneration: 2,
    connectorName: "C2C",
    workspaceName: "source",
    branch: "main",
  })).rejects.toThrow("TASK_CHAT_BUSY");

  const leased = await resumeTaskSession(targetWorkspace, taskId);
  const recovered = await prepareTaskBoot({
    workspaceId: targetWorkspace,
    taskId,
    expectedGeneration: 2,
    useId: leased.useId,
  });
  expect(recovered.sendAllowed).toBe(true);
});

it("allows only one concurrent preparation to reserve the exact BOOT", async () => {
  const results = await Promise.allSettled([
    prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 }),
    prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 }),
  ]);
  const fulfilled = results.filter((item): item is PromiseFulfilledResult<Awaited<ReturnType<typeof prepareTaskBoot>>> => item.status === "fulfilled");
  expect(fulfilled).toHaveLength(1);
  expect(fulfilled[0].value.sendAllowed).toBe(true);
  const recovered = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  expect(recovered).toMatchObject({
    preparationId: fulfilled[0].value.preparationId,
    messageId: fulfilled[0].value.messageId,
    sendAllowed: false,
    nextAction: "reconcile_boot_receipt",
  });
  expect(readWorkspaceRouter()!.capabilities.filter(capability => !capability.revokedAt && capability.taskId === taskId)).toHaveLength(1);
});

it("exposes prepare-boot through the CLI without exposing its body or token, and rejects legacy bootstrap", () => {
  const cli = (...args: string[]) => spawnSync(process.execPath,
    ["--import", "tsx/esm", "src/cli/index.ts", "session", ...args, "-w", targetRoot, "--task-id", taskId, "--json"],
    { encoding: "utf8", windowsHide: true, env: { ...process.env, CODEX_THREAD_ID: "", C2C_INTERNAL_STATE_DIR: "test" } });
  const prepared = cli("prepare-boot", "--expected-generation", "2");
  expect(prepared.status, prepared.stderr).toBe(0);
  const payload = JSON.parse(prepared.stdout) as { messageFile: string; messageId: string; bodySha256: string; sendAllowed: boolean };
  expect(payload.sendAllowed).toBe(true);
  const material = JSON.parse(fs.readFileSync(payload.messageFile, "utf8")) as { token: string; body: string };
  expect(prepared.stdout).not.toContain(material.token);
  expect(prepared.stdout).not.toContain(material.body);
  const legacy = cli("begin-send", "--message-id", newMessageId(), "--iteration", "1", "--bootstrap");
  expect(legacy.status).not.toBe(0);
  expect(legacy.stdout + legacy.stderr).toContain("BOOT_PREPARE_REQUIRED");
});

it("rejects a corrupted private body without changing the binding", async () => {
  const prepared = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  await recordTaskHostControl(targetWorkspace, taskId, { result: "not-invoked", messageId: prepared.messageId });
  const before = fs.readFileSync(sessionLedgerFile(), "utf8");
  const material = JSON.parse(fs.readFileSync(prepared.messageFile, "utf8")) as { body: string };
  material.body = `${material.body}\nchanged`;
  fs.writeFileSync(prepared.messageFile, JSON.stringify(material));
  await expect(prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 })).rejects.toThrow("BOOT_MATERIAL_TAMPERED");
  expect(fs.readFileSync(sessionLedgerFile(), "utf8")).toBe(before);
});

it("finishes workspace confirmation and invalidates the old route while removing sensitive material", async () => {
  const prepared = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  const raw = JSON.parse(fs.readFileSync(prepared.messageFile, "utf8")) as { token: string };
  await confirmTaskDelivery(targetWorkspace, taskId, prepared.messageId);
  await confirmTaskReply(targetWorkspace, taskId, prepared.messageId, "DONE");
  await confirmTaskWorkspace(targetWorkspace, taskId, {
    workspaceId: targetWorkspace,
    routeTaskId: taskId,
    workspaceName: "target",
    branch: "main",
  });
  await expect(resolveRouteCapability(raw.token)).resolves.toMatchObject({ capability: { workspaceId: targetWorkspace, taskId } });
  // The production CLI invokes cleanup after confirmation; the retained metadata
  // lets a recovery invocation safely complete it.
  const settled = await prepareTaskBoot({ workspaceId: targetWorkspace, taskId, expectedGeneration: 2 });
  expect(settled.nextAction).toBe("boot_already_completed");
  expect(fs.existsSync(prepared.messageFile)).toBe(false);
});
