import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";
import { assertTaskConversationOwner } from "../session/state.js";
import { Workspace } from "../workspace/manager.js";

export interface RegisteredWorkspace {
  workspaceId: string;
  root: string;
  name: string;
  registeredAt: string;
  lastHealthyAt: string;
  revokedAt?: string;
}

export interface RouteCapability {
  id: string;
  tokenHash: string;
  workspaceId: string;
  taskId: string;
  conversationId: string;
  /** Present only for a recoverable BOOT preparation. Never contains the token. */
  preparationId?: string;
  issuedAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface RouterState {
  version: 1;
  anchor: RegisteredWorkspace;
  workspaces: RegisteredWorkspace[];
  capabilities: RouteCapability[];
  savedAt: string;
}

export interface IssuedRouteCapability {
  id: string;
  token: string;
  workspaceId: string;
  taskId: string;
  conversationId: string;
}

/** In-memory secret material. Callers must persist it only in a private BOOT material file. */
export interface RouteCapabilityDraft {
  id: string;
  token: string;
}

/** A persisted Router capability whose token is intentionally never returned. */
export interface RegisteredBootCapability {
  id: string;
  workspaceId: string;
  taskId: string;
  conversationId: string;
  preparationId: string;
}

export interface ResolvedRouteCapability {
  capability: RouteCapability;
  workspace: Workspace;
}

const ROUTER_LOCK_ID = "router-global";
const ROUTE_TOKEN_PREFIX = "c2c_route_";
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{2,127}$/u;

export function routerStateFile(): string {
  return path.join(getStateDir(), "router", "state.json");
}

function routeTokenHash(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function safeHashEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

function validTaskId(value: string): string {
  const taskId = value.trim();
  if (!TASK_ID_PATTERN.test(taskId)) throw new Error("route task id is invalid");
  return taskId;
}

function validConversationId(value: string): string {
  const conversationId = value.trim();
  if (!CONVERSATION_ID_PATTERN.test(conversationId)) throw new Error("route conversation id is invalid");
  return conversationId;
}

function recordFor(workspace: Workspace, now = new Date().toISOString()): RegisteredWorkspace {
  return {
    workspaceId: workspace.id,
    root: workspace.root,
    name: workspace.name,
    registeredAt: now,
    lastHealthyAt: now,
  };
}

function isRegisteredWorkspace(value: unknown): value is RegisteredWorkspace {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<RegisteredWorkspace>;
  return typeof input.workspaceId === "string" && typeof input.root === "string" &&
    typeof input.name === "string" && typeof input.registeredAt === "string" &&
    typeof input.lastHealthyAt === "string";
}

function isCapability(value: unknown): value is RouteCapability {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<RouteCapability>;
  return typeof input.id === "string" && typeof input.tokenHash === "string" &&
    typeof input.workspaceId === "string" && typeof input.taskId === "string" &&
    typeof input.conversationId === "string" &&
    (input.preparationId === undefined || typeof input.preparationId === "string") &&
    typeof input.issuedAt === "string" &&
    (input.expiresAt === undefined || typeof input.expiresAt === "string");
}

function isRouterState(value: unknown): value is RouterState {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<RouterState>;
  return input.version === 1 && isRegisteredWorkspace(input.anchor) &&
    Array.isArray(input.workspaces) && input.workspaces.every(isRegisteredWorkspace) &&
    Array.isArray(input.capabilities) && input.capabilities.every(isCapability);
}

function readRouterState(): RouterState | null {
  const value = readJsonIfExists<unknown>(routerStateFile());
  if (!isRouterState(value)) return null;
  return normalizeRouterState(value);
}

function normalizeRouterState(value: RouterState): RouterState {
  // Version-1 Router snapshots written before expiry metadata remain readable,
  // but their old capabilities are expired rather than silently reactivated.
  return {
    ...value,
    capabilities: value.capabilities.map((capability) => ({
      ...capability,
      expiresAt: capability.expiresAt ?? capability.issuedAt,
    })),
  };
}

function writeRouterState(state: RouterState): RouterState {
  writeSecureJson(routerStateFile(), state);
  return state;
}

function requireRouterState(): RouterState {
  const state = readRouterState();
  if (!state) throw new Error("global workspace router is not initialized");
  return state;
}

function assertAnchor(state: RouterState, anchor: Workspace): void {
  if (state.anchor.workspaceId !== anchor.id || path.resolve(state.anchor.root) !== anchor.root) {
    throw new Error("global workspace router is anchored to another workspace");
  }
}

async function registerWorkspace(root: string): Promise<RegisteredWorkspace> {
  const workspace = new Workspace(root);
  return withWorkspaceLifecycleLock(ROUTER_LOCK_ID, async () => {
    const state = requireRouterState();
    const now = new Date().toISOString();
    const current = state.workspaces.find((entry) => entry.workspaceId === workspace.id);
    const next: RegisteredWorkspace = current
      ? {
          ...current,
          root: workspace.root,
          name: workspace.name,
          lastHealthyAt: now,
          revokedAt: undefined,
        }
      : recordFor(workspace, now);
    writeRouterState({
      ...state,
      workspaces: [...state.workspaces.filter((entry) => entry.workspaceId !== workspace.id), next],
      savedAt: now,
    });
    return next;
  });
}

export interface WorkspaceRouter {
  read(): Promise<RouterState>;
  register(root: string): Promise<RegisteredWorkspace>;
}

export async function createWorkspaceRouter(anchorRoot: string): Promise<WorkspaceRouter> {
  const anchor = new Workspace(anchorRoot);
  await withWorkspaceLifecycleLock(ROUTER_LOCK_ID, async () => {
    const existing = readRouterState();
    if (existing) {
      assertAnchor(existing, anchor);
      return;
    }
    const now = new Date().toISOString();
    const anchorRecord = recordFor(anchor, now);
    writeRouterState({
      version: 1,
      anchor: anchorRecord,
      workspaces: [anchorRecord],
      capabilities: [],
      savedAt: now,
    });
  });
  return {
    read: async () => requireRouterState(),
    register: registerWorkspace,
  };
}

export async function issueRouteCapability(input: {
  workspaceId: string;
  taskId: string;
  conversationId: string;
  /** A capability is renewable, but never indefinite. Defaults to one year. */
  expiresAt?: string;
}): Promise<IssuedRouteCapability> {
  const workspaceId = input.workspaceId.trim();
  const taskId = validTaskId(input.taskId);
  const conversationId = validConversationId(input.conversationId);
  assertTaskConversationOwner(workspaceId, taskId, conversationId);
  return withWorkspaceLifecycleLock(ROUTER_LOCK_ID, async () => {
    const state = requireRouterState();
    const workspace = state.workspaces.find((entry) => entry.workspaceId === workspaceId && !entry.revokedAt);
    if (!workspace) throw new Error("route workspace is not registered");
    const token = `${ROUTE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new Error("route capability expiry must be in the future");
    }
    const capability: RouteCapability = {
      id: `c2c_route_id_${randomUUID()}`,
      tokenHash: routeTokenHash(token),
      workspaceId,
      taskId,
      conversationId,
      issuedAt: now,
      expiresAt: expiresAt.toISOString(),
    };
    writeRouterState({ ...state, capabilities: [...state.capabilities, capability], savedAt: now });
    return { id: capability.id, token, workspaceId, taskId, conversationId };
  });
}

/**
 * Generate a capability secret without registering it. The only supported
 * caller is the BOOT preparation transaction, which writes the exact BOOT
 * body to private storage before this capability can enter Router state.
 */
export function createRouteCapabilityDraft(): RouteCapabilityDraft {
  return {
    id: `c2c_route_id_${randomUUID()}`,
    token: `${ROUTE_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`,
  };
}

/**
 * Register an idempotent BOOT capability prepared in private material.
 * It deliberately does not call session ownership while holding Router's
 * lock. Until the session transaction attaches the id, resolveRouteCapability
 * rejects it, so an interrupted registration is inert.
 */
export async function registerBootRouteCapability(input: {
  id: string;
  token: string;
  workspaceId: string;
  taskId: string;
  conversationId: string;
  preparationId: string;
  expiresAt?: string;
}): Promise<RegisteredBootCapability> {
  const id = input.id.trim();
  const token = input.token.trim();
  const workspaceId = input.workspaceId.trim();
  const taskId = validTaskId(input.taskId);
  const conversationId = validConversationId(input.conversationId);
  const preparationId = input.preparationId.trim();
  if (!/^c2c_route_id_[0-9a-f-]{36}$/u.test(id) || !/^c2c_boot_[0-9a-f-]{36}$/u.test(preparationId) ||
    !token.startsWith(ROUTE_TOKEN_PREFIX) || token.length < ROUTE_TOKEN_PREFIX.length + 32) {
    throw new Error("BOOT_CAPABILITY_MATERIAL_INVALID");
  }
  return withWorkspaceLifecycleLock(ROUTER_LOCK_ID, async () => {
    const state = requireRouterState();
    const workspace = state.workspaces.find((entry) => entry.workspaceId === workspaceId && !entry.revokedAt);
    if (!workspace) throw new Error("route workspace is not registered");
    const tokenHash = routeTokenHash(token);
    const existing = state.capabilities.find((entry) => entry.id === id);
    if (existing) {
      if (existing.tokenHash !== tokenHash || existing.workspaceId !== workspaceId || existing.taskId !== taskId ||
        existing.conversationId !== conversationId || existing.preparationId !== preparationId) {
        throw new Error("BOOT_CAPABILITY_CONFLICT");
      }
      if (existing.revokedAt) throw new Error("BOOT_CAPABILITY_REVOKED");
      return { id, workspaceId, taskId, conversationId, preparationId };
    }
    const now = new Date().toISOString();
    const expiresAt = input.expiresAt ? new Date(input.expiresAt) : new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= Date.now()) {
      throw new Error("route capability expiry must be in the future");
    }
    const capability: RouteCapability = {
      id,
      tokenHash,
      workspaceId,
      taskId,
      conversationId,
      preparationId,
      issuedAt: now,
      expiresAt: expiresAt.toISOString(),
    };
    writeRouterState({ ...state, capabilities: [...state.capabilities, capability], savedAt: now });
    return { id, workspaceId, taskId, conversationId, preparationId };
  });
}

/** Revoke superseded route capabilities after the matching session attachment commits. */
export async function revokeSupersededTaskRoutes(input: {
  taskId: string;
  conversationId: string;
  keepCapabilityId: string;
}): Promise<void> {
  const taskId = validTaskId(input.taskId);
  const conversationId = validConversationId(input.conversationId);
  const keep = input.keepCapabilityId.trim();
  if (!/^c2c_route_id_[0-9a-f-]{36}$/u.test(keep)) throw new Error("route capability id is invalid");
  await withWorkspaceLifecycleLock(ROUTER_LOCK_ID, async () => {
    const state = requireRouterState();
    const now = new Date().toISOString();
    let changed = false;
    const capabilities = state.capabilities.map((entry) => {
      if (entry.id === keep || entry.revokedAt || entry.taskId !== taskId || entry.conversationId !== conversationId) return entry;
      changed = true;
      return { ...entry, revokedAt: now };
    });
    if (changed) writeRouterState({ ...state, capabilities, savedAt: now });
  });
}

export async function resolveRouteCapability(tokenInput: string): Promise<ResolvedRouteCapability> {
  const token = tokenInput.trim();
  if (!token.startsWith(ROUTE_TOKEN_PREFIX) || token.length < ROUTE_TOKEN_PREFIX.length + 32) {
    throw new Error("ROUTE_ACCESS_DENIED");
  }
  const hash = routeTokenHash(token);
  const state = requireRouterState();
  const capability = state.capabilities.find(
    (entry) => !entry.revokedAt && Date.parse(entry.expiresAt) > Date.now() && safeHashEqual(entry.tokenHash, hash)
  );
  if (!capability) throw new Error("ROUTE_ACCESS_DENIED");
  try {
    const task = assertTaskConversationOwner(capability.workspaceId, capability.taskId, capability.conversationId);
    if (task.routeCapabilityId !== capability.id) throw new Error("ROUTE_ACCESS_DENIED");
  } catch {
    throw new Error("ROUTE_ACCESS_DENIED");
  }
  const registration = state.workspaces.find((entry) => entry.workspaceId === capability.workspaceId && !entry.revokedAt);
  if (!registration) throw new Error("ROUTE_ACCESS_DENIED");
  let workspace: Workspace;
  try {
    workspace = new Workspace(registration.root);
  } catch {
    throw new Error("ROUTE_ACCESS_DENIED");
  }
  if (workspace.id !== registration.workspaceId) throw new Error("ROUTE_ACCESS_DENIED");
  return { capability, workspace };
}

export async function revokeWorkspaceRoutes(workspaceIdInput: string): Promise<void> {
  const workspaceId = workspaceIdInput.trim();
  await withWorkspaceLifecycleLock(ROUTER_LOCK_ID, async () => {
    const state = requireRouterState();
    const now = new Date().toISOString();
    writeRouterState({
      ...state,
      workspaces: state.workspaces.map((entry) => entry.workspaceId === workspaceId ? { ...entry, revokedAt: now } : entry),
      capabilities: state.capabilities.map((entry) => entry.workspaceId === workspaceId ? { ...entry, revokedAt: now } : entry),
      savedAt: now,
    });
  });
}

export function readWorkspaceRouter(): RouterState | null {
  return readRouterState();
}

export class RouterDiagnosticError extends Error {
  constructor(readonly errorClass: "router_state_invalid" | "router_state_unavailable") {
    super(errorClass);
  }
}

/** Only a missing file means legacy mode; ambiguous authority must not enable repair. */
export function readWorkspaceRouterForDiagnostics(): RouterState | null {
  let text: string;
  try {
    text = fs.readFileSync(routerStateFile(), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new RouterDiagnosticError("router_state_unavailable");
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new RouterDiagnosticError("router_state_invalid"); }
  if (!isRouterState(value) ||
      new Set(value.workspaces.map(entry => entry.workspaceId)).size !== value.workspaces.length ||
      value.workspaces.some(entry => entry.revokedAt !== undefined &&
        (typeof entry.revokedAt !== "string" || !entry.revokedAt.trim()))) {
    throw new RouterDiagnosticError("router_state_invalid");
  }
  return normalizeRouterState(value);
}
