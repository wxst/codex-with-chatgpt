import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";
import { getStateDir, readJsonIfExists, writeSecureJson } from "../config/paths.js";
import { withWorkspaceLifecycleLock } from "../process/workspace-lock.js";
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
    typeof input.conversationId === "string" && typeof input.issuedAt === "string" &&
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
