import { createRouteCapabilityDraft, registerBootRouteCapability, revokeSupersededTaskRoutes } from "../router/state.js";
import {
  activateTaskBootPreparation,
  beginTaskBootPreparation,
  markTaskBootMaterialCleared,
  readTaskSession,
  recordTaskBootCapabilityRegistered,
  recordTaskBootMaterial,
  type BootPreparation,
  type SavedTaskSession,
} from "./state.js";
import {
  bootMaterialDigest,
  bootMaterialFile,
  readBootMaterial,
  removeBootMaterial,
  writeBootMaterial,
  type BootMaterial,
} from "./boot-material.js";

export type BootPreparationFault =
  | "after_material_written"
  | "after_capability_registered"
  | "after_attached"
  | "before_output";

export interface PrepareTaskBootInput {
  workspaceId: string;
  taskId: string;
  expectedGeneration: number;
  useId?: string;
  /** Test-only deterministic interruption hook. It is not exposed by the CLI. */
  faultAt?: BootPreparationFault;
}

/** Deliberately token-free result suitable for normal JSON, logs, and errors. */
export interface PreparedBootMessage {
  taskId: string;
  workspaceId: string;
  conversationId: string;
  generation: number;
  assignmentEpoch: number;
  preparationId: string;
  messageId: string;
  iteration: number;
  messageFile: string;
  bodySha256: string | null;
  task: SavedTaskSession;
  sendAllowed: boolean;
  nextAction: "send_prepared_boot" | "reconcile_boot_receipt" | "boot_already_completed";
}

function throwFault(input: PrepareTaskBootInput, point: BootPreparationFault): void {
  if (input.faultAt === point) throw new Error(`BOOT_PREPARATION_TEST_FAULT:${point}`);
}

function renderBootMessage(input: {
  workspaceId: string;
  taskId: string;
  messageId: string;
  iteration: number;
  token: string;
}): string {
  const message = `[C2C]\nSTATE: BOOT\nTASK_ID: ${input.taskId}\nWORKSPACE_ID: ${input.workspaceId}\nITERATION: ${input.iteration}\nMESSAGE_ID: ${input.messageId}\nC2C_ROUTE_TOKEN: ${input.token}\n\nREQUEST: Use the C2C MCP workspace_info tool with this route token. Do not write.\nREPLY: Echo TASK_ID, WORKSPACE_ID, ITERATION, MESSAGE_ID; include workspace_info fields workspaceId, routeTaskId, workspaceName, branch; STATE: DONE.`;
  if (Buffer.byteLength(message, "utf8") > 1024) throw new Error("BOOT_MESSAGE_TOO_LARGE");
  return message;
}

function assertMaterialMatches(preparation: BootPreparation, material: BootMaterial): void {
  if (material.preparationId !== preparation.id || material.workspaceId !== preparation.workspaceId ||
    material.taskId !== preparation.taskId || material.conversationId !== preparation.conversationId ||
    material.generation !== preparation.generation || material.assignmentEpoch !== preparation.assignmentEpoch ||
    material.messageId !== preparation.messageId || material.iteration !== preparation.iteration ||
    (preparation.capabilityId !== undefined && material.capabilityId !== preparation.capabilityId) ||
    (preparation.bodySha256 !== undefined && material.bodySha256 !== preparation.bodySha256)) {
    throw new Error("BOOT_MATERIAL_CONFLICT");
  }
}

function result(
  task: SavedTaskSession,
  preparation: BootPreparation,
  messageFile: string,
  sendAllowed: boolean,
  nextAction: PreparedBootMessage["nextAction"],
): PreparedBootMessage {
  return {
    taskId: task.taskId,
    workspaceId: preparation.workspaceId,
    conversationId: task.conversationId,
    generation: task.generation,
    assignmentEpoch: preparation.assignmentEpoch,
    preparationId: preparation.id,
    messageId: preparation.messageId,
    iteration: preparation.iteration,
    messageFile,
    bodySha256: preparation.bodySha256 ?? null,
    task,
    sendAllowed,
    nextAction,
  };
}

/**
 * The recoverable BOOT state machine. It intentionally spans session state,
 * private material and Router registration as staged commits: no stage claims
 * that separate state files are one atomic filesystem transaction.
 */
export async function prepareTaskBoot(input: PrepareTaskBootInput): Promise<PreparedBootMessage> {
  const started = await beginTaskBootPreparation(input.workspaceId, input.taskId, input.expectedGeneration, input.useId);
  let preparation = started.preparation;
  const messageFile = bootMaterialFile(preparation.id);

  if (preparation.stage === "completed") {
    if (!preparation.materialClearedAt) {
      removeBootMaterial(messageFile);
      const task = await markTaskBootMaterialCleared(input.workspaceId, input.taskId, preparation.id);
      preparation = task.bootPreparation!;
      return result(task, preparation, messageFile, false, "boot_already_completed");
    }
    return result(started.task, preparation, messageFile, false, "boot_already_completed");
  }

  let material: BootMaterial;
  try {
    material = readBootMaterial(messageFile);
    assertMaterialMatches(preparation, material);
  } catch (error) {
    if ((error as Error).message !== "BOOT_MATERIAL_MISSING") throw error;
    if (preparation.bodySha256 !== undefined || preparation.capabilityId !== undefined) {
      throw new Error("BOOT_MATERIAL_MISSING: prepared token material cannot be recreated safely");
    }
    const capability = createRouteCapabilityDraft();
    const body = renderBootMessage({
      workspaceId: preparation.workspaceId,
      taskId: preparation.taskId,
      messageId: preparation.messageId,
      iteration: preparation.iteration,
      token: capability.token,
    });
    material = {
      version: 1,
      preparationId: preparation.id,
      workspaceId: preparation.workspaceId,
      taskId: preparation.taskId,
      conversationId: preparation.conversationId,
      generation: preparation.generation,
      assignmentEpoch: preparation.assignmentEpoch,
      capabilityId: capability.id,
      token: capability.token,
      messageId: preparation.messageId,
      iteration: preparation.iteration,
      body,
      bodySha256: bootMaterialDigest(body),
      createdAt: new Date().toISOString(),
    };
    writeBootMaterial(material);
  }

  let task = await recordTaskBootMaterial(input.workspaceId, input.taskId, {
    preparationId: preparation.id,
    capabilityId: material.capabilityId,
    bodySha256: material.bodySha256,
    materialFile: preparation.materialFile,
    useId: input.useId,
  });
  preparation = task.bootPreparation!;
  throwFault(input, "after_material_written");

  // A pending reservation was produced by an earlier invocation. The body is
  // recoverable, but delivery is unknown, so this invocation never sends it.
  if (started.pending || (task.pendingMessageId === preparation.messageId && preparation.stage === "reserved")) {
    return result(task, preparation, messageFile, false, "reconcile_boot_receipt");
  }
  if (preparation.stage === "reserved") throw new Error("BOOT_SEND_UNRESOLVED");

  await registerBootRouteCapability({
    id: material.capabilityId,
    token: material.token,
    workspaceId: material.workspaceId,
    taskId: material.taskId,
    conversationId: material.conversationId,
    preparationId: material.preparationId,
  });
  task = await recordTaskBootCapabilityRegistered(input.workspaceId, input.taskId, preparation.id, input.useId);
  preparation = task.bootPreparation!;
  throwFault(input, "after_capability_registered");

  const activated = await activateTaskBootPreparation(
    input.workspaceId,
    input.taskId,
    preparation.id,
    input.expectedGeneration,
    input.useId,
  );
  task = activated.task;
  preparation = activated.preparation;
  if (activated.pending) return result(task, preparation, messageFile, false, "reconcile_boot_receipt");
  throwFault(input, "after_attached");

  await revokeSupersededTaskRoutes({
    taskId: task.taskId,
    conversationId: task.conversationId,
    keepCapabilityId: preparation.capabilityId!,
  });
  throwFault(input, "before_output");
  return result(task, preparation, messageFile, true, "send_prepared_boot");
}

/** Best-effort post-confirmation cleanup. A failure leaves completed metadata for retry. */
export async function cleanupCompletedTaskBoot(workspaceId: string, taskId: string): Promise<boolean> {
  const task = readTaskSession(workspaceId, taskId);
  const preparation = task?.bootPreparation;
  if (!task || !preparation || preparation.stage !== "completed" || preparation.materialClearedAt) return false;
  const file = bootMaterialFile(preparation.id);
  removeBootMaterial(file);
  await markTaskBootMaterialCleared(workspaceId, taskId, preparation.id);
  return true;
}
