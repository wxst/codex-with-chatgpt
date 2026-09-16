import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";

export type VerificationState = "pending" | "ready";
export type SettingsSource = "pending" | "user_confirmed";
export type BindingState = "bound" | "quarantined" | "unavailable";
export type BootstrapCreationState = "idle" | "dispatching" | "pending" | "created";
export type SettingsDialogState = "pending" | "confirmed" | "later";
export type ChannelState = "ready" | "sending" | "delivered" | "awaiting_reply" | "degraded";
export type DeliveryFailureKind = "host_rejected" | "conversation_gone" | "identity_mismatch";
export type BusinessMessageKind = "init" | "executed";
export type MemoryInitializationStatus = "ready" | "degraded";

export interface HostControlState {
  status: "tools_missing" | "readback_required" | "migration_boot_ready" | "ready" | "call_timeout" | "call_failed" | "not_invoked";
  missingTools: string[];
  checkedAt: string;
}

export interface HostControlObservation {
  result: "migration-read-ok" | "probe" | "read-ok" | "timeout" | "call-failed" | "not-invoked";
  migrationObservation?: MigrationReadObservation;
  tools?: string[];
  conversationId?: string;
  observedTaskId?: string;
  observedWorkspaceId?: string;
  messageId?: string;
}

export interface MigrationHandshake {
  id: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  taskId: string;
  conversationId: string;
  fromGeneration: number;
  toGeneration: number;
  assignmentEpoch: number;
  receipt: { iteration: number; messageId: string | null; state: string | null; reviewHead?: string };
  bootMessageId?: string;
  completedAt?: string;
}

export interface MigrationReadObservation {
  taskId: string;
  conversationId: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  generation: number;
  assignmentEpoch: number;
  iteration: number;
  messageId: string | null;
  state: string | null;
  reviewHead?: string;
  chatReadAt: string;
  chatStatus: "idle";
  readbackClean: true;
  useId?: string;
}

export interface LegacySavedSession {
  url?: string;
  title?: string;
  taskId?: string;
  iteration?: number;
  lastState?: string;
  savedAt?: string;
  conversationMode?: "long-chat" | "project";
  projectUrl?: string;
  connectorName?: string;
}

export interface ReplacedConversation {
  generation: number;
  conversationId: string;
  url: string;
  replacedAt: string;
  reason: string;
}

export interface SavedTaskSession {
  taskId: string;
  generation: number;
  provisionId: string;
  bindingCodeDigest: string;
  bindingState: BindingState;
  conversationId: string;
  url: string;
  title?: string;
  iteration: number;
  lastState?: string;
  connectorName: string;
  workspaceName?: string;
  branch?: string | null;
  model: string | null;
  thinkingLevel: "xhigh" | null;
  proMode: boolean;
  settingsSource: SettingsSource;
  settingsDialogState: SettingsDialogState;
  settingsConfirmedAt?: string;
  verificationState: VerificationState;
  channelState: ChannelState;
  hostControl?: HostControlState;
  migrationHandshake?: MigrationHandshake;
  pendingMessageId?: string;
  pendingIteration?: number;
  /** Sticky until this message is resolved; a timed-out call may have sent it. */
  pendingDispatchUncertain?: boolean;
  pendingReviewHead?: string;
  /** Metadata for a generated business INIT/EXECUTED; BOOT and legacy messages omit it. */
  pendingMessageKind?: BusinessMessageKind;
  /** SHA-256 of a generated INIT body. The body itself is never stored in the ledger. */
  pendingMessageDigest?: string;
  pendingMemoryProject?: string;
  lastReviewHead?: string;
  /** The direct host accepted the outbound request, but ChatGPT has not yet exposed its user turn. */
  sendAcceptedAt?: string;
  /** The first readback check that found the accepted message still absent. */
  deliveryPendingSince?: string;
  lastDeliveredMessageId?: string;
  lastDeliveryError?: string;
  lastDeliveryCheckedAt?: string;
  replacedConversations: ReplacedConversation[];
  replacementReason?: string;
  consecutiveReadFailures: number;
  /** Global standby-pool entry that permanently owns this conversation. */
  poolEntryId?: string;
  /** Public id only. The route token itself is never persisted here. */
  routeCapabilityId?: string;
  /** An active coordinator lease prevents this Chat from being reclaimed. */
  activeUse?: { useId: string; startedAt: string };
  /** A mem initialization belongs to exactly one binding generation. */
  memoryInitialization?: {
    generation: number;
    project: string;
    status: MemoryInitializationStatus;
    sources: string[];
    reason?: string;
    checkedAt: string;
  };
  lastReadError?: string;
  lastReadCheckedAt?: string;
  savedAt: string;
}

export interface BootstrapProvision {
  taskId: string;
  generation: number;
  provisionId: string;
  bindingCodeDigest: string;
  bindingState: "provisioning";
  creationState: BootstrapCreationState;
  receiptMessageId: string;
  initialMessageId?: string;
  clientThreadId?: string;
  serverConversationId?: string;
  selectedModel?: string;
  proMode?: boolean;
  allowPro: boolean;
  creationAcceptedAt?: string;
  seenConversationIds: string[];
  replacementReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionRegistry {
  version: 3;
  workspaceId: string;
  projectUrl?: string;
  connectorName?: string;
  tasks: SavedTaskSession[];
  provisions: BootstrapProvision[];
  savedAt: string;
}

export interface SessionReadResult {
  registry: SessionRegistry;
  legacyDetected: boolean;
}

export interface BeginSendOptions {
  probe?: boolean;
  bootstrap?: boolean;
  reviewHead?: string;
  expectedGeneration?: number;
  useId?: string;
  messageKind?: BusinessMessageKind;
  messageDigest?: string;
  memoryProject?: string;
}

export interface InitMessageInput {
  goal: string;
  constraints: string;
  successCriteria: string;
  repository: { provider: "github" | "gitea" | "other"; name: string; branch: string };
  localState: string;
  memoryProject: string;
}

export interface PreparedInitMessage {
  task: SavedTaskSession;
  messageId: string;
  iteration: number;
  message: string;
  messageDigest: string;
}

export interface MemoryReplyObservation {
  project: string;
  status: MemoryInitializationStatus;
  sources: string[];
  reason?: string;
}

export interface ReceiptIdentity {
  messageId: string;
  taskId: string;
  workspaceId: string;
  iteration: number;
}

/** Exact structured fields observed from the routed workspace_info tool. */
export interface WorkspaceConfirmationObservation {
  workspaceId: string;
  routeTaskId?: string;
  workspaceName: string;
  branch: string | null;
}

export interface ResolvedTaskId {
  taskId: string;
  source: "CODEX_THREAD_ID" | "explicit" | "generated";
  generated: boolean;
}

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WORKSPACE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;
const MESSAGE_ID_PATTERN = /^c2c_msg_[0-9a-f-]{36}$/u;
const PROVISION_ID_PATTERN = /^c2c_provision_[0-9a-f-]{36}$/u;
const SESSION_REGISTRY_LOCK_ID = "session-registry-global";
const STANDBY_MARKER = "C2C_STANDBY_READY";
const STANDBY_PRO_MARKER = "C2C_STANDBY_READY_PRO";
const PROJECT_ID_PATTERN = /^g-p-[A-Za-z0-9]+$/u;

/** Coordinator protocol timing; Codex App's read_thread endpoint has no timeout option. */
export const FAST_DELIVERY_READBACK_WINDOW_MS = 60_000;
export const FAST_DELIVERY_READBACK_INTERVAL_MS = 5_000;
export const ACTIVE_DELIVERY_READBACK_WINDOW_MS = 5 * 60_000;

export type DeliveryReadbackPhase = "none" | "fast" | "active" | "deferred";

export type MigrationRecoveryAction =
  | "restore_host_tools_then_read_bound_chat"
  | "migration_preflight_required"
  | "begin_boot_with_expected_generation"
  | "migration_boot_readback_required"
  | "migration_workspace_confirmation_required";

/**
 * A read-only recovery instruction for an incomplete workspace migration.
 * This describes the one safe next coordinator action; it never authorizes a
 * resend, a replacement Chat, or a generation change.
 */
export interface MigrationRecoveryGuidance {
  nextAction: MigrationRecoveryAction;
  recoveryReason: string;
  leaseActive: boolean;
}

/**
 * Classify receipt polling without mutating a task. The coordinator owns the
 * actual reads; this keeps its 60-second and five-minute boundaries stable and
 * independently testable.
 */
export function deliveryReadbackPhase(
  task: Pick<SavedTaskSession, "channelState" | "sendAcceptedAt">,
  nowMs = Date.now()
): DeliveryReadbackPhase {
  if (task.channelState !== "sending" || !task.sendAcceptedAt) return "none";
  const acceptedAt = Date.parse(task.sendAcceptedAt);
  if (!Number.isFinite(acceptedAt)) return "active";
  const elapsedMs = Math.max(0, nowMs - acceptedAt);
  if (elapsedMs < FAST_DELIVERY_READBACK_WINDOW_MS) return "fast";
  if (elapsedMs < ACTIVE_DELIVERY_READBACK_WINDOW_MS) return "active";
  return "deferred";
}

/**
 * Distinguish source-receipt preflight from an already completed destination
 * BOOT. In particular, an old migration receipt without REVIEW_HEAD is valid:
 * once the destination BOOT has a matching DONE receipt, only workspace_info
 * and confirm-workspace can complete the handshake.
 */
export function migrationRecoveryGuidance(
  task: Pick<SavedTaskSession,
    "bindingState" | "verificationState" | "migrationHandshake" | "hostControl" |
    "pendingMessageId" | "pendingDispatchUncertain" | "sendAcceptedAt" |
    "deliveryPendingSince" | "lastDeliveredMessageId" | "lastState" | "activeUse">
): MigrationRecoveryGuidance | null {
  const migration = task.migrationHandshake;
  if (!migration || migration.completedAt || task.bindingState !== "bound" || task.verificationState !== "pending") {
    return null;
  }

  const leaseActive = task.activeUse !== undefined;
  if (task.hostControl?.status === "tools_missing") {
    return {
      nextAction: "restore_host_tools_then_read_bound_chat",
      recoveryReason: "host read/send tools are unavailable; restore them before migration readback",
      leaseActive,
    };
  }
  if (!migration.bootMessageId) {
    if (task.hostControl?.status === "migration_boot_ready") {
      return {
        nextAction: "begin_boot_with_expected_generation",
        recoveryReason: "migration preflight is current and no destination BOOT is reserved",
        leaseActive,
      };
    }
    return {
      nextAction: "migration_preflight_required",
      recoveryReason: "incomplete migration needs fresh source receipt and host preflight",
      leaseActive,
    };
  }

  const bootReceiptComplete = !task.pendingMessageId && !task.pendingDispatchUncertain &&
    !task.sendAcceptedAt && !task.deliveryPendingSince &&
    task.lastDeliveredMessageId === migration.bootMessageId && task.lastState === "DONE";
  if (!bootReceiptComplete) {
    return {
      nextAction: "migration_boot_readback_required",
      recoveryReason: "destination BOOT lacks a completed matching receipt; read the exact in-flight message",
      leaseActive,
    };
  }
  return {
    nextAction: "migration_workspace_confirmation_required",
    recoveryReason: "destination BOOT is complete; read target workspace_info then confirm-workspace",
    leaseActive,
  };
}

export type StandbyMarker = typeof STANDBY_MARKER | typeof STANDBY_PRO_MARKER;
export type StandbyConversationStatus = "available" | "claimed" | "retired" | "quarantined";

export interface StandbyConversation {
  id: string;
  conversationId: string;
  projectId: string;
  marker: StandbyMarker;
  markerMessageId: string;
  createdAt: string;
  importedAt: string;
  status: StandbyConversationStatus;
  claimedAt?: string;
  claimedBy?: { workspaceId: string; taskId: string; generation: number };
  retiredAt?: string;
  reason?: string;
  /** Activity time is distinct from import/claim time for deterministic LRU reuse. */
  lastUsedAt?: string;
  assignmentEpoch?: number;
}

export interface StandbyPool {
  version: 1;
  projectId: string | null;
  entries: StandbyConversation[];
  savedAt: string;
}

/**
 * The sole durable owner index for ordinary ChatGPT conversations.
 *
 * Legacy per-workspace files remain readable only as migration input. Every
 * mutating session operation writes this one document, so a pool lease and its
 * task binding always become visible together.
 */
export interface SessionLedger {
  version: 1;
  pool: StandbyPool;
  registries: SessionRegistry[];
  /** Audit-only snapshots; never participate in current conversation ownership. */
  assignmentHistory?: AssignmentHistoryEntry[];
  savedAt: string;
}

export interface AssignmentHistoryEntry {
  conversationId: string;
  fromWorkspaceId: string;
  taskId: string;
  generation: number;
  recordedAt: string;
  reason: "workspace_switch" | "pool_reclaimed" | "binding_recovered";
  toWorkspaceId?: string;
  toTaskId?: string;
  toConversationId?: string;
  assignmentEpoch?: number;
  /** Audit snapshot retains receipts after the previous current owner is removed. */
  snapshot?: SavedTaskSession;
}

export type TaskBindingResolution = "exact" | "workspace_switch_required" | "unbound" | "ambiguous";
export interface TaskBindingResult {
  resolution: TaskBindingResolution;
  requestedWorkspaceId: string;
  boundWorkspaceId: string | null;
  task: SavedTaskSession | null;
  candidates: Array<{ workspaceId: string; task: SavedTaskSession }>;
}

export interface SwitchTaskWorkspaceOptions {
  taskId: string;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  expectedGeneration: number;
  connectorName: string;
  workspaceName: string;
  branch: string | null;
}

const USE_ID_PATTERN = /^c2c_use_[0-9a-f-]{36}$/u;

export interface ImportStandbyConversationOptions {
  conversationId: string;
  projectId: string;
  /** Exact text read from the user turn. This is intentionally not inferred. */
  markerText: string;
  markerMessageId: string;
  markerRole: "user" | "assistant";
  createdAt?: string;
}

export interface ClaimStandbyConversationOptions {
  workspaceId: string;
  taskId: string;
  connectorName: string;
  workspaceName: string;
  branch: string | null;
  userExplicitPro?: boolean;
  reclaimObservations?: ReclaimObservation[];
  recoveryObservation?: BoundRecoveryObservation;
}

export interface BoundRecoveryObservation {
  taskId: string;
  workspaceId: string;
  conversationId: string;
  generation: number;
  useId?: string;
  failureCheckedAt: string;
  routingCheckedAt: string;
  chatReadAt: string;
  observedAt: string;
  hostRoutingChecked: true;
  routingMode: "conversation_id_only";
  chatStatus: "idle";
  readbackClean: true;
  receiptIteration: number;
  receiptMessageId: string | null;
  receiptState: string | null;
  receiptReviewHead?: string;
  reason: "host_rejected";
}

interface ReclaimObservationIdentity {
  conversationId: string;
  workspaceId: string;
  taskId: string;
  generation: number;
  assignmentEpoch: number;
  observedAt: string;
  chatStatus: "idle";
  readbackClean: true;
}

/** The original explicit-idle observation remains supported for existing callers. */
export interface IdleReclaimObservation extends ReclaimObservationIdentity {
  taskStatus: "idle";
}

/**
 * A `read_thread` notLoaded result is reclaimable only with a same-host
 * inactive snapshot, a completed unchanged turn, and a clean exact Chat
 * receipt. These fields are host evidence; the ledger still rechecks local
 * ownership, leases, pending state, and the registered receipt while locked.
 */
export interface NotLoadedReclaimObservation extends ReclaimObservationIdentity {
  taskStatus: "notLoaded";
  taskReadTaskId: string;
  snapshotTaskId: string;
  recheckTaskId: string;
  taskReadLatestTurnId: string;
  taskReadLatestTurnStatus: "completed";
  taskReadHostId: string;
  snapshotHostId: string;
  snapshotStatus: "inactiveStatus";
  latestTurnId: string;
  latestTurnStatus: "completed";
  taskReadAt: string;
  snapshotReadAt: string;
  chatReadAt: string;
  recheckHostId: string;
  recheckSnapshotStatus: "inactiveStatus";
  recheckLatestTurnId: string;
  recheckLatestTurnStatus: "completed";
  recheckReadAt: string;
  receiptIteration: number;
  receiptMessageId: string;
  receiptState: string;
  receiptReviewHead?: string;
}

export type ReclaimObservation = IdleReclaimObservation | NotLoadedReclaimObservation;

export interface StandbyClaimResult {
  task: SavedTaskSession;
  entry: StandbyConversation;
  reused: boolean;
}

export function newTaskId(): string {
  return `c2c_task_${randomUUID()}`;
}

export function newMessageId(): string {
  return `c2c_msg_${randomUUID()}`;
}

export function newProvisionId(): string {
  return `c2c_provision_${randomUUID()}`;
}

/**
 * ChatGPT's renderer can preserve Markdown escapes in a plain user turn. Keep
 * the stored marker canonical while accepting only the two complete spellings
 * that the user can create in the ordinary Chat composer.
 */
export function parseStandbyMarkerText(text: string): StandbyMarker | null {
  if (text === STANDBY_MARKER || text === "C2C\\_STANDBY\\_READY") return STANDBY_MARKER;
  if (text === STANDBY_PRO_MARKER || text === "C2C\\_STANDBY\\_READY\\_PRO") return STANDBY_PRO_MARKER;
  return null;
}

export function resolveCodexTaskId(
  explicitTaskId?: string,
  env: Record<string, string | undefined> = process.env
): ResolvedTaskId {
  const hostTaskId = env.CODEX_THREAD_ID?.trim();
  const explicit = explicitTaskId?.trim();
  if (hostTaskId) {
    const host = validateTaskId(hostTaskId);
    if (explicit && validateTaskId(explicit) !== host) {
      throw new Error("TASK_ID_IDENTITY_MISMATCH: explicit task id conflicts with CODEX_THREAD_ID");
    }
    return { taskId: host, source: "CODEX_THREAD_ID", generated: false };
  }
  if (explicit) {
    return { taskId: validateTaskId(explicit), source: "explicit", generated: false };
  }
  return { taskId: newTaskId(), source: "generated", generated: true };
}

export function validateTaskId(taskId: string): string {
  const normalized = taskId.trim();
  if (!TASK_ID_PATTERN.test(normalized) || normalized === "__proto__" || normalized === "constructor") {
    throw new Error("task id must be 1-128 safe identifier characters");
  }
  return normalized;
}

function validateWorkspaceId(workspaceId: string): string {
  const normalized = workspaceId.trim();
  if (!WORKSPACE_ID_PATTERN.test(normalized)) throw new Error("workspace id must be a safe identifier");
  return normalized;
}

function validateConversationId(conversationId: string): string {
  const normalized = conversationId.trim();
  if (!CONVERSATION_ID_PATTERN.test(normalized)) throw new Error("conversation id is invalid");
  return normalized;
}

function validateProvisionId(provisionId: string): string {
  const normalized = provisionId.trim().toLowerCase();
  if (!PROVISION_ID_PATTERN.test(normalized)) throw new Error("provision id must be c2c_provision_<uuid>");
  return normalized;
}

export function validateMessageId(messageId: string): string {
  const normalized = messageId.trim().toLowerCase();
  if (!MESSAGE_ID_PATTERN.test(normalized)) throw new Error("message id must be c2c_msg_<uuid>");
  return normalized;
}

export function bindingCodeFor(workspaceId: string, taskId: string, provisionId: string): string {
  const workspace = validateWorkspaceId(workspaceId);
  const task = validateTaskId(taskId);
  const provision = validateProvisionId(provisionId);
  return `C2C_BIND_${workspace}_${task}_${provision.slice("c2c_provision_".length)}`;
}

export function bindingCodeDigest(bindingCode: string): string {
  return createHash("sha256").update(bindingCode, "utf8").digest("hex");
}

/** Digest the exact UTF-8 body read from or sent to the bound Chat. */
export function digestBusinessMessage(message: string): string {
  if (typeof message !== "string") throw new Error("C2C_MESSAGE_INVALID");
  return createHash("sha256").update(message, "utf8").digest("hex");
}

function compactInitField(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== "string") throw new Error(`C2C_INIT_${field.toUpperCase()}_REQUIRED`);
  const normalized = value.replace(/[\r\n\t]+/gu, " ").replace(/\s{2,}/gu, " ").trim();
  if (!normalized) throw new Error(`C2C_INIT_${field.toUpperCase()}_REQUIRED`);
  if (normalized.length > maxLength) throw new Error(`C2C_INIT_${field.toUpperCase()}_TOO_LONG`);
  return normalized;
}

export function validateInitMessageInput(input: unknown): InitMessageInput {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("C2C_INIT_INPUT_INVALID");
  const value = input as Partial<InitMessageInput>;
  if (!value.repository || typeof value.repository !== "object" || Array.isArray(value.repository)) {
    throw new Error("C2C_INIT_REPOSITORY_REQUIRED");
  }
  const repository = value.repository as Partial<InitMessageInput["repository"]>;
  if (repository.provider !== "github" && repository.provider !== "gitea" && repository.provider !== "other") {
    throw new Error("C2C_INIT_REPOSITORY_PROVIDER_INVALID");
  }
  return {
    goal: compactInitField(value.goal, "goal", 260),
    constraints: compactInitField(value.constraints, "constraints", 260),
    successCriteria: compactInitField(value.successCriteria, "success_criteria", 220),
    repository: {
      provider: repository.provider,
      name: compactInitField(repository.name, "repository_name", 160),
      branch: compactInitField(repository.branch, "repository_branch", 120),
    },
    localState: compactInitField(value.localState, "local_state", 120),
    memoryProject: compactInitField(value.memoryProject, "memory_project", 120),
  };
}

function renderInitMessage(workspaceId: string, taskId: string, messageId: string, iteration: number, input: InitMessageInput, reviewHead?: string): string {
  const review = reviewHead ? `\nREVIEW_HEAD: ${reviewHead}` : "";
  const message = `[C2C]\nSTATE: INIT\nTASK_ID: ${taskId}\nWORKSPACE_ID: ${workspaceId}\nITERATION: ${iteration}\nMESSAGE_ID: ${messageId}\n\nGOAL: ${input.goal}\nCONSTRAINTS: ${input.constraints}\nSUCCESS_CRITERIA: ${input.successCriteria}\nREPOSITORY: ${input.repository.provider} ${input.repository.name} ${input.repository.branch}\nLOCAL_STATE: ${input.localState}\nMEMORY_PROJECT: ${input.memoryProject}${review}\nMEM: First call memory_start_task(task=GOAL+CONSTRAINTS+SUCCESS_CRITERIA, project=MEMORY_PROJECT, detail=standard, intent=start, mode=hybrid, includeProjectContext=true). Then memory_search for needed history/docs; for Gitea read-only codewiki_*/gitea_*. No memory_write_summary, Gitea, or other writes. C2C local source wins.\n\nREPLY: Echo 4 IDs; STATE: PLAN; MEMORY_PROJECT; MEMORY_STATUS READY|DEGRADED; MEMORY_SOURCES; MEMORY_REASON if DEGRADED; SOURCE_EVIDENCE, ACTIONS, TESTS, SUCCESS_CRITERIA.`;
  if (Buffer.byteLength(message, "utf8") > 1024) throw new Error("C2C_INIT_MESSAGE_TOO_LARGE");
  return message;
}

function validateMemorySources(sources: string[]): string[] {
  if (!Array.isArray(sources)) throw new Error("MEMORY_SOURCES_REQUIRED");
  const normalized = [...new Set(sources.map(source => compactInitField(source, "source", 80)))];
  if (normalized.length === 0 || normalized.length > 12) throw new Error("MEMORY_SOURCES_INVALID");
  return normalized;
}

function validateMemoryReplyObservation(observation: MemoryReplyObservation | undefined, task: SavedTaskSession): MemoryReplyObservation {
  if (!observation) throw new Error("MEMORY_REPLY_OBSERVATION_REQUIRED");
  const project = compactInitField(observation.project, "project", 120);
  if (project !== task.pendingMemoryProject) throw new Error("MEMORY_PROJECT_MISMATCH");
  if (observation.status !== "ready" && observation.status !== "degraded") throw new Error("MEMORY_STATUS_INVALID");
  const sources = validateMemorySources(observation.sources);
  const reason = observation.reason === undefined ? undefined : compactInitField(observation.reason, "reason", 500);
  if (observation.status === "ready" && !sources.includes("memory_start_task")) {
    throw new Error("MEMORY_START_TASK_EVIDENCE_REQUIRED");
  }
  if (observation.status === "degraded" && !reason) throw new Error("MEMORY_DEGRADED_REASON_REQUIRED");
  if (observation.status === "ready" && reason !== undefined) throw new Error("MEMORY_READY_REASON_FORBIDDEN");
  return { project, status: observation.status, sources, reason };
}

function migratedReceiptMessageId(provisionId: string): string {
  const hex = createHash("sha256").update(`${provisionId}:receipt`, "utf8").digest("hex");
  return `c2c_msg_${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function assertReceiptIdentity(expected: ReceiptIdentity, observed: ReceiptIdentity): void {
  if (
    validateMessageId(observed.messageId) !== validateMessageId(expected.messageId) ||
    validateTaskId(observed.taskId) !== validateTaskId(expected.taskId) ||
    observed.workspaceId !== expected.workspaceId ||
    observed.iteration !== expected.iteration
  ) {
    throw new Error("observed ChatGPT receipt identity does not match the pending message");
  }
}

export function sessionFile(workspaceId: string): string {
  return path.join(getStateDir(), "sessions", `${validateWorkspaceId(workspaceId)}.json`);
}

export function sessionLedgerFile(): string {
  return path.join(getStateDir(), "sessions", "assignment-ledger.json");
}

function standbyPoolFile(): string {
  return path.join(getStateDir(), "sessions", "standby-pool.json");
}

function validateProjectId(projectId: string): string {
  const normalized = projectId.trim();
  if (!PROJECT_ID_PATTERN.test(normalized)) throw new Error("ChatGPT Project id is invalid");
  return normalized;
}

function emptyStandbyPool(): StandbyPool {
  return { version: 1, projectId: null, entries: [], savedAt: new Date().toISOString() };
}

function isStandbyPool(value: unknown): value is StandbyPool {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<StandbyPool>;
  return candidate.version === 1 && (candidate.projectId === null || typeof candidate.projectId === "string") &&
    Array.isArray(candidate.entries);
}

export function readStandbyPool(): StandbyPool {
  return readSessionLedger().pool;
}

function writeStandbyPool(pool: StandbyPool): StandbyPool {
  const ledger = readSessionLedger();
  writeSessionLedger({ ...ledger, pool: normalizeStandbyPool(pool), savedAt: new Date().toISOString() });
  return pool;
}

export function normalizeProjectUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") return null;
    const match = parsed.pathname.match(/^\/g\/(g-p-[a-zA-Z0-9]+)\/project\/?$/u);
    if (!match) return null;
    return `https://chatgpt.com/g/${match[1]}/project`;
  } catch {
    return null;
  }
}

export function projectIdFromUrl(url: string): string | null {
  const normalized = normalizeProjectUrl(url);
  if (!normalized) return null;
  return normalized.match(/\/g\/(g-p-[a-zA-Z0-9]+)\/project/u)?.[1] ?? null;
}

export function normalizeChatUrl(url: string): string | null {
  try {
    const parsed = new URL(url.trim());
    if (parsed.hostname !== "chatgpt.com" && parsed.hostname !== "www.chatgpt.com") return null;
    const match = parsed.pathname.match(/^\/(?:g\/(g-p-[A-Za-z0-9]+)\/)?c\/([A-Za-z0-9_-]{3,128})\/?$/u);
    if (!match) return null;
    const prefix = match[1] ? `g/${match[1]}/` : "";
    return `https://chatgpt.com/${prefix}c/${match[2]}`;
  } catch {
    return null;
  }
}

export function canonicalChatUrl(conversationId: string, projectUrlInput?: string): string {
  const id = validateConversationId(conversationId);
  if (!projectUrlInput) return `https://chatgpt.com/c/${id}`;
  const projectUrl = normalizeProjectUrl(projectUrlInput);
  if (!projectUrl) throw new Error("project URL must look like https://chatgpt.com/g/g-p-…/project");
  const projectId = projectIdFromUrl(projectUrl);
  if (!projectId) throw new Error("project URL does not contain a ChatGPT Project id");
  return `https://chatgpt.com/g/${projectId}/c/${id}`;
}

function emptyRegistry(workspaceId: string): SessionRegistry {
  return {
    version: 3,
    workspaceId: validateWorkspaceId(workspaceId),
    tasks: [],
    provisions: [],
    savedAt: new Date().toISOString(),
  };
}

function isRegistry(value: unknown): value is SessionRegistry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SessionRegistry>;
  return candidate.version === 3 && Array.isArray(candidate.tasks) && Array.isArray(candidate.provisions);
}

function normalizeRegistry(registry: SessionRegistry): SessionRegistry {
  for (const task of registry.tasks) {
    const m = task.migrationHandshake;
    if (m !== undefined && (!m || typeof m !== "object" || typeof m.id !== "string" || !m.id.startsWith("c2c_migration_") ||
      m.taskId !== task.taskId || m.conversationId !== task.conversationId || m.toWorkspaceId !== registry.workspaceId ||
      !Number.isSafeInteger(m.fromGeneration) || m.fromGeneration < 1 || m.toGeneration !== task.generation ||
      m.fromGeneration >= m.toGeneration || !Number.isSafeInteger(m.assignmentEpoch) || m.assignmentEpoch < 1 ||
      typeof m.fromWorkspaceId !== "string" || !m.fromWorkspaceId || !m.receipt ||
      !Number.isSafeInteger(m.receipt.iteration) || m.receipt.iteration < 0 ||
      (m.receipt.messageId !== null && (typeof m.receipt.messageId !== "string" || !m.receipt.messageId)) ||
      (m.receipt.state !== null && !["DONE", "PLAN", "BLOCKED", "ERROR"].includes(m.receipt.state)) ||
      ((m.receipt.messageId === null) !== (m.receipt.state === null)) ||
      (m.receipt.reviewHead !== undefined && (typeof m.receipt.reviewHead !== "string" || !/^[0-9a-f]{40}$/u.test(m.receipt.reviewHead))) ||
      (m.bootMessageId !== undefined && typeof m.bootMessageId !== "string") ||
      (m.completedAt !== undefined && !isValidReclaimTimestamp(m.completedAt)))) throw new Error("MIGRATION_STATE_INVALID");
    const host = task.hostControl;
    if (host !== undefined && (!host || typeof host !== "object" ||
      !["tools_missing", "readback_required", "migration_boot_ready", "ready", "call_timeout", "call_failed", "not_invoked"].includes(host.status) ||
      !Array.isArray(host.missingTools) || host.missingTools.some(x => !["read_thread", "send_message_to_thread"].includes(x)) ||
      new Set(host.missingTools).size !== host.missingTools.length ||
      (host.status === "tools_missing" && host.missingTools.length === 0) ||
      (["ready", "migration_boot_ready", "readback_required"].includes(host.status) && host.missingTools.length !== 0) ||
      typeof host.checkedAt !== "string" || !Number.isFinite(Date.parse(host.checkedAt)))) {
      throw new Error("HOST_CONTROL_STATE_INVALID");
    }
    if ((task.pendingDispatchUncertain !== undefined && typeof task.pendingDispatchUncertain !== "boolean") ||
      [task.pendingReviewHead, task.lastReviewHead].some(head => head !== undefined &&
        (typeof head !== "string" || !/^[0-9a-f]{40}$/u.test(head)))) {
      throw new Error("HOST_CONTROL_STATE_INVALID");
    }
    if (task.pendingMessageKind !== undefined && task.pendingMessageKind !== "init" && task.pendingMessageKind !== "executed") {
      throw new Error("BUSINESS_MESSAGE_STATE_INVALID");
    }
    if (task.pendingMessageKind === "init") {
      if (!task.pendingMessageId || task.pendingIteration === undefined ||
        !/^[0-9a-f]{64}$/u.test(task.pendingMessageDigest ?? "")) {
        throw new Error("C2C_INIT_PENDING_STATE_INVALID");
      }
      compactInitField(task.pendingMemoryProject, "memory_project", 120);
    } else if (task.pendingMessageDigest !== undefined || task.pendingMemoryProject !== undefined) {
      throw new Error("C2C_INIT_PENDING_STATE_INVALID");
    }
    const memory = task.memoryInitialization;
    if (memory !== undefined) {
      if (!memory || !Number.isSafeInteger(memory.generation) || memory.generation !== task.generation ||
        (memory.status !== "ready" && memory.status !== "degraded") ||
        typeof memory.checkedAt !== "string" || !Number.isFinite(Date.parse(memory.checkedAt))) {
        throw new Error("MEMORY_INITIALIZATION_STATE_INVALID");
      }
      compactInitField(memory.project, "memory_project", 120);
      validateMemorySources(memory.sources);
      const reason = memory.reason === undefined ? undefined : compactInitField(memory.reason, "reason", 500);
      if ((memory.status === "ready" && (!memory.sources.includes("memory_start_task") || reason !== undefined)) ||
        (memory.status === "degraded" && !reason)) {
        throw new Error("MEMORY_INITIALIZATION_STATE_INVALID");
      }
    }
    if (task.activeUse !== undefined &&
      (!task.activeUse || !USE_ID_PATTERN.test(task.activeUse.useId) ||
        !Number.isFinite(Date.parse(task.activeUse.startedAt)))) {
      throw new Error("TASK_USE_STATE_INVALID");
    }
  }
  return {
    ...registry,
    tasks: registry.tasks.map((task) => ({
      ...task,
      model: task.model ?? null,
      thinkingLevel: task.settingsSource === "user_confirmed" ? "xhigh" : null,
      settingsSource: task.settingsSource === "user_confirmed" ? "user_confirmed" : "pending",
      settingsDialogState: task.settingsSource === "user_confirmed"
        ? "confirmed"
        : (task.settingsDialogState === "later" ? "later" : "pending"),
      replacedConversations: task.replacedConversations ?? [],
      consecutiveReadFailures: task.consecutiveReadFailures ?? 0,
      channelState: task.channelState ?? "ready",
    })),
    provisions: registry.provisions.map((provision) => {
      const legacy = provision as BootstrapProvision & { dialogState?: unknown };
      const { dialogState: _discardedDialogState, ...base } = legacy;
      const migratedReceipt = !provision.receiptMessageId &&
        Boolean(provision.initialMessageId && MESSAGE_ID_PATTERN.test(provision.initialMessageId));
      return {
        ...base,
        creationState: provision.creationState === "dispatching" || provision.creationState === "pending" || provision.creationState === "created"
          ? provision.creationState
          : "idle",
        receiptMessageId: provision.receiptMessageId && MESSAGE_ID_PATTERN.test(provision.receiptMessageId)
          ? provision.receiptMessageId
          : migratedReceipt
            ? provision.initialMessageId!
            : migratedReceiptMessageId(provision.provisionId),
        initialMessageId: migratedReceipt ? undefined : provision.initialMessageId,
        allowPro: provision.allowPro === true,
        seenConversationIds: provision.seenConversationIds ?? [],
      };
    }),
  };
}

function normalizeStandbyPool(pool: StandbyPool): StandbyPool {
  return {
    ...pool,
    projectId: pool.projectId ?? null,
    entries: pool.entries.map((entry) => ({ ...entry, claimedBy: entry.claimedBy ? { ...entry.claimedBy } : undefined })),
  };
}

function emptySessionLedger(): SessionLedger {
  return {
    version: 1,
    pool: emptyStandbyPool(),
    registries: [],
    savedAt: new Date().toISOString(),
  };
}

function readJsonStrict(file: string, label: string): unknown | null {
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`SESSION_LEDGER_CORRUPT: ${label} is unreadable (${message})`);
  }
}

function isStandbyEntry(value: unknown): value is StandbyConversation {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<StandbyConversation>;
  return typeof entry.id === "string" && typeof entry.conversationId === "string" &&
    typeof entry.projectId === "string" && (entry.marker === STANDBY_MARKER || entry.marker === STANDBY_PRO_MARKER) &&
    typeof entry.markerMessageId === "string" && typeof entry.createdAt === "string" &&
    typeof entry.importedAt === "string" &&
    (entry.status === "available" || entry.status === "claimed" || entry.status === "retired" || entry.status === "quarantined") &&
    (entry.claimedBy === undefined || (
      typeof entry.claimedBy?.workspaceId === "string" && typeof entry.claimedBy.taskId === "string" &&
      typeof entry.claimedBy.generation === "number"
    ));
}

function isSessionLedger(value: unknown): value is SessionLedger {
  if (!value || typeof value !== "object") return false;
  const ledger = value as Partial<SessionLedger>;
  return ledger.version === 1 && isStandbyPool(ledger.pool) &&
    ledger.pool.entries.every(isStandbyEntry) &&
    Array.isArray(ledger.registries) && ledger.registries.every(isRegistry) &&
    typeof ledger.savedAt === "string";
}

function allLegacyRegistries(): SessionRegistry[] {
  const directory = path.join(getStateDir(), "sessions");
  let names: string[];
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const registries: SessionRegistry[] = [];
  for (const name of names) {
    if (!name.endsWith(".json") || name === "standby-pool.json" || name === "assignment-ledger.json" || name === "bootstrap-lease.json") continue;
    const raw = readJsonStrict(path.join(directory, name), `legacy session ${name}`);
    if (!isRegistry(raw)) continue;
    registries.push(normalizeRegistry(raw));
  }
  return registries;
}

function readLegacyPool(): StandbyPool {
  const raw = readJsonStrict(standbyPoolFile(), "legacy standby pool");
  if (raw === null) return emptyStandbyPool();
  if (!isStandbyPool(raw) || !raw.entries.every(isStandbyEntry)) {
    throw new Error("SESSION_LEDGER_CORRUPT: legacy standby pool has an invalid shape");
  }
  return normalizeStandbyPool(raw);
}

function hasLegacySessionState(): boolean {
  const directory = path.join(getStateDir(), "sessions");
  try {
    return fs.readdirSync(directory).some((name) =>
      name === "standby-pool.json" ||
      (name.endsWith(".json") && name !== "assignment-ledger.json" && name !== "bootstrap-lease.json")
    );
  } catch {
    return false;
  }
}

function assertLedgerIntegrity(ledger: SessionLedger): void {
  const workspaceIds = new Set<string>();
  const owners = new Map<string, string>();
  const poolByConversation = new Map<string, StandbyConversation>();
  const poolById = new Map<string, StandbyConversation>();

  for (const entry of ledger.pool.entries) {
    validateConversationId(entry.conversationId);
    if (poolByConversation.has(entry.conversationId) || poolById.has(entry.id)) {
      throw new Error("SESSION_LEDGER_CONFLICT: duplicate standby conversation ownership");
    }
    poolByConversation.set(entry.conversationId, entry);
    poolById.set(entry.id, entry);
  }

  for (const rawRegistry of ledger.registries) {
    const registry = normalizeRegistry(rawRegistry);
    const workspaceId = validateWorkspaceId(registry.workspaceId);
    if (workspaceIds.has(workspaceId)) {
      throw new Error("SESSION_LEDGER_CONFLICT: duplicate workspace registry");
    }
    workspaceIds.add(workspaceId);
    const taskIds = new Set<string>();
    for (const task of registry.tasks) {
      const taskId = validateTaskId(task.taskId);
      if (taskIds.has(taskId)) throw new Error("SESSION_LEDGER_CONFLICT: duplicate task binding");
      taskIds.add(taskId);
      const owner = `${workspaceId}:${taskId}`;
      for (const conversationId of allConversationIds(task)) {
        validateConversationId(conversationId);
        const prior = owners.get(conversationId);
        if (prior && prior !== owner) {
          throw new Error("SESSION_LEDGER_CONFLICT: a Chat has multiple task owners");
        }
        owners.set(conversationId, owner);
      }
      if (task.bindingState === "bound") {
        const poolEntry = task.poolEntryId ? poolById.get(task.poolEntryId) : undefined;
        if (!poolEntry || poolEntry.conversationId !== task.conversationId || poolEntry.status !== "claimed" ||
          poolEntry.claimedBy?.workspaceId !== workspaceId || poolEntry.claimedBy.taskId !== taskId ||
          poolEntry.claimedBy.generation !== task.generation) {
          throw new Error("SESSION_LEDGER_CONFLICT: bound task and standby owner disagree");
        }
      }
      if (task.bindingState === "quarantined") {
        const poolEntry = task.poolEntryId ? poolById.get(task.poolEntryId) : undefined;
        if (!poolEntry || poolEntry.conversationId !== task.conversationId || poolEntry.status !== "quarantined" ||
          poolEntry.claimedBy?.workspaceId !== workspaceId || poolEntry.claimedBy.taskId !== taskId ||
          poolEntry.claimedBy.generation !== task.generation) {
          throw new Error("SESSION_LEDGER_CONFLICT: quarantined task and standby owner disagree");
        }
      }
    }
  }

  for (const entry of ledger.pool.entries) {
    if (entry.status === "available" && owners.has(entry.conversationId)) {
      throw new Error("SESSION_LEDGER_CONFLICT: available Chat already has an owner");
    }
    if (entry.status === "claimed" && !owners.has(entry.conversationId)) {
      throw new Error("SESSION_LEDGER_CONFLICT: claimed Chat has no task owner");
    }
  }
}

function normalizeSessionLedger(ledger: SessionLedger): SessionLedger {
  const normalized: SessionLedger = {
    ...ledger,
    pool: normalizeStandbyPool(ledger.pool),
    registries: ledger.registries.map(normalizeRegistry),
    assignmentHistory: ledger.assignmentHistory ?? [],
  };
  assertLedgerIntegrity(normalized);
  return normalized;
}

function readSessionLedger(): SessionLedger {
  const raw = readJsonStrict(sessionLedgerFile(), "assignment ledger");
  if (raw !== null) {
    if (!isSessionLedger(raw)) throw new Error("SESSION_LEDGER_CORRUPT: assignment ledger has an invalid shape");
    return normalizeSessionLedger(raw);
  }
  return normalizeSessionLedger({
    ...emptySessionLedger(),
    pool: readLegacyPool(),
    registries: allLegacyRegistries(),
  });
}

function backupLegacySessionState(): void {
  if (fs.existsSync(sessionLedgerFile()) || !hasLegacySessionState()) return;
  const directory = path.join(getStateDir(), "sessions");
  const backup = path.join(directory, `legacy-backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
  fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
  for (const name of fs.readdirSync(directory)) {
    if (!name.endsWith(".json") || name === "assignment-ledger.json") continue;
    fs.copyFileSync(path.join(directory, name), path.join(backup, name));
  }
}

function writeSessionLedger(ledger: SessionLedger): SessionLedger {
  const normalized = normalizeSessionLedger({ ...ledger, savedAt: new Date().toISOString() });
  backupLegacySessionState();
  writeSecureJson(sessionLedgerFile(), normalized);
  return normalized;
}

export async function migrateSessionLedger(): Promise<{ migrated: boolean; ledger: SessionLedger }> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const migrated = !fs.existsSync(sessionLedgerFile());
    const ledger = readSessionLedger();
    return { migrated, ledger: migrated ? writeSessionLedger(ledger) : ledger };
  });
}

function registryFromLedger(ledger: SessionLedger, workspaceId: string): SessionRegistry {
  return ledger.registries.find((entry) => entry.workspaceId === workspaceId) ?? emptyRegistry(workspaceId);
}

export function readSessionRegistry(workspaceId: string): SessionReadResult {
  const id = validateWorkspaceId(workspaceId);
  const ledger = readSessionLedger();
  const registry = ledger.registries.find((entry) => entry.workspaceId === id);
  if (registry) return { registry: normalizeRegistry(registry), legacyDetected: false };
  const raw = readJsonIfExists<unknown>(sessionFile(id));
  return { registry: emptyRegistry(id), legacyDetected: raw !== null };
}

export function writeSessionRegistry(registry: SessionRegistry): SessionRegistry {
  if (registry.version !== 3) throw new Error("session registry version must be 3");
  const normalized = normalizeRegistry(registry);
  const ledger = readSessionLedger();
  writeSessionLedger({
    ...ledger,
    registries: [...ledger.registries.filter((entry) => entry.workspaceId !== normalized.workspaceId), normalized],
  });
  return normalized;
}

function allConversationIds(task: SavedTaskSession): string[] {
  return task.bindingState === "bound" || task.bindingState === "quarantined" ? [task.conversationId] : [];
}

function findConversationOwner(conversationId: string): { workspaceId: string; taskId: string } | null {
  for (const registry of readSessionLedger().registries) {
    const task = registry.tasks.find((entry) => allConversationIds(entry).includes(conversationId));
    if (task) return { workspaceId: registry.workspaceId, taskId: task.taskId };
    const provision = registry.provisions.find((entry) => entry.serverConversationId === conversationId);
    if (provision) return { workspaceId: registry.workspaceId, taskId: provision.taskId };
  }
  return null;
}

function validMarkerMessageId(messageId: string): string {
  const normalized = messageId.trim();
  if (normalized.length < 3 || normalized.length > 200) throw new Error("standby marker message id is invalid");
  return normalized;
}

function validTimestamp(value: string | undefined, field: string): string {
  const normalized = value?.trim() || new Date().toISOString();
  if (!Number.isFinite(Date.parse(normalized))) throw new Error(`${field} is invalid`);
  return new Date(normalized).toISOString();
}

/**
 * Add a manually prepared ordinary Chat to the global pool. The caller must
 * have read the Chat through Codex App and verified that the complete raw
 * marker is a user message in the one configured Project before calling this
 * function.
 */
export async function importStandbyConversation(
  input: ImportStandbyConversationOptions
): Promise<StandbyConversation> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const conversationId = validateConversationId(input.conversationId);
    const projectId = validateProjectId(input.projectId);
    const marker = parseStandbyMarkerText(input.markerText);
    if (!marker) throw new Error("standby marker must be an exact raw user marker");
    if (input.markerRole !== "user") throw new Error("standby marker must be in a user message");
    const markerMessageId = validMarkerMessageId(input.markerMessageId);
    const pool = readStandbyPool();
    if (pool.projectId && pool.projectId !== projectId) {
      throw new Error("standby conversation belongs to another ChatGPT Project");
    }
    if (pool.entries.some((entry) => entry.conversationId === conversationId)) {
      throw new Error("standby conversation already exists in the pool");
    }
    if (pool.entries.filter((entry) => entry.status !== "retired").length >= 10) {
      throw new Error("POOL_CAPACITY_REACHED: the fixed Chat pool already has 10 live entries");
    }
    const owner = findConversationOwner(conversationId);
    if (owner) throw new Error("standby conversation is already owned by a workspace task");
    const now = new Date().toISOString();
    const entry: StandbyConversation = {
      id: `c2c_standby_${randomUUID()}`,
      conversationId,
      projectId,
      marker,
      markerMessageId,
      createdAt: validTimestamp(input.createdAt, "standby conversation creation time"),
      importedAt: now,
      status: "available",
    };
    writeStandbyPool({
      version: 1,
      projectId: pool.projectId ?? projectId,
      entries: [...pool.entries, entry],
      savedAt: now,
    });
    return entry;
  });
}

function makeStandbyTask(input: {
  workspaceId: string;
  taskId: string;
  entry: StandbyConversation;
  connectorName: string;
  workspaceName: string;
  branch: string | null;
  prior?: SavedTaskSession;
  now: string;
}): SavedTaskSession {
  const projectUrl = `https://chatgpt.com/g/${input.entry.projectId}/project`;
  const generation = (input.prior?.generation ?? 0) + 1;
  const provisionId = newProvisionId();
  return {
    taskId: input.taskId,
    generation,
    provisionId,
    bindingCodeDigest: bindingCodeDigest(bindingCodeFor(input.workspaceId, input.taskId, provisionId)),
    bindingState: "bound",
    conversationId: input.entry.conversationId,
    url: canonicalChatUrl(input.entry.conversationId, projectUrl),
    iteration: input.prior?.iteration ?? 0,
    lastState: input.prior?.lastState,
    connectorName: input.connectorName,
    workspaceName: input.workspaceName,
    branch: input.branch,
    model: null,
    thinkingLevel: "xhigh",
    proMode: input.entry.marker === STANDBY_PRO_MARKER,
    settingsSource: "user_confirmed",
    settingsDialogState: "confirmed",
    settingsConfirmedAt: input.now,
    verificationState: "pending",
    channelState: "ready",
    replacedConversations: input.prior?.replacedConversations ?? [],
    replacementReason: input.prior?.replacementReason,
    consecutiveReadFailures: 0,
    poolEntryId: input.entry.id,
    savedAt: input.now,
  };
}

function currentConversationOwner(ledger: SessionLedger, conversationId: string): { workspaceId: string; task: SavedTaskSession } | null {
  for (const registry of ledger.registries) {
    const task = registry.tasks.find(candidate => candidate.bindingState === "bound" && candidate.conversationId === conversationId);
    if (task) return { workspaceId: registry.workspaceId, task };
  }
  return null;
}

function observationAllowsReclaim(
  entry: StandbyConversation,
  owner: { workspaceId: string; task: SavedTaskSession },
  observations: ReclaimObservation[],
  nowMs: number,
): boolean {
  const observation = observations.find(item => item.conversationId === entry.conversationId);
  if (!observation || observation.workspaceId !== owner.workspaceId || observation.taskId !== owner.task.taskId ||
    observation.generation !== owner.task.generation || observation.assignmentEpoch !== (entry.assignmentEpoch ?? 0) ||
    observation.chatStatus !== "idle" || observation.readbackClean !== true || !isFreshReclaimTimestamp(observation.observedAt, nowMs)) return false;
  if (observation.taskStatus === "idle") return true;
  return observation.taskReadHostId === observation.snapshotHostId &&
    observation.snapshotHostId === observation.recheckHostId &&
    observation.snapshotStatus === "inactiveStatus" && observation.recheckSnapshotStatus === "inactiveStatus" &&
    observation.latestTurnStatus === "completed" && observation.recheckLatestTurnStatus === "completed" &&
    observation.latestTurnId === observation.recheckLatestTurnId &&
    observation.receiptIteration === owner.task.iteration &&
    observation.receiptMessageId === owner.task.lastDeliveredMessageId &&
    observation.receiptState === owner.task.lastState &&
    observation.receiptReviewHead === owner.task.lastReviewHead &&
    [observation.taskReadAt, observation.snapshotReadAt, observation.chatReadAt, observation.recheckReadAt]
      .every(timestamp => isFreshReclaimTimestamp(timestamp, nowMs)) &&
    Date.parse(observation.taskReadAt) <= Date.parse(observation.snapshotReadAt) &&
    Date.parse(observation.snapshotReadAt) <= Date.parse(observation.chatReadAt) &&
    Date.parse(observation.chatReadAt) <= Date.parse(observation.recheckReadAt) &&
    Date.parse(observation.recheckReadAt) <= Date.parse(observation.observedAt);
}

function isExactNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && value.length > 0;
}

function isValidReclaimTimestamp(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function isFreshReclaimTimestamp(value: string, nowMs: number): boolean {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) && timestamp <= nowMs && nowMs - timestamp <= 60_000;
}

function hasValidReclaimIdentity(item: Record<string, unknown>): boolean {
  return [item.conversationId, item.workspaceId, item.taskId].every(isExactNonEmptyString) &&
    Number.isSafeInteger(item.generation) && (item.generation as number) >= 1 &&
    Number.isSafeInteger(item.assignmentEpoch) && (item.assignmentEpoch as number) >= 0 &&
    isValidReclaimTimestamp(item.observedAt) && item.chatStatus === "idle" && item.readbackClean === true;
}

function isValidNotLoadedObservation(item: Record<string, unknown>): boolean {
  return item.taskStatus === "notLoaded" &&
    item.taskReadTaskId === item.taskId && item.snapshotTaskId === item.taskId && item.recheckTaskId === item.taskId &&
    item.taskReadLatestTurnId === item.latestTurnId && item.taskReadLatestTurnStatus === "completed" &&
    [item.taskReadHostId, item.snapshotHostId, item.recheckHostId, item.latestTurnId,
      item.recheckLatestTurnId, item.receiptMessageId, item.receiptState].every(isExactNonEmptyString) &&
    item.taskReadHostId === item.snapshotHostId && item.snapshotHostId === item.recheckHostId &&
    item.snapshotStatus === "inactiveStatus" && item.recheckSnapshotStatus === "inactiveStatus" &&
    item.latestTurnStatus === "completed" && item.recheckLatestTurnStatus === "completed" &&
    item.latestTurnId === item.recheckLatestTurnId &&
    [item.taskReadAt, item.snapshotReadAt, item.chatReadAt, item.recheckReadAt].every(isValidReclaimTimestamp) &&
    Number.isSafeInteger(item.receiptIteration) && (item.receiptIteration as number) >= 0 &&
    (item.receiptReviewHead === undefined || isExactNonEmptyString(item.receiptReviewHead));
}

export function validateReclaimObservations(value: unknown): ReclaimObservation[] {
  if (!Array.isArray(value)) throw new Error("RECLAIM_OBSERVATIONS_INVALID: expected an array");
  const seen = new Set<string>();
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("RECLAIM_OBSERVATIONS_INVALID: use complete unique observations from exact host readback");
    }
    const observation = item as Record<string, unknown>;
    const validStatus = observation.taskStatus === "idle" || isValidNotLoadedObservation(observation);
    if (!hasValidReclaimIdentity(observation) || !validStatus || seen.has(observation.conversationId as string)) {
      throw new Error("RECLAIM_OBSERVATIONS_INVALID: use complete unique idle or notLoaded observations from exact host readback");
    }
    seen.add(observation.conversationId as string);
  }
  return value as ReclaimObservation[];
}

export function validateBoundRecoveryObservation(value: unknown): BoundRecoveryObservation {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("RECOVERY_OBSERVATION_INVALID: expected exact bound Chat evidence");
  const item = value as Record<string, unknown>;
  if (![item.taskId, item.workspaceId, item.conversationId].every(isExactNonEmptyString) ||
    !Number.isSafeInteger(item.generation) || (item.generation as number) < 1 ||
    (item.useId !== undefined && (typeof item.useId !== "string" || !USE_ID_PATTERN.test(item.useId))) ||
    ![item.failureCheckedAt, item.routingCheckedAt, item.chatReadAt, item.observedAt].every(isValidReclaimTimestamp) ||
    item.hostRoutingChecked !== true || item.routingMode !== "conversation_id_only" ||
    item.chatStatus !== "idle" || item.readbackClean !== true || item.reason !== "host_rejected" ||
    !Number.isSafeInteger(item.receiptIteration) || (item.receiptIteration as number) < 0 ||
    !(item.receiptMessageId === null || isExactNonEmptyString(item.receiptMessageId)) ||
    !(item.receiptState === null || isExactNonEmptyString(item.receiptState)) ||
    ((item.receiptMessageId === null) !== (item.receiptState === null)) ||
    (item.receiptReviewHead !== undefined && !isExactNonEmptyString(item.receiptReviewHead))) {
    throw new Error("RECOVERY_OBSERVATION_INVALID: verify host routing and read the exact idle Chat after explicit rejection");
  }
  return value as BoundRecoveryObservation;
}

function assertBoundRecovery(task: SavedTaskSession | undefined, workspaceId: string, observation: BoundRecoveryObservation): void {
  if (!task || task.bindingState !== "bound" || task.taskId !== observation.taskId || workspaceId !== observation.workspaceId ||
    task.conversationId !== observation.conversationId || task.generation !== observation.generation ||
    task.lastDeliveryCheckedAt !== observation.failureCheckedAt) throw new Error("RECOVERY_BINDING_CHANGED: reread the current binding and terminal failure");
  if (task.pendingMessageId || task.pendingIteration !== undefined || task.pendingDispatchUncertain || task.sendAcceptedAt ||
    task.deliveryPendingSince || task.activeUse?.useId !== observation.useId) {
    throw new Error("TASK_CHAT_BUSY: resolve the original receipt or other coordinator lease before recovery");
  }
  if (task.channelState !== "degraded" || !task.lastDeliveryError?.startsWith("host_rejected:")) {
    throw new Error("RECOVERY_NOT_REQUIRED: reuse the healthy binding; uncertain sends and read failures cannot authorize rotation");
  }
  if (observation.receiptIteration !== task.iteration || observation.receiptMessageId !== (task.lastDeliveredMessageId ?? null) ||
    observation.receiptState !== (task.lastState ?? null) || observation.receiptReviewHead !== task.lastReviewHead) {
    throw new Error("RECOVERY_BINDING_CHANGED: reread the exact Chat; completed receipt no longer matches the ledger");
  }
  const times = [observation.routingCheckedAt, observation.failureCheckedAt, observation.chatReadAt, observation.observedAt];
  if (!times.every(time => isFreshReclaimTimestamp(time, Date.now()))) {
    throw new Error("RECLAIM_OBSERVATION_EXPIRED: refresh all host reads once before retrying");
  }
  if (times.some((time, index) => index > 0 && Date.parse(times[index - 1]) > Date.parse(time))) {
    throw new Error("RECOVERY_OBSERVATION_INVALID: verify routing before a new rejection, then read the exact Chat");
  }
}

function reclaimExclusion(ledger: SessionLedger, entry: StandbyConversation, marker: StandbyMarker): string | null {
  if (entry.marker !== marker) return "marker_mismatch";
  if (entry.status !== "claimed") return entry.status;
  const owner = currentConversationOwner(ledger, entry.conversationId);
  if (!owner || entry.claimedBy?.workspaceId !== owner.workspaceId ||
    entry.claimedBy?.taskId !== owner.task.taskId || entry.claimedBy?.generation !== owner.task.generation) return "owner_mismatch";
  if (owner.task.verificationState !== "ready") return "verification_pending";
  if (owner.task.activeUse) return "active_lease";
  if (taskIsBusy(owner.task)) return "pending_or_degraded";
  if (!owner.task.lastDeliveredMessageId || !owner.task.lastState) return "receipt_missing";
  return null;
}

function reclaimOrder(left: StandbyConversation, right: StandbyConversation): number {
  return (left.lastUsedAt ?? left.claimedAt ?? left.importedAt).localeCompare(right.lastUsedAt ?? right.claimedAt ?? right.importedAt) ||
    left.conversationId.localeCompare(right.conversationId);
}

/** Local eligibility only: callers must still read both exact host surfaces. */
export function readReclaimCandidates(pro = false) {
  const ledger = readSessionLedger();
  const marker = pro ? STANDBY_PRO_MARKER : STANDBY_MARKER;
  const rows = [...ledger.pool.entries].sort(reclaimOrder).map(entry => {
    const owner = currentConversationOwner(ledger, entry.conversationId);
    return { conversationId: entry.conversationId, workspaceId: owner?.workspaceId,
      taskId: owner?.task.taskId, generation: owner?.task.generation, assignmentEpoch: entry.assignmentEpoch ?? 0,
      lastUsedAt: entry.lastUsedAt ?? entry.claimedAt ?? entry.importedAt,
      iteration: owner?.task.iteration, lastDeliveredMessageId: owner?.task.lastDeliveredMessageId,
      lastState: owner?.task.lastState, lastReviewHead: owner?.task.lastReviewHead,
      exclusionReason: reclaimExclusion(ledger, entry, marker) };
  });
  return { ok: true, hostObservationRequired: true,
    candidates: rows.filter(row => row.exclusionReason === null),
    excluded: rows.filter(row => row.exclusionReason !== null) };
}

function reclaimableCandidate(
  ledger: SessionLedger,
  marker: StandbyMarker,
  observations: ReclaimObservation[] | undefined,
  nowMs: number,
): { entry: StandbyConversation; owner: { workspaceId: string; task: SavedTaskSession } } | null {
  if (!observations) return null;
  const candidates = ledger.pool.entries.flatMap(entry => {
    if (reclaimExclusion(ledger, entry, marker)) return [];
    const owner = currentConversationOwner(ledger, entry.conversationId)!;
    return observationAllowsReclaim(entry, owner, observations, nowMs) ? [{ entry, owner }] : [];
  });
  return candidates.sort((left, right) => reclaimOrder(left.entry, right.entry))[0] ?? null;
}

/**
 * Atomically use an unclaimed Chat, or reclaim one only after fresh exact idle
 * or fully corroborated notLoaded host evidence.
 */
export async function claimStandbyConversation(
  input: ClaimStandbyConversationOptions
): Promise<StandbyClaimResult> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const workspaceId = validateWorkspaceId(input.workspaceId);
    const taskId = validateTaskId(input.taskId);
    if (input.reclaimObservations !== undefined) validateReclaimObservations(input.reclaimObservations);
    if (input.recoveryObservation !== undefined) validateBoundRecoveryObservation(input.recoveryObservation);
    const connectorName = input.connectorName.trim();
    const workspaceName = input.workspaceName.trim();
    if (!connectorName || !workspaceName) throw new Error("standby claim requires connector and workspace names");
    const ledger = readSessionLedger();
    const resolution = resolveTaskBinding(workspaceId, taskId);
    if (resolution.resolution === "workspace_switch_required") throw new Error("TASK_WORKSPACE_SWITCH_REQUIRED");
    if (resolution.resolution === "ambiguous") throw new Error("TASK_BINDING_AMBIGUOUS");
    const registry = registryFromLedger(ledger, workspaceId);
    const existing = registry.tasks.find((entry) => entry.taskId === taskId);
    const pool = ledger.pool;
    if (input.recoveryObservation) assertBoundRecovery(existing, workspaceId, input.recoveryObservation);
    if (existing?.bindingState === "bound" && !input.recoveryObservation) {
      const entry = pool.entries.find((candidate) => candidate.conversationId === existing.conversationId);
      if (!entry) throw new Error("bound task conversation is missing from the standby pool");
      return { task: existing, entry, reused: true };
    }
    if (existing?.bindingState === "quarantined") {
      throw new Error("TASK_CHAT_QUARANTINED: retire the exact task Chat with session clear --confirm before replacement");
    }

    const desiredMarker: StandbyMarker = input.userExplicitPro ? STANDBY_PRO_MARKER : STANDBY_MARKER;
    let candidate = pool.entries
      .filter((entry) => entry.status === "available" && entry.marker === desiredMarker)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.importedAt.localeCompare(right.importedAt))[0];
    const now = new Date().toISOString();
    const reclaim = candidate ? null : reclaimableCandidate(ledger, desiredMarker, input.reclaimObservations, Date.parse(now));
    if (!candidate && !reclaim) {
      if (input.reclaimObservations?.length) {
        const observedCandidates = input.reclaimObservations.map(observation => {
          const entry = pool.entries.find(item => item.conversationId === observation.conversationId);
          const owner = entry && currentConversationOwner(ledger, entry.conversationId);
          return { observation, entry, owner };
        });
        if (observedCandidates.some(({ observation, entry, owner }) => !entry || !owner ||
          owner.workspaceId !== observation.workspaceId || owner.task.taskId !== observation.taskId ||
          owner.task.generation !== observation.generation || (entry.assignmentEpoch ?? 0) !== observation.assignmentEpoch ||
          (observation.taskStatus === "notLoaded" && (observation.receiptIteration !== owner.task.iteration ||
            observation.receiptMessageId !== owner.task.lastDeliveredMessageId || observation.receiptState !== owner.task.lastState ||
            observation.receiptReviewHead !== owner.task.lastReviewHead)))) {
          throw new Error("RECLAIM_CANDIDATE_CHANGED: reread session pool reclaim-candidates --json and continue with remaining candidates");
        }
        if (observedCandidates.some(({ observation }) =>
          [observation.observedAt, ...(observation.taskStatus === "notLoaded" ?
            [observation.taskReadAt, observation.snapshotReadAt, observation.chatReadAt, observation.recheckReadAt] : [])]
            .some(time => !isFreshReclaimTimestamp(time, Date.parse(now))))) {
          throw new Error("RECLAIM_OBSERVATION_EXPIRED: refresh every host read once; changing observedAt alone is insufficient");
        }
      }
      if (pool.entries.some(entry => reclaimExclusion(ledger, entry, desiredMarker) === null)) {
        throw new Error("POOL_OBSERVATION_REQUIRED: run session pool reclaim-candidates --json; read the exact owner task and Chat, then claim with --reclaim-observations-file using fresh idle or corroborated notLoaded evidence");
      }
      const hasCompatibleClaim = pool.entries.some(entry => entry.status === "claimed" && entry.marker === desiredMarker);
      throw new Error(hasCompatibleClaim ? "POOL_BUSY: local candidates are blocked; run session pool reclaim-candidates --json for exclusion reasons; do not force takeover" : "POOL_EXHAUSTED: no compatible standby Chat is available");
    }
    candidate = candidate ?? reclaim!.entry;
    const owner = currentConversationOwner(ledger, candidate.conversationId);
    if (owner && !reclaim) throw new Error("standby conversation is already owned by a workspace task");
    const task = makeStandbyTask({
      workspaceId,
      taskId,
      entry: candidate,
      connectorName,
      workspaceName,
      branch: input.branch,
      prior: existing,
      now,
    });
    if (input.recoveryObservation) task.activeUse = existing!.activeUse;
    const retiredPriorId = existing?.poolEntryId;
    const entries = pool.entries.map((entry) => {
      if (entry.id === candidate.id) {
        return {
          ...entry,
          status: "claimed" as const,
          claimedAt: now,
          claimedBy: { workspaceId, taskId, generation: task.generation },
          reason: undefined, lastUsedAt: now, assignmentEpoch: (entry.assignmentEpoch ?? 0) + 1,
        };
      }
      if (retiredPriorId && entry.id === retiredPriorId && entry.status === "claimed") {
        if (input.recoveryObservation) {
          // Keep the fixed inventory; unavailable routing is not proof of deletion.
          return { ...entry, status: "quarantined" as const, claimedBy: undefined,
            reason: "binding_recovered: host rejected the correctly routed send", assignmentEpoch: (entry.assignmentEpoch ?? 0) + 1 };
        }
        return { ...entry, status: "retired" as const, retiredAt: now, reason: existing?.replacementReason ?? "replaced" };
      }
      return entry;
    });
    const claimed = entries.find((entry) => entry.id === candidate.id)!;
    const nextRegistry: SessionRegistry = {
      ...registry,
      projectUrl: `https://chatgpt.com/g/${candidate.projectId}/project`,
      connectorName,
      tasks: [...registry.tasks.filter((entry) => entry.taskId !== taskId &&
        !(reclaim?.owner.workspaceId === workspaceId && entry.taskId === reclaim.owner.task.taskId)), task],
      // Legacy fake-creation provisions must not participate in standby allocation.
      provisions: registry.provisions.filter((entry) => entry.taskId !== taskId),
      savedAt: now,
    };
    const remainingRegistries = ledger.registries
      .filter((entry) => entry.workspaceId !== workspaceId && entry.workspaceId !== reclaim?.owner.workspaceId);
    const reclaimedRegistry = reclaim && reclaim.owner.workspaceId !== workspaceId ? {
      ...registryFromLedger(ledger, reclaim.owner.workspaceId),
      tasks: registryFromLedger(ledger, reclaim.owner.workspaceId).tasks.filter(task => task.taskId !== reclaim.owner.task.taskId),
      savedAt: now,
    } : null;
    writeSessionLedger({
      ...ledger,
      pool: { ...pool, entries, savedAt: now },
      registries: [...remainingRegistries, ...(reclaimedRegistry ? [reclaimedRegistry] : []), nextRegistry],
      assignmentHistory: [...(ledger.assignmentHistory ?? []),
        ...(reclaim ? [{ ...historyEntry(reclaim.owner.task, reclaim.owner.workspaceId, "pool_reclaimed", now),
          snapshot: reclaim.owner.task, toWorkspaceId: workspaceId, toTaskId: taskId,
          toConversationId: task.conversationId, assignmentEpoch: claimed.assignmentEpoch }] : []),
        ...(input.recoveryObservation && existing ? [{ ...historyEntry(existing, workspaceId, "binding_recovered", now),
          snapshot: existing, toWorkspaceId: workspaceId, toTaskId: taskId, toConversationId: task.conversationId,
          assignmentEpoch: claimed.assignmentEpoch }] : [])],
      savedAt: now,
    });
    return { task, entry: claimed, reused: false };
  });
}

export async function quarantineStandbyConversation(
  conversationIdInput: string,
  reasonInput: string
): Promise<StandbyConversation> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const conversationId = validateConversationId(conversationIdInput);
    const reason = reasonInput.trim().slice(0, 500);
    if (!reason) throw new Error("standby quarantine requires a reason");
    const ledger = readSessionLedger();
    const pool = ledger.pool;
    const current = pool.entries.find((entry) => entry.conversationId === conversationId);
    if (!current) throw new Error("standby conversation is not in the pool");
    const now = new Date().toISOString();
    const updated: StandbyConversation = { ...current, status: "quarantined", retiredAt: now, reason };
    const registries = ledger.registries.map((registry) => ({
      ...registry,
      tasks: registry.tasks.map((task) =>
        task.conversationId === conversationId && task.bindingState === "bound"
          ? quarantineTask(task, `quarantined: ${reason}`)
          : task
      ),
    }));
    writeSessionLedger({
      ...ledger,
      pool: { ...pool, entries: pool.entries.map((entry) => entry.id === current.id ? updated : entry), savedAt: now },
      registries,
      savedAt: now,
    });
    return updated;
  });
}

function retireClaimedStandbyEntryInLedger(
  ledger: SessionLedger,
  task: SavedTaskSession,
  reason: string
): SessionLedger {
  if (!task.poolEntryId) return ledger;
  const current = ledger.pool.entries.find((entry) => entry.id === task.poolEntryId);
  if (!current || current.status === "retired") return ledger;
  const now = new Date().toISOString();
  const updated: StandbyConversation = {
    ...current,
    status: "retired",
    retiredAt: now,
    reason: reason.slice(0, 500),
  };
  return {
    ...ledger,
    pool: {
      ...ledger.pool,
      entries: ledger.pool.entries.map((entry) => entry.id === updated.id ? updated : entry),
      savedAt: now,
    },
  };
}

function quarantineClaimedStandbyEntryInLedger(
  ledger: SessionLedger,
  task: SavedTaskSession,
  reason: string
): SessionLedger {
  if (!task.poolEntryId) return ledger;
  const current = ledger.pool.entries.find((entry) => entry.id === task.poolEntryId);
  if (!current || current.status === "quarantined") return ledger;
  const now = new Date().toISOString();
  const updated: StandbyConversation = {
    ...current,
    status: "quarantined",
    retiredAt: now,
    reason: reason.slice(0, 500),
  };
  return {
    ...ledger,
    pool: {
      ...ledger.pool,
      entries: ledger.pool.entries.map((entry) => entry.id === updated.id ? updated : entry),
      savedAt: now,
    },
  };
}

export async function attachTaskRouteCapability(
  workspaceId: string,
  taskId: string,
  routeCapabilityId: string
): Promise<SavedTaskSession> {
  const id = routeCapabilityId.trim();
  if (!/^c2c_route_id_[0-9a-f-]{36}$/u.test(id)) throw new Error("route capability id is invalid");
  return updateTaskChannel(workspaceId, taskId, (task) => ({ ...task, routeCapabilityId: id, savedAt: new Date().toISOString() }));
}

export function readTaskSession(workspaceId: string, taskId: string): SavedTaskSession | null {
  const id = validateTaskId(taskId);
  return readSessionRegistry(workspaceId).registry.tasks.find((task) => task.taskId === id) ?? null;
}

/** Read-only resolver for continuation. It never lets historical ownership act as current ownership. */
export function resolveTaskBinding(workspaceIdInput: string, taskIdInput: string): TaskBindingResult {
  const requestedWorkspaceId = validateWorkspaceId(workspaceIdInput);
  const taskId = validateTaskId(taskIdInput);
  const ledger = readSessionLedger();
  const exact = registryFromLedger(ledger, requestedWorkspaceId).tasks
    .find(task => task.taskId === taskId && task.bindingState === "bound") ?? null;
  if (exact) return { resolution: "exact", requestedWorkspaceId, boundWorkspaceId: requestedWorkspaceId, task: exact, candidates: [{ workspaceId: requestedWorkspaceId, task: exact }] };
  const candidates = ledger.registries.flatMap(registry => registry.tasks
    .filter(task => task.taskId === taskId && task.bindingState === "bound")
    .map(task => ({ workspaceId: registry.workspaceId, task })));
  if (candidates.length === 0) return { resolution: "unbound", requestedWorkspaceId, boundWorkspaceId: null, task: null, candidates: [] };
  if (candidates.length === 1) return { resolution: "workspace_switch_required", requestedWorkspaceId, boundWorkspaceId: candidates[0].workspaceId, task: candidates[0].task, candidates };
  return { resolution: "ambiguous", requestedWorkspaceId, boundWorkspaceId: null, task: null, candidates };
}

function taskIsBusy(task: SavedTaskSession): boolean {
  return Boolean(task.pendingMessageId || task.pendingDispatchUncertain || task.sendAcceptedAt || task.deliveryPendingSince || task.activeUse || task.channelState !== "ready");
}

function historyEntry(task: SavedTaskSession, workspaceId: string, reason: AssignmentHistoryEntry["reason"], now: string): AssignmentHistoryEntry {
  return { conversationId: task.conversationId, fromWorkspaceId: workspaceId, taskId: task.taskId, generation: task.generation, recordedAt: now, reason };
}

/** Move an idle exact Chat to a registered continuation workspace without changing its conversation id. */
export async function switchTaskWorkspace(input: SwitchTaskWorkspaceOptions): Promise<SavedTaskSession> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const taskId = validateTaskId(input.taskId);
    const fromWorkspaceId = validateWorkspaceId(input.fromWorkspaceId);
    const toWorkspaceId = validateWorkspaceId(input.toWorkspaceId);
    if (fromWorkspaceId === toWorkspaceId) throw new Error("TASK_WORKSPACE_SWITCH_NOOP");
    if (!Number.isSafeInteger(input.expectedGeneration) || input.expectedGeneration < 1) throw new Error("TASK_GENERATION_INVALID");
    const connectorName = input.connectorName.trim(); const workspaceName = input.workspaceName.trim();
    if (!connectorName || !workspaceName) throw new Error("TASK_WORKSPACE_SWITCH_METADATA_INVALID");
    const ledger = readSessionLedger();
    const from = registryFromLedger(ledger, fromWorkspaceId);
    const current = from.tasks.find(task => task.taskId === taskId);
    if (!current || current.bindingState !== "bound" || current.generation !== input.expectedGeneration) throw new Error("TASK_BINDING_STALE");
    if (taskIsBusy(current) || (current.migrationHandshake?.bootMessageId && !current.migrationHandshake.completedAt)) {
      throw new Error("TASK_CHAT_BUSY: resolve the in-flight message, active use, or migration BOOT before switching workspace");
    }
    const target = registryFromLedger(ledger, toWorkspaceId);
    if (target.tasks.some(task => task.taskId === taskId && task.bindingState === "bound")) throw new Error("TASK_BINDING_AMBIGUOUS");
    const poolEntry = current.poolEntryId ? ledger.pool.entries.find(entry => entry.id === current.poolEntryId) : undefined;
    if (!poolEntry || poolEntry.status !== "claimed" || poolEntry.conversationId !== current.conversationId ||
      poolEntry.claimedBy?.workspaceId !== fromWorkspaceId || poolEntry.claimedBy.taskId !== taskId || poolEntry.claimedBy.generation !== current.generation) {
      throw new Error("SESSION_CONVERSATION_OWNER_MISMATCH");
    }
    const now = new Date().toISOString();
    const provisionId = newProvisionId();
    const moved: SavedTaskSession = {
      ...current,
      generation: current.generation + 1,
      provisionId,
      bindingCodeDigest: bindingCodeDigest(bindingCodeFor(toWorkspaceId, taskId, provisionId)),
      connectorName,
      workspaceName,
      branch: input.branch,
      routeCapabilityId: undefined,
      memoryInitialization: undefined,
      verificationState: "pending",
      channelState: "ready",
      hostControl: undefined,
      migrationHandshake: {
        id: `c2c_migration_${randomUUID()}`, fromWorkspaceId: current.migrationHandshake && !current.migrationHandshake.completedAt ? current.migrationHandshake.fromWorkspaceId : fromWorkspaceId, toWorkspaceId, taskId,
        conversationId: current.conversationId, fromGeneration: current.migrationHandshake && !current.migrationHandshake.completedAt ? current.migrationHandshake.fromGeneration : current.generation,
        toGeneration: current.generation + 1, assignmentEpoch: (poolEntry.assignmentEpoch ?? 0) + 1,
        receipt: { iteration: current.iteration, messageId: current.lastDeliveredMessageId ?? null,
          state: current.lastState ?? null, reviewHead: current.lastReviewHead },
      },
      activeUse: undefined,
      savedAt: now,
    };
    const nextTarget: SessionRegistry = { ...target, projectUrl: `https://chatgpt.com/g/${poolEntry.projectId}/project`, connectorName,
      tasks: [...target.tasks.filter(task => task.taskId !== taskId), moved], provisions: target.provisions.filter(item => item.taskId !== taskId), savedAt: now };
    const nextFrom: SessionRegistry = { ...from, tasks: from.tasks.filter(task => task.taskId !== taskId), savedAt: now };
    writeSessionLedger({ ...ledger,
      pool: { ...ledger.pool, entries: ledger.pool.entries.map(entry => entry.id === poolEntry.id ? { ...entry, claimedBy: { workspaceId: toWorkspaceId, taskId, generation: moved.generation }, lastUsedAt: now, assignmentEpoch: (entry.assignmentEpoch ?? 0) + 1 } : entry), savedAt: now },
      registries: [...ledger.registries.filter(registry => registry.workspaceId !== fromWorkspaceId && registry.workspaceId !== toWorkspaceId), nextFrom, nextTarget],
      assignmentHistory: [...(ledger.assignmentHistory ?? []), { ...historyEntry(current, fromWorkspaceId, "workspace_switch", now), toWorkspaceId, toTaskId: taskId, toConversationId: current.conversationId, assignmentEpoch: moved.migrationHandshake!.assignmentEpoch, snapshot: current }], savedAt: now });
    return moved;
  });
}

/** Obtain the single coordinator lease used to prevent automatic pool reclamation. */
export async function resumeTaskSession(workspaceIdInput: string, taskIdInput: string): Promise<SavedTaskSession & { useId: string }> {
  const useId = `c2c_use_${randomUUID()}`;
  const task = await updateTaskChannel(workspaceIdInput, taskIdInput, current => {
    if (current.bindingState !== "bound" || taskIsBusy(current)) throw new Error("TASK_CHAT_BUSY");
    const now = new Date().toISOString();
    return { ...current, activeUse: { useId, startedAt: now }, savedAt: now };
  });
  return { ...task, useId };
}

/** End a coordinator lease. A pending delivery can never be marked reusable. */
export async function finishTaskSession(workspaceIdInput: string, taskIdInput: string, useIdInput: string): Promise<SavedTaskSession> {
  const useId = useIdInput.trim();
  if (!USE_ID_PATTERN.test(useId)) throw new Error("TASK_USE_ID_INVALID");
  return updateTaskChannel(workspaceIdInput, taskIdInput, current => {
    if (!current.activeUse || current.activeUse.useId !== useId) throw new Error("TASK_USE_STALE");
    if (current.pendingMessageId || current.pendingDispatchUncertain || current.sendAcceptedAt || current.deliveryPendingSince) throw new Error("TASK_CHAT_BUSY");
    const now = new Date().toISOString();
    return { ...current, activeUse: undefined, savedAt: now };
  });
}

/** Verify that Router capabilities always point at the ledger's current generation. */
export function assertTaskConversationOwner(
  workspaceIdInput: string,
  taskIdInput: string,
  conversationIdInput: string
): SavedTaskSession {
  const workspaceId = validateWorkspaceId(workspaceIdInput);
  const taskId = validateTaskId(taskIdInput);
  const conversationId = validateConversationId(conversationIdInput);
  const task = readTaskSession(workspaceId, taskId);
  if (!task || task.bindingState !== "bound" || task.conversationId !== conversationId) {
    throw new Error("SESSION_CONVERSATION_OWNER_MISMATCH");
  }
  return task;
}

export async function confirmTaskSettings(
  workspaceId: string,
  taskId: string,
  result: "confirmed" | "later"
): Promise<SavedTaskSession> {
  if (result !== "confirmed" && result !== "later") throw new Error("settings result must be confirmed or later");
  return updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.bindingState !== "bound") throw new Error("task conversation binding is unavailable");
    if (task.verificationState !== "pending") throw new Error("settings confirmation belongs before workspace verification");
    if (task.settingsSource === "user_confirmed") return task;
    const now = new Date().toISOString();
    if (result === "later") {
      return {
        ...task,
        settingsDialogState: "later",
        savedAt: now,
      };
    }
    return {
      ...task,
      settingsSource: "user_confirmed",
      settingsDialogState: "confirmed",
      thinkingLevel: "xhigh",
      settingsConfirmedAt: now,
      savedAt: now,
    };
  });
}

async function updateTaskChannel(
  workspaceId: string,
  taskId: string,
  update: (task: SavedTaskSession) => SavedTaskSession
): Promise<SavedTaskSession> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const workspace = validateWorkspaceId(workspaceId);
    const id = validateTaskId(taskId);
    const ledger = readSessionLedger();
    const registry = registryFromLedger(ledger, workspace);
    const current = registry.tasks.find((task) => task.taskId === id);
    if (!current) throw new Error("task has no ChatGPT conversation binding");
    const task = update({ ...current, channelState: current.channelState ?? "ready" });
    const tasks = registry.tasks.map((entry) => entry.taskId === id ? task : entry);
    const usedNow = (task.activeUse !== undefined && current.activeUse?.useId !== task.activeUse.useId) ||
      current.pendingMessageId !== task.pendingMessageId ||
      (current.pendingMessageId !== undefined && task.pendingMessageId === undefined);
    const now = new Date().toISOString();
    const poolEntries = usedNow && task.poolEntryId
      ? ledger.pool.entries.map(entry => entry.id === task.poolEntryId ? { ...entry, lastUsedAt: now } : entry)
      : ledger.pool.entries;
    let nextLedger: SessionLedger = {
      ...ledger,
      pool: poolEntries === ledger.pool.entries ? ledger.pool : { ...ledger.pool, entries: poolEntries, savedAt: now },
      registries: [...ledger.registries.filter((entry) => entry.workspaceId !== workspace), {
        ...registry,
        tasks,
        savedAt: new Date().toISOString(),
      }],
    };
    if (task.bindingState === "unavailable" && current.bindingState !== "unavailable") {
      nextLedger = retireClaimedStandbyEntryInLedger(nextLedger, task, task.replacementReason ?? "retired");
    }
    if (task.bindingState === "quarantined" && current.bindingState !== "quarantined") {
      nextLedger = quarantineClaimedStandbyEntryInLedger(nextLedger, task, task.replacementReason ?? "quarantined");
    }
    writeSessionLedger(nextLedger);
    return task;
  });
}

export async function confirmTaskWorkspace(
  workspaceId: string,
  taskId: string,
  observation: WorkspaceConfirmationObservation,
): Promise<SavedTaskSession> {
  const expectedWorkspace = validateWorkspaceId(workspaceId);
  return updateTaskChannel(expectedWorkspace, taskId, (task) => {
    if (task.bindingState !== "bound") throw new Error("task conversation binding is unavailable");
    if (observation.workspaceId.trim() !== expectedWorkspace) {
      throw new Error("workspace identity returned by workspace_info does not match");
    }
    if (!observation.routeTaskId?.trim()) {
      throw new Error("workspace_info route task identity is required; reread workspace_info");
    }
    if (observation.routeTaskId.trim() !== task.taskId) {
      throw new Error("route task identity returned by workspace_info does not match");
    }
    if (!task.workspaceName || task.branch === undefined) {
      throw new Error("expected workspace name or branch is missing from the binding");
    }
    if (observation.workspaceName.trim() !== task.workspaceName) {
      throw new Error("workspace name returned by workspace_info does not match");
    }
    if (observation.branch !== task.branch) {
      throw new Error("branch returned by workspace_info does not match");
    }
    if (task.settingsSource !== "user_confirmed") throw new Error("thinking settings lack user confirmation");
    if (task.pendingMessageId || !task.lastDeliveredMessageId || !task.lastState) {
      throw new Error("workspace verification requires a completed boot reply receipt");
    }
    if (task.lastState !== "DONE") {
      throw new Error("workspace verification requires a successful boot reply");
    }
    if (!task.migrationHandshake && task.verificationState === "pending" && readSessionLedger().assignmentHistory?.some(h =>
      h.reason === "workspace_switch" && h.taskId === taskId && h.conversationId === task.conversationId && h.generation === task.generation - 1)) {
      throw new Error("MIGRATION_BOOT_RECEIPT_REQUIRED");
    }
    if (task.migrationHandshake && !task.migrationHandshake.completedAt &&
      task.migrationHandshake.bootMessageId !== task.lastDeliveredMessageId) {
      throw new Error("MIGRATION_BOOT_RECEIPT_REQUIRED");
    }
    return {
      ...task,
      migrationHandshake: task.migrationHandshake ? { ...task.migrationHandshake, completedAt: new Date().toISOString() } : undefined,
      hostControl: task.migrationHandshake ? { status: "ready", missingTools: [], checkedAt: new Date().toISOString() } : task.hostControl,
      verificationState: "ready",
      channelState: "ready",
      savedAt: new Date().toISOString(),
    };
  });
}

function unavailableTask(task: SavedTaskSession, reason: string): SavedTaskSession {
  if (task.bindingState === "unavailable") {
    return { ...task, replacementReason: reason, savedAt: new Date().toISOString() };
  }
  const replacedConversations = task.replacedConversations.some(
    (entry) => entry.conversationId === task.conversationId
  ) ? task.replacedConversations : [
    ...task.replacedConversations,
    {
      generation: task.generation,
      conversationId: task.conversationId,
      url: task.url,
      replacedAt: new Date().toISOString(),
      reason,
    },
  ];
  return {
    ...task,
    bindingState: "unavailable",
    verificationState: "pending",
    channelState: "degraded",
    pendingMessageId: undefined,
    pendingIteration: undefined,
    pendingReviewHead: undefined,
    pendingMessageKind: undefined,
    pendingMessageDigest: undefined,
    pendingMemoryProject: undefined,
    pendingDispatchUncertain: undefined,
    sendAcceptedAt: undefined,
    deliveryPendingSince: undefined,
    replacedConversations,
    replacementReason: reason,
    savedAt: new Date().toISOString(),
  };
}

function quarantineTask(task: SavedTaskSession, reason: string): SavedTaskSession {
  if (task.bindingState === "quarantined") {
    return { ...task, replacementReason: reason, savedAt: new Date().toISOString() };
  }
  return {
    ...task,
    bindingState: "quarantined",
    verificationState: "pending",
    channelState: "degraded",
    pendingMessageId: undefined,
    pendingIteration: undefined,
    pendingReviewHead: undefined,
    pendingMessageKind: undefined,
    pendingMessageDigest: undefined,
    pendingMemoryProject: undefined,
    pendingDispatchUncertain: undefined,
    sendAcceptedAt: undefined,
    deliveryPendingSince: undefined,
    replacementReason: reason,
    lastDeliveryError: reason,
    lastDeliveryCheckedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
}

export async function markTaskUnavailable(
  workspaceId: string,
  taskId: string,
  reason: string
): Promise<SavedTaskSession> {
  const normalizedReason = reason.trim().slice(0, 500);
  if (!normalizedReason) throw new Error("replacement requires a reason");
  return updateTaskChannel(workspaceId, taskId, (current) => unavailableTask(current, normalizedReason));
}

/**
 * Re-adopt a legacy retirement only after the coordinator has directly read
 * this exact Chat and verified its task/workspace identity. This never selects
 * a replacement Chat and never changes the task generation.
 */
export async function restoreTaskConversation(
  workspaceIdInput: string,
  taskIdInput: string,
  conversationIdInput: string
): Promise<SavedTaskSession> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const workspaceId = validateWorkspaceId(workspaceIdInput);
    const taskId = validateTaskId(taskIdInput);
    const conversationId = validateConversationId(conversationIdInput);
    const ledger = readSessionLedger();
    const registry = registryFromLedger(ledger, workspaceId);
    const current = registry.tasks.find((task) => task.taskId === taskId);
    if (!current || current.bindingState !== "unavailable" || current.conversationId !== conversationId) {
      throw new Error("TASK_CHAT_RESTORE_INELIGIBLE");
    }
    if (!current.replacedConversations.some((entry) => entry.conversationId === conversationId)) {
      throw new Error("TASK_CHAT_RESTORE_INELIGIBLE");
    }
    const entry = current.poolEntryId ? ledger.pool.entries.find((candidate) => candidate.id === current.poolEntryId) : undefined;
    if (!entry || entry.conversationId !== conversationId || entry.status !== "retired" ||
      entry.claimedBy?.workspaceId !== workspaceId || entry.claimedBy.taskId !== taskId ||
      entry.claimedBy.generation !== current.generation) {
      throw new Error("TASK_CHAT_RESTORE_INELIGIBLE");
    }
    const now = new Date().toISOString();
    const restored: SavedTaskSession = {
      ...current,
      bindingState: "bound",
      verificationState: "pending",
      channelState: "degraded",
      replacedConversations: current.replacedConversations.filter((item) => item.conversationId !== conversationId),
      replacementReason: undefined,
      memoryInitialization: undefined,
      consecutiveReadFailures: 0,
      lastReadError: undefined,
      lastReadCheckedAt: now,
      savedAt: now,
    };
    const claimed: StandbyConversation = {
      ...entry,
      status: "claimed",
      retiredAt: undefined,
      reason: undefined,
      claimedAt: entry.claimedAt ?? now,
    };
    writeSessionLedger({
      ...ledger,
      pool: { ...ledger.pool, entries: ledger.pool.entries.map((candidate) => candidate.id === entry.id ? claimed : candidate), savedAt: now },
      registries: [...ledger.registries.filter((candidate) => candidate.workspaceId !== workspaceId), {
        ...registry,
        tasks: registry.tasks.map((task) => task.taskId === taskId ? restored : task),
        savedAt: now,
      }],
      savedAt: now,
    });
    return restored;
  });
}

function verifyMigrationRead(workspaceId: string, taskId: string, task: SavedTaskSession, o: MigrationReadObservation | undefined): SavedTaskSession {
  if (!o || typeof o !== "object" || Array.isArray(o) || o.chatStatus !== "idle" || o.readbackClean !== true ||
    !Number.isSafeInteger(o.iteration) || o.iteration < 0 || !Number.isSafeInteger(o.generation) ||
    !Number.isSafeInteger(o.assignmentEpoch) || !isValidReclaimTimestamp(o.chatReadAt)) throw new Error("MIGRATION_OBSERVATION_INVALID");
  if (Date.now() - Date.parse(o.chatReadAt) > 60_000 || Date.parse(o.chatReadAt) > Date.now()) throw new Error("MIGRATION_OBSERVATION_EXPIRED");
  if (task.hostControl?.status !== "readback_required" || task.hostControl.missingTools.length) throw new Error("HOST_CONTROL_PROBE_REQUIRED");
  if (task.verificationState !== "pending" || task.pendingMessageId || task.pendingIteration !== undefined ||
    task.pendingDispatchUncertain || task.sendAcceptedAt || task.deliveryPendingSince) throw new Error("MIGRATION_SEND_UNRESOLVED");
  if (task.activeUse?.useId !== o.useId) throw new Error("TASK_USE_STALE");
  const ledger = readSessionLedger(); // Caller holds the global ledger lock.
  const owners = ledger.registries.flatMap(r => r.tasks.filter(t => t.bindingState === "bound" &&
    (t.taskId === taskId || t.conversationId === task.conversationId)).map(t => ({ workspaceId: r.workspaceId, task: t })));
  const entry = ledger.pool.entries.find(e => e.id === task.poolEntryId);
  if (owners.length !== 1 || owners[0].workspaceId !== workspaceId || !entry || entry.status !== "claimed" ||
    entry.claimedBy?.workspaceId !== workspaceId || entry.claimedBy.taskId !== taskId || entry.claimedBy.generation !== task.generation ||
    entry.assignmentEpoch !== o.assignmentEpoch || o.taskId !== taskId || o.conversationId !== task.conversationId ||
    o.toWorkspaceId !== workspaceId || o.generation !== task.generation) throw new Error("MIGRATION_CANDIDATE_CHANGED");
  let migration = task.migrationHandshake;
  if (!migration) {
    let destination = workspaceId;
    let generation = task.generation - 1;
    let source: string | undefined;
    while (generation >= 1) {
      const history = (ledger.assignmentHistory ?? []).filter(h => h.reason === "workspace_switch" &&
        h.taskId === taskId && h.conversationId === task.conversationId && h.generation === generation);
      if (history.length !== 1 || (history[0].toWorkspaceId !== undefined && history[0].toWorkspaceId !== destination) ||
        (generation !== task.generation - 1 && history[0].toWorkspaceId === undefined)) throw new Error("MIGRATION_HISTORY_UNPROVEN");
      source = history[0].fromWorkspaceId;
      if (source === o.fromWorkspaceId) break;
      destination = source;
      generation--;
    }
    if (source !== o.fromWorkspaceId || generation < 1) throw new Error("MIGRATION_HISTORY_UNPROVEN");
    migration = { id: `c2c_migration_${randomUUID()}`, fromWorkspaceId: o.fromWorkspaceId, toWorkspaceId: workspaceId,
      taskId, conversationId: task.conversationId, fromGeneration: generation, toGeneration: task.generation,
      assignmentEpoch: o.assignmentEpoch, receipt: { iteration: task.iteration, messageId: task.lastDeliveredMessageId ?? null,
        state: task.lastState ?? null, reviewHead: task.lastReviewHead } };
  }
  if (migration.completedAt || migration.fromWorkspaceId !== o.fromWorkspaceId || migration.toWorkspaceId !== workspaceId ||
    migration.toGeneration !== task.generation || migration.assignmentEpoch !== entry.assignmentEpoch ||
    migration.taskId !== taskId || migration.conversationId !== task.conversationId) throw new Error("MIGRATION_HISTORY_UNPROVEN");
  const r = migration.receipt;
  if (o.iteration !== r.iteration || o.messageId !== r.messageId || o.state !== r.state || o.reviewHead !== r.reviewHead ||
    task.iteration !== r.iteration || (task.lastDeliveredMessageId ?? null) !== r.messageId ||
    (task.lastState ?? null) !== r.state || task.lastReviewHead !== r.reviewHead) throw new Error("MIGRATION_RECEIPT_MISMATCH");
  if (r.messageId === null || r.state === null) throw new Error("MIGRATION_HISTORY_UNPROVEN: completed source receipt required");
  return { ...task, migrationHandshake: migration, channelState: "ready",
    hostControl: { status: "migration_boot_ready", missingTools: [], checkedAt: o.chatReadAt }, savedAt: new Date().toISOString() };
}

/** Observations come from the coordinator's callable tool inventory, not the Tunnel. */
export async function recordTaskHostControl(
  workspaceId: string, taskId: string, observation: HostControlObservation
): Promise<SavedTaskSession> {
  return updateTaskChannel(workspaceId, taskId, task => {
    if (task.bindingState !== "bound") throw new Error("HOST_CONTROL_BINDING_UNAVAILABLE");
    const checkedAt = new Date().toISOString();
    let status: HostControlState["status"];
    let missingTools = task.hostControl?.missingTools ?? [];
    if (observation.result === "probe") {
      if (!Array.isArray(observation.tools) || !observation.tools.every(x => typeof x === "string" && x.trim().length > 0)) {
        throw new Error("HOST_CONTROL_TOOLS_REQUIRED");
      }
      missingTools = ["read_thread", "send_message_to_thread"].filter(name => !observation.tools!.includes(name));
      status = missingTools.length ? "tools_missing" : "readback_required";
    } else if (observation.result === "migration-read-ok") {
      return verifyMigrationRead(workspaceId, taskId, task, observation.migrationObservation);
    } else if (observation.result === "read-ok") {
      if (task.hostControl?.status !== "readback_required" || missingTools.length) {
        throw new Error("HOST_CONTROL_PROBE_REQUIRED");
      }
      if (observation.conversationId !== task.conversationId || observation.observedTaskId !== taskId ||
        observation.observedWorkspaceId !== workspaceId) throw new Error("HOST_CONTROL_IDENTITY_MISMATCH");
      status = "ready";
    } else if (observation.result === "not-invoked") {
      if (!task.pendingMessageId || observation.messageId !== task.pendingMessageId || task.sendAcceptedAt ||
        task.lastDeliveredMessageId === task.pendingMessageId ||
        task.pendingDispatchUncertain) {
        throw new Error("HOST_CONTROL_NOT_INVOKED_UNPROVEN");
      }
      return { ...task, pendingMessageId: undefined, pendingIteration: undefined,
        pendingReviewHead: undefined, pendingMessageKind: undefined,
        pendingMessageDigest: undefined, pendingMemoryProject: undefined,
        pendingDispatchUncertain: undefined,
        deliveryPendingSince: undefined, channelState: "degraded",
        hostControl: { status: "not_invoked", missingTools, checkedAt }, savedAt: checkedAt };
    } else if (observation.result === "timeout") status = "call_timeout";
    else if (observation.result === "call-failed") status = "call_failed";
    else throw new Error("HOST_CONTROL_RESULT_INVALID");
    // Recover the delivery phase from its receipts; tool visibility alone never resumes it.
    const channelState: ChannelState = status !== "ready" ? "degraded" : !task.pendingMessageId ? "ready" :
      task.lastDeliveredMessageId === task.pendingMessageId ? "awaiting_reply" : "sending";
    return { ...task, channelState,
      pendingDispatchUncertain: task.pendingDispatchUncertain ||
        (Boolean(task.pendingMessageId) && (status === "call_timeout" || status === "call_failed")),
      hostControl: { status, missingTools, checkedAt }, savedAt: checkedAt };
  });
}

export async function recordTaskReadResult(
  workspaceId: string,
  taskId: string,
  result: "ok" | "missing" | "gone" | "timeout",
  reason = ""
): Promise<SavedTaskSession> {
  const checkedAt = new Date().toISOString();
  const normalizedReason = reason.trim().slice(0, 500);
  if (result !== "ok" && !normalizedReason) throw new Error("read result requires a reason");
  const task = await updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.bindingState !== "bound" && result !== "gone") {
      throw new Error("task conversation binding is already unavailable");
    }
    if (task.pendingMessageId) {
      throw new Error("use delivery receipt handling while a message is in flight");
    }
    if (result === "ok") {
      return {
        ...task,
        channelState: task.hostControl && task.hostControl.status !== "ready" ? "degraded" : "ready",
        consecutiveReadFailures: 0,
        lastReadError: undefined,
        lastReadCheckedAt: checkedAt,
        savedAt: checkedAt,
      };
    }
    if (result === "timeout") {
      return {
        ...task,
        channelState: "degraded",
        lastReadError: normalizedReason,
        lastReadCheckedAt: checkedAt,
        savedAt: checkedAt,
      };
    }
    if (result === "gone") {
      return {
        ...unavailableTask(task, normalizedReason),
        consecutiveReadFailures: Math.max(3, task.consecutiveReadFailures),
        lastReadError: normalizedReason,
        lastReadCheckedAt: checkedAt,
      };
    }
    const failures = task.consecutiveReadFailures + 1;
    return {
      ...task,
      channelState: "degraded",
      consecutiveReadFailures: failures,
      lastReadError: normalizedReason,
      lastReadCheckedAt: checkedAt,
      savedAt: checkedAt,
    };
  });
  return task;
}

function reserveTaskSend(
  task: SavedTaskSession,
  id: string,
  iteration: number,
  flags: BeginSendOptions,
): SavedTaskSession {
  if (flags.messageKind !== undefined && flags.messageKind !== "init" && flags.messageKind !== "executed") {
    throw new Error("BUSINESS_MESSAGE_KIND_INVALID");
  }
  if ((flags.bootstrap || flags.probe) && flags.messageKind !== undefined) {
    throw new Error("BUSINESS_MESSAGE_KIND_FORBIDDEN");
  }
  if (flags.messageKind === "init") {
    if (!/^[0-9a-f]{64}$/u.test(flags.messageDigest ?? "")) throw new Error("C2C_INIT_MESSAGE_DIGEST_INVALID");
    compactInitField(flags.memoryProject, "memory_project", 120);
  } else if (flags.messageDigest !== undefined || flags.memoryProject !== undefined) {
    throw new Error("C2C_INIT_METADATA_FORBIDDEN");
  }
  if (flags.messageKind === "executed" && task.memoryInitialization?.generation !== task.generation) {
    throw new Error("MEMORY_INIT_REQUIRED: send a generated INIT for this binding generation first");
  }
  if (flags.expectedGeneration !== undefined && task.generation !== flags.expectedGeneration) throw new Error("TASK_GENERATION_STALE");
  if (task.activeUse && flags.useId !== task.activeUse.useId) throw new Error("TASK_USE_STALE");
  if (flags.useId !== undefined && !USE_ID_PATTERN.test(flags.useId)) throw new Error("TASK_USE_ID_INVALID");
  if (task.bindingState !== "bound") throw new Error("task conversation binding is unavailable");
  if (task.hostControl && task.hostControl.status !== "ready" && !(flags.bootstrap && task.hostControl.status === "migration_boot_ready")) throw new Error("HOST_CONTROL_NOT_READY: probe tools and read the exact bound Chat");
  const migrating = task.migrationHandshake && !task.migrationHandshake.completedAt;
  const legacyMigration = !task.migrationHandshake && task.verificationState === "pending" &&
    readSessionLedger().assignmentHistory?.some(h => h.reason === "workspace_switch" && h.taskId === task.taskId &&
      h.conversationId === task.conversationId && h.generation === task.generation - 1);
  if (migrating || legacyMigration) {
    if (!flags.bootstrap || task.hostControl?.status !== "migration_boot_ready" || flags.expectedGeneration !== task.generation ||
      Date.now() - Date.parse(task.hostControl.checkedAt) > 60_000 || Date.parse(task.hostControl.checkedAt) > Date.now()) {
      throw new Error("MIGRATION_PREFLIGHT_REQUIRED: probe then migration-read-ok before BOOT");
    }
  }
  if (task.settingsSource !== "user_confirmed") throw new Error("task conversation settings lack user confirmation");
  if (!flags.bootstrap && task.verificationState !== "ready") {
    throw new Error("task conversation requires workspace verification before task content");
  }
  if (flags.bootstrap && task.verificationState !== "pending") {
    throw new Error("bootstrap sends are accepted only before workspace verification");
  }
  if (task.pendingMessageId) throw new Error("task conversation already has an in-flight message");
  if (task.channelState === "degraded" && !flags.probe) {
    throw new Error("task conversation is degraded; a recovery probe is required");
  }
  if (task.channelState !== "ready" && task.channelState !== "degraded") {
    throw new Error(`task conversation is busy (${task.channelState})`);
  }
  return {
    ...task,
    channelState: "sending",
    hostControl: migrating ? { ...task.hostControl!, status: "readback_required" } : task.hostControl,
    migrationHandshake: migrating ? { ...task.migrationHandshake!, bootMessageId: id } : task.migrationHandshake,
    pendingMessageId: id,
    pendingIteration: iteration,
    pendingDispatchUncertain: undefined,
    pendingReviewHead: flags.reviewHead,
    pendingMessageKind: flags.messageKind,
    pendingMessageDigest: flags.messageDigest,
    pendingMemoryProject: flags.memoryProject,
    sendAcceptedAt: undefined,
    deliveryPendingSince: undefined,
    lastDeliveryError: undefined,
    lastDeliveryCheckedAt: new Date().toISOString(),
    savedAt: new Date().toISOString(),
  };
}

export async function beginTaskSend(
  workspaceId: string,
  taskId: string,
  messageId: string,
  iteration: number,
  options: BeginSendOptions | boolean = {}
): Promise<SavedTaskSession> {
  const id = validateMessageId(messageId);
  if (!Number.isSafeInteger(iteration) || iteration < 0) throw new Error("iteration must be a non-negative integer");
  const flags = typeof options === "boolean" ? { probe: options } : options;
  if (flags.reviewHead !== undefined && !/^[0-9a-f]{40}$/u.test(flags.reviewHead)) throw new Error("REVIEW_HEAD_INVALID");
  if (flags.bootstrap && flags.reviewHead !== undefined) throw new Error("BOOT_REVIEW_HEAD_FORBIDDEN");
  return updateTaskChannel(workspaceId, taskId, task => reserveTaskSend(task, id, iteration, flags));
}

/** Atomically reserve and render the only supported business INIT format. */
export async function prepareTaskInit(
  workspaceId: string,
  taskId: string,
  input: unknown,
  options: Pick<BeginSendOptions, "reviewHead" | "useId"> = {},
): Promise<PreparedInitMessage> {
  const init = validateInitMessageInput(input);
  if (options.reviewHead !== undefined && !/^[0-9a-f]{40}$/u.test(options.reviewHead)) throw new Error("REVIEW_HEAD_INVALID");
  let prepared: Omit<PreparedInitMessage, "task"> | undefined;
  const task = await updateTaskChannel(workspaceId, taskId, current => {
    const messageId = newMessageId();
    const iteration = current.iteration + 1;
    const message = renderInitMessage(workspaceId, current.taskId, messageId, iteration, init, options.reviewHead);
    const messageDigestValue = digestBusinessMessage(message);
    prepared = { messageId, iteration, message, messageDigest: messageDigestValue };
    return reserveTaskSend(current, messageId, iteration, {
      reviewHead: options.reviewHead,
      useId: options.useId,
      messageKind: "init",
      messageDigest: messageDigestValue,
      memoryProject: init.memoryProject,
    });
  });
  if (!prepared) throw new Error("C2C_INIT_PREPARATION_FAILED");
  return { task, ...prepared };
}

export async function confirmTaskSendAccepted(
  workspaceId: string,
  taskId: string,
  messageId: string
): Promise<SavedTaskSession> {
  const id = validateMessageId(messageId);
  return updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.channelState !== "sending" || task.pendingMessageId !== id) {
      throw new Error("accepted send does not match the in-flight message");
    }
    const acceptedAt = new Date().toISOString();
    return {
      ...task,
      sendAcceptedAt: task.sendAcceptedAt ?? acceptedAt,
      lastDeliveryCheckedAt: acceptedAt,
      savedAt: acceptedAt,
    };
  });
}

export async function recordTaskDeliveryPending(
  workspaceId: string,
  taskId: string,
  messageId: string
): Promise<SavedTaskSession> {
  const id = validateMessageId(messageId);
  return updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.channelState !== "sending" || task.pendingMessageId !== id) {
      throw new Error("pending delivery does not match the in-flight message");
    }
    if (!task.sendAcceptedAt) throw new Error("delivery pending requires an accepted send");
    const checkedAt = new Date().toISOString();
    return {
      ...task,
      deliveryPendingSince: task.deliveryPendingSince ?? checkedAt,
      lastDeliveryCheckedAt: checkedAt,
      savedAt: checkedAt,
    };
  });
}

export async function confirmTaskDelivery(
  workspaceId: string,
  taskId: string,
  messageId: string,
  observedMessageDigest?: string
): Promise<SavedTaskSession> {
  const id = validateMessageId(messageId);
  return updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.channelState !== "sending" || task.pendingMessageId !== id) {
      throw new Error("delivery receipt does not match the in-flight message");
    }
    if (task.pendingMessageKind === "init") {
      if (!observedMessageDigest) throw new Error("C2C_INIT_READBACK_REQUIRED");
      if (observedMessageDigest !== task.pendingMessageDigest) throw new Error("C2C_INIT_READBACK_MISMATCH");
    } else if (observedMessageDigest !== undefined) {
      throw new Error("C2C_MESSAGE_READBACK_UNEXPECTED");
    }
    return {
      ...task,
      channelState: "awaiting_reply",
      lastDeliveredMessageId: id,
      deliveryPendingSince: undefined,
      lastDeliveryCheckedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    };
  });
}

export async function confirmTaskReply(
  workspaceId: string,
  taskId: string,
  messageId: string,
  state: string,
  observedReviewHead?: string,
  observedMemory?: MemoryReplyObservation
): Promise<SavedTaskSession> {
  const id = validateMessageId(messageId);
  const normalizedState = state.trim().toUpperCase();
  if (!/^(PLAN|DONE|BLOCKED|ERROR)$/u.test(normalizedState)) {
    throw new Error("reply state must be PLAN, DONE, BLOCKED, or ERROR");
  }
  return updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.channelState !== "awaiting_reply" || task.pendingMessageId !== id || task.pendingIteration === undefined) {
      throw new Error("reply receipt does not match the delivered in-flight message");
    }
    // Older clients could reserve BOOT with REVIEW_HEAD. BOOT replies intentionally
    // prove workspace identity and do not echo a review commit, so reconcile that
    // already-delivered legacy state instead of trapping the binding forever.
    const legacyMalformedBootstrap = task.verificationState === "pending" &&
      task.pendingReviewHead !== undefined && observedReviewHead === undefined;
    if (task.pendingReviewHead && !legacyMalformedBootstrap && observedReviewHead !== task.pendingReviewHead) {
      throw new Error("REVIEW_HEAD_MISMATCH");
    }
    if (task.pendingMessageKind !== "init" && observedMemory !== undefined) {
      throw new Error("MEMORY_REPLY_OBSERVATION_UNEXPECTED");
    }
    const memory = task.pendingMessageKind === "init"
      ? validateMemoryReplyObservation(observedMemory, task)
      : undefined;
    const checkedAt = new Date().toISOString();
    return {
      ...task,
      channelState: "ready",
      iteration: task.pendingIteration,
      lastState: normalizedState,
      lastReviewHead: legacyMalformedBootstrap ? task.lastReviewHead : task.pendingReviewHead,
      pendingMessageId: undefined,
      pendingIteration: undefined,
      pendingReviewHead: undefined,
      pendingMessageKind: undefined,
      pendingMessageDigest: undefined,
      pendingMemoryProject: undefined,
      pendingDispatchUncertain: undefined,
      sendAcceptedAt: undefined,
      deliveryPendingSince: undefined,
      lastDeliveryError: undefined,
      lastDeliveryCheckedAt: checkedAt,
      memoryInitialization: memory ? {
        generation: task.generation,
        project: memory.project,
        status: memory.status,
        sources: memory.sources,
        reason: memory.reason,
        checkedAt,
      } : task.memoryInitialization,
      savedAt: checkedAt,
    };
  });
}

export async function failTaskDelivery(
  workspaceId: string,
  taskId: string,
  messageId: string,
  failureKind: string,
  reason: string
): Promise<SavedTaskSession> {
  const id = validateMessageId(messageId);
  if (!isDeliveryFailureKind(failureKind)) {
    throw new Error("delivery failure requires a terminal host_rejected, conversation_gone, or identity_mismatch result");
  }
  const normalizedReason = reason.trim().slice(0, 500);
  if (!normalizedReason) throw new Error("delivery failure requires a reason");
  const task = await updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.pendingMessageId !== id || !["sending", "delivered", "awaiting_reply", "degraded"].includes(task.channelState)) {
      throw new Error("delivery failure does not match the in-flight message");
    }
    const terminalReason = `${failureKind}: ${normalizedReason}`;
    if (failureKind === "host_rejected" && (task.sendAcceptedAt || task.lastDeliveredMessageId === id)) {
      throw new Error("HOST_REJECTION_RECEIPT_CONFLICT: preserve the in-flight message and read the bound Chat");
    }
    if (failureKind === "conversation_gone") {
      return unavailableTask(task, terminalReason);
    }
    if (failureKind === "identity_mismatch") return quarantineTask(task, terminalReason);
    return {
      ...task,
      channelState: "degraded",
      pendingMessageId: undefined,
      pendingIteration: undefined,
      pendingReviewHead: undefined,
      pendingMessageKind: undefined,
      pendingMessageDigest: undefined,
      pendingMemoryProject: undefined,
      pendingDispatchUncertain: undefined,
      sendAcceptedAt: undefined,
      deliveryPendingSince: undefined,
      lastDeliveryError: terminalReason,
      lastDeliveryCheckedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    };
  });
  return task;
}

function isDeliveryFailureKind(value: string): value is DeliveryFailureKind {
  return value === "host_rejected" || value === "conversation_gone" || value === "identity_mismatch";
}

export async function clearTaskSession(
  workspaceId: string,
  taskId: string
): Promise<{ cleared: boolean; keptProject: boolean }> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const workspace = validateWorkspaceId(workspaceId);
    const id = validateTaskId(taskId);
    const ledger = readSessionLedger();
    const registry = registryFromLedger(ledger, workspace);
    const current = registry.tasks.find((task) => task.taskId === id);
    const tasks = current
      ? registry.tasks.map((task) => task.taskId === id
        ? unavailableTask(task, "operator retired the task conversation")
        : task)
      : registry.tasks;
    const provisions = registry.provisions.filter((provision) => provision.taskId !== id);
    const cleared = Boolean(current) || provisions.length !== registry.provisions.length;
    if (!cleared) return { cleared: false, keptProject: Boolean(registry.projectUrl) };
    let nextLedger: SessionLedger = {
      ...ledger,
      registries: [...ledger.registries.filter((entry) => entry.workspaceId !== workspace), {
        ...registry,
        tasks,
        provisions,
        savedAt: new Date().toISOString(),
      }],
    };
    if (current) {
      const retired = tasks.find((task) => task.taskId === id)!;
      nextLedger = retireClaimedStandbyEntryInLedger(nextLedger, retired, retired.replacementReason ?? "operator retired");
    }
    writeSessionLedger(nextLedger);
    return { cleared: true, keptProject: Boolean(registry.projectUrl) };
  });
}

export async function clearTaskSessionAfterMismatch(workspaceId: string, taskId: string): Promise<void> {
  await clearTaskSession(workspaceId, taskId);
}

export function removeSessionRegistry(workspaceId: string): void {
  if (fs.existsSync(sessionLedgerFile())) {
    throw new Error("global assignment ledger owns session records; retire the exact task instead");
  }
  fs.rmSync(sessionFile(workspaceId), { force: true });
}
