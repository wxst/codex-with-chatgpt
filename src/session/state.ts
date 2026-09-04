import path from "node:path";
import fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";

export type VerificationState = "pending" | "ready";
export type SettingsSource = "pending" | "user_confirmed";
export type BindingState = "bound" | "unavailable";
export type BootstrapCreationState = "idle" | "dispatching" | "pending" | "created";
export type SettingsDialogState = "pending" | "confirmed" | "later";
export type ChannelState = "ready" | "sending" | "delivered" | "awaiting_reply" | "degraded";
export type DeliveryFailureKind = "host_rejected" | "conversation_gone" | "identity_mismatch";

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
  pendingMessageId?: string;
  pendingIteration?: number;
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
}

export interface ReceiptIdentity {
  messageId: string;
  taskId: string;
  workspaceId: string;
  iteration: number;
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
}

export interface StandbyPool {
  version: 1;
  projectId: string | null;
  entries: StandbyConversation[];
  savedAt: string;
}

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
}

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
  if (hostTaskId) {
    return { taskId: validateTaskId(hostTaskId), source: "CODEX_THREAD_ID", generated: false };
  }
  if (explicitTaskId?.trim()) {
    return { taskId: validateTaskId(explicitTaskId), source: "explicit", generated: false };
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
  const raw = readJsonIfExists<unknown>(standbyPoolFile());
  return isStandbyPool(raw) ? raw : emptyStandbyPool();
}

function writeStandbyPool(pool: StandbyPool): StandbyPool {
  writeSecureJson(standbyPoolFile(), pool);
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

export function readSessionRegistry(workspaceId: string): SessionReadResult {
  const id = validateWorkspaceId(workspaceId);
  const raw = readJsonIfExists<unknown>(sessionFile(id));
  if (isRegistry(raw) && raw.workspaceId === id) return { registry: normalizeRegistry(raw), legacyDetected: false };
  return { registry: emptyRegistry(id), legacyDetected: raw !== null };
}

export function writeSessionRegistry(registry: SessionRegistry): SessionRegistry {
  if (registry.version !== 3) throw new Error("session registry version must be 3");
  writeSecureJson(sessionFile(registry.workspaceId), registry);
  return registry;
}

function allConversationIds(task: SavedTaskSession): string[] {
  return [task.conversationId, ...task.replacedConversations.map((item) => item.conversationId)];
}

function findConversationOwner(conversationId: string): { workspaceId: string; taskId: string } | null {
  const directory = path.join(getStateDir(), "sessions");
  let files: string[];
  try {
    files = fs.readdirSync(directory);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith(".json") || file === "bootstrap-lease.json") continue;
    const candidate = readJsonIfExists<unknown>(path.join(directory, file));
    if (!isRegistry(candidate)) continue;
    const registry = normalizeRegistry(candidate);
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

/**
 * Atomically lease the oldest compatible standby Chat. A claimed Chat never
 * returns to the pool, even if its channel is later degraded.
 */
export async function claimStandbyConversation(
  input: ClaimStandbyConversationOptions
): Promise<StandbyClaimResult> {
  return withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const workspaceId = validateWorkspaceId(input.workspaceId);
    const taskId = validateTaskId(input.taskId);
    const connectorName = input.connectorName.trim();
    const workspaceName = input.workspaceName.trim();
    if (!connectorName || !workspaceName) throw new Error("standby claim requires connector and workspace names");
    const { registry } = readSessionRegistry(workspaceId);
    const existing = registry.tasks.find((entry) => entry.taskId === taskId);
    const pool = readStandbyPool();
    if (existing?.bindingState === "bound") {
      const entry = pool.entries.find((candidate) => candidate.conversationId === existing.conversationId);
      if (!entry) throw new Error("bound task conversation is missing from the standby pool");
      return { task: existing, entry, reused: true };
    }

    const desiredMarker: StandbyMarker = input.userExplicitPro ? STANDBY_PRO_MARKER : STANDBY_MARKER;
    const candidate = pool.entries
      .filter((entry) => entry.status === "available" && entry.marker === desiredMarker)
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.importedAt.localeCompare(right.importedAt))[0];
    if (!candidate) throw new Error("POOL_EXHAUSTED: no compatible standby Chat is available");

    const owner = findConversationOwner(candidate.conversationId);
    if (owner) throw new Error("standby conversation is already owned by a workspace task");
    const now = new Date().toISOString();
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
    const retiredPriorId = existing?.poolEntryId;
    const entries = pool.entries.map((entry) => {
      if (entry.id === candidate.id) {
        return {
          ...entry,
          status: "claimed" as const,
          claimedAt: now,
          claimedBy: { workspaceId, taskId, generation: task.generation },
          reason: undefined,
        };
      }
      if (retiredPriorId && entry.id === retiredPriorId && entry.status === "claimed") {
        return { ...entry, status: "retired" as const, retiredAt: now, reason: existing?.replacementReason ?? "replaced" };
      }
      return entry;
    });
    const claimed = entries.find((entry) => entry.id === candidate.id)!;
    writeStandbyPool({ ...pool, entries, savedAt: now });
    writeSessionRegistry({
      ...registry,
      projectUrl: `https://chatgpt.com/g/${candidate.projectId}/project`,
      connectorName,
      tasks: [...registry.tasks.filter((entry) => entry.taskId !== taskId), task],
      // Legacy fake-creation provisions must not participate in standby allocation.
      provisions: registry.provisions.filter((entry) => entry.taskId !== taskId),
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
    const pool = readStandbyPool();
    const current = pool.entries.find((entry) => entry.conversationId === conversationId);
    if (!current) throw new Error("standby conversation is not in the pool");
    const now = new Date().toISOString();
    const updated: StandbyConversation = { ...current, status: "quarantined", retiredAt: now, reason };
    writeStandbyPool({ ...pool, entries: pool.entries.map((entry) => entry.id === current.id ? updated : entry), savedAt: now });
    return updated;
  });
}

async function retireClaimedStandbyEntry(task: SavedTaskSession, reason: string): Promise<void> {
  if (!task.poolEntryId) return;
  await withWorkspaceLifecycleLock(SESSION_REGISTRY_LOCK_ID, async () => {
    const pool = readStandbyPool();
    const current = pool.entries.find((entry) => entry.id === task.poolEntryId);
    if (!current || current.status === "retired") return;
    const now = new Date().toISOString();
    const updated: StandbyConversation = {
      ...current,
      status: "retired",
      retiredAt: now,
      reason: reason.slice(0, 500),
    };
    writeStandbyPool({ ...pool, entries: pool.entries.map((entry) => entry.id === updated.id ? updated : entry), savedAt: now });
  });
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
    const { registry } = readSessionRegistry(workspace);
    const current = registry.tasks.find((task) => task.taskId === id);
    if (!current) throw new Error("task has no ChatGPT conversation binding");
    const task = update({ ...current, channelState: current.channelState ?? "ready" });
    const tasks = registry.tasks.map((entry) => entry.taskId === id ? task : entry);
    writeSessionRegistry({ ...registry, tasks, savedAt: new Date().toISOString() });
    return task;
  });
}

export async function confirmTaskWorkspace(
  workspaceId: string,
  taskId: string,
  observedWorkspaceId: string,
  observedConnectorName: string,
  observedWorkspaceName?: string,
  observedBranch?: string | null
): Promise<SavedTaskSession> {
  const expectedWorkspace = validateWorkspaceId(workspaceId);
  return updateTaskChannel(expectedWorkspace, taskId, (task) => {
    if (task.bindingState !== "bound") throw new Error("task conversation binding is unavailable");
    if (observedWorkspaceId.trim() !== expectedWorkspace) {
      throw new Error("workspace identity returned by workspace_info does not match");
    }
    if (observedConnectorName.trim() !== task.connectorName) {
      throw new Error("connector returned by workspace_info does not match");
    }
    if (!task.workspaceName || task.branch === undefined) {
      throw new Error("expected workspace name or branch is missing from the binding");
    }
    if (observedWorkspaceName?.trim() !== task.workspaceName) {
      throw new Error("workspace name returned by workspace_info does not match");
    }
    if ((observedBranch ?? null) !== task.branch) {
      throw new Error("branch returned by workspace_info does not match");
    }
    if (task.settingsSource !== "user_confirmed") throw new Error("thinking settings lack user confirmation");
    if (task.pendingMessageId || !task.lastDeliveredMessageId || !task.lastState) {
      throw new Error("workspace verification requires a completed boot reply receipt");
    }
    if (task.lastState !== "DONE") {
      throw new Error("workspace verification requires a successful boot reply");
    }
    return {
      ...task,
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
    sendAcceptedAt: undefined,
    deliveryPendingSince: undefined,
    replacedConversations,
    replacementReason: reason,
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
  const task = await updateTaskChannel(workspaceId, taskId, (current) => unavailableTask(current, normalizedReason));
  await retireClaimedStandbyEntry(task, normalizedReason);
  return task;
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
        channelState: "ready",
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
    if (failures >= 3) {
      return {
        ...unavailableTask(task, normalizedReason),
        consecutiveReadFailures: failures,
        lastReadError: normalizedReason,
        lastReadCheckedAt: checkedAt,
      };
    }
    return {
      ...task,
      channelState: "degraded",
      consecutiveReadFailures: failures,
      lastReadError: normalizedReason,
      lastReadCheckedAt: checkedAt,
      savedAt: checkedAt,
    };
  });
  if (task.bindingState === "unavailable") await retireClaimedStandbyEntry(task, normalizedReason);
  return task;
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
  return updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.bindingState !== "bound") throw new Error("task conversation binding is unavailable");
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
      pendingMessageId: id,
      pendingIteration: iteration,
      sendAcceptedAt: undefined,
      deliveryPendingSince: undefined,
      lastDeliveryError: undefined,
      lastDeliveryCheckedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    };
  });
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
  messageId: string
): Promise<SavedTaskSession> {
  const id = validateMessageId(messageId);
  return updateTaskChannel(workspaceId, taskId, (task) => {
    if (task.channelState !== "sending" || task.pendingMessageId !== id) {
      throw new Error("delivery receipt does not match the in-flight message");
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
  state: string
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
    return {
      ...task,
      channelState: "ready",
      iteration: task.pendingIteration,
      lastState: normalizedState,
      pendingMessageId: undefined,
      pendingIteration: undefined,
      sendAcceptedAt: undefined,
      deliveryPendingSince: undefined,
      lastDeliveryError: undefined,
      lastDeliveryCheckedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
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
    if (task.pendingMessageId !== id || !["sending", "delivered", "awaiting_reply"].includes(task.channelState)) {
      throw new Error("delivery failure does not match the in-flight message");
    }
    const terminalReason = `${failureKind}: ${normalizedReason}`;
    if (failureKind === "conversation_gone" || failureKind === "identity_mismatch") {
      return unavailableTask(task, terminalReason);
    }
    return {
      ...task,
      channelState: "degraded",
      pendingMessageId: undefined,
      pendingIteration: undefined,
      sendAcceptedAt: undefined,
      deliveryPendingSince: undefined,
      lastDeliveryError: terminalReason,
      lastDeliveryCheckedAt: new Date().toISOString(),
      savedAt: new Date().toISOString(),
    };
  });
  if (task.bindingState === "unavailable") await retireClaimedStandbyEntry(task, `${failureKind}: ${normalizedReason}`);
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
    const { registry } = readSessionRegistry(workspace);
    const tasks = registry.tasks.filter((task) => task.taskId !== id);
    const provisions = registry.provisions.filter((provision) => provision.taskId !== id);
    const cleared = tasks.length !== registry.tasks.length || provisions.length !== registry.provisions.length;
    if (!cleared) return { cleared: false, keptProject: Boolean(registry.projectUrl) };
    writeSessionRegistry({ ...registry, tasks, provisions, savedAt: new Date().toISOString() });
    return { cleared: true, keptProject: Boolean(registry.projectUrl) };
  });
}

export async function clearTaskSessionAfterMismatch(workspaceId: string, taskId: string): Promise<void> {
  await clearTaskSession(workspaceId, taskId);
}

export function removeSessionRegistry(workspaceId: string): void {
  fs.rmSync(sessionFile(workspaceId), { force: true });
}
