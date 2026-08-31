import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateSubdir } from "../config/paths.js";
import { requireCurrentProcessGeneration } from "./process-identity.js";

export interface PendingBridgeStart {
  workspaceId: string;
  startId: string;
  parentPid: number;
  parentProcessGeneration: string;
  createdAt: string;
}

const PENDING_SUFFIX = ".pending.json";

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace id for pending bridge start");
  }
}

function assertStartId(startId: string): void {
  if (!/^[A-Za-z0-9_-]{16,}$/.test(startId)) {
    throw new Error("Invalid pending bridge start id");
  }
}

function pendingPrefix(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return `${workspaceId}.`;
}

export function pendingStartFile(workspaceId: string, startId: string): string {
  assertWorkspaceId(workspaceId);
  assertStartId(startId);
  return path.join(stateSubdir("pending-starts"), `${workspaceId}.${startId}${PENDING_SUFFIX}`);
}

function parsePendingStart(content: string): PendingBridgeStart | null {
  try {
    const value = JSON.parse(content) as Partial<PendingBridgeStart>;
    if (
      typeof value.workspaceId !== "string" ||
      !/^[A-Za-z0-9._-]+$/.test(value.workspaceId) ||
      typeof value.startId !== "string" ||
      !/^[A-Za-z0-9_-]{16,}$/.test(value.startId) ||
      typeof value.parentPid !== "number" ||
      !Number.isSafeInteger(value.parentPid) ||
      value.parentPid <= 0 ||
      typeof value.parentProcessGeneration !== "string" ||
      value.parentProcessGeneration.length === 0 ||
      typeof value.createdAt !== "string" ||
      !Number.isFinite(Date.parse(value.createdAt))
    ) {
      return null;
    }
    return value as PendingBridgeStart;
  } catch {
    return null;
  }
}

function atomicPrivateWrite(file: string, value: unknown): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    if (process.platform !== "win32") {
      fs.fchmodSync(fd, 0o600);
    } else {
      try {
        fs.fchmodSync(fd, 0o600);
      } catch {
        // Windows ACL semantics do not reliably map to POSIX mode bits.
      }
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original failure.
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Successful rename already moved the temporary path away.
    }
  }
}

export function createPendingStart(workspaceId: string): PendingBridgeStart {
  assertWorkspaceId(workspaceId);
  const pending: PendingBridgeStart = {
    workspaceId,
    startId: randomUUID(),
    parentPid: process.pid,
    parentProcessGeneration: requireCurrentProcessGeneration(),
    createdAt: new Date().toISOString(),
  };
  atomicPrivateWrite(pendingStartFile(workspaceId, pending.startId), pending);
  return pending;
}

export function readPendingStart(workspaceId: string, startId: string): PendingBridgeStart | null {
  const file = pendingStartFile(workspaceId, startId);
  try {
    const pending = parsePendingStart(fs.readFileSync(file, "utf8"));
    if (!pending || pending.workspaceId !== workspaceId || pending.startId !== startId) return null;
    return pending;
  } catch {
    return null;
  }
}

/**
 * A detached child may start only if its exact parent-created intent still
 * exists. `unpair` cancels intents while holding the same lifecycle lock, so a
 * child delayed across revocation can never recreate credentials afterwards.
 */
export function requirePendingStart(workspaceId: string, startId: string): PendingBridgeStart {
  const pending = readPendingStart(workspaceId, startId);
  if (!pending) {
    throw new Error(`Pending bridge start was cancelled or is no longer valid: ${startId}`);
  }
  return pending;
}

export function completePendingStart(workspaceId: string, startId: string): void {
  const file = pendingStartFile(workspaceId, startId);
  try {
    const pending = parsePendingStart(fs.readFileSync(file, "utf8"));
    if (!pending || pending.workspaceId !== workspaceId || pending.startId !== startId) return;
    fs.rmSync(file, { force: true });
  } catch {
    // Leaving a completed intent behind is conservative: a later unpair will
    // insist on cancelling it before reporting quiescence.
  }
}

export function cancelPendingStart(workspaceId: string, startId: string): boolean {
  const file = pendingStartFile(workspaceId, startId);
  try {
    const pending = parsePendingStart(fs.readFileSync(file, "utf8"));
    if (!pending || pending.workspaceId !== workspaceId || pending.startId !== startId) return false;
    fs.rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** Security-sensitive enumeration: existing malformed/unreadable state fails closed. */
export function listPendingStarts(workspaceId: string): PendingBridgeStart[] {
  const dir = stateSubdir("pending-starts");
  const prefix = pendingPrefix(workspaceId);
  const names = fs.readdirSync(dir);
  const pending: PendingBridgeStart[] = [];

  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(PENDING_SUFFIX)) continue;
    const file = path.join(dir, name);
    let content: string;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch (error) {
      throw new Error(`Pending bridge start exists but cannot be read: ${file}`, { cause: error });
    }
    const value = parsePendingStart(content);
    if (!value || value.workspaceId !== workspaceId) {
      throw new Error(`Pending bridge start is malformed: ${file}`);
    }
    pending.push(value);
  }
  return pending;
}

/** Cancel every start intent for a workspace. Call while holding its lifecycle lock. */
export function cancelPendingStarts(workspaceId: string): number {
  const dir = stateSubdir("pending-starts");
  const prefix = pendingPrefix(workspaceId);
  const names = fs.readdirSync(dir);
  let cancelled = 0;

  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(PENDING_SUFFIX)) continue;
    const file = path.join(dir, name);
    try {
      fs.rmSync(file, { force: true });
      cancelled += 1;
    } catch (error) {
      throw new Error(`Failed to cancel pending bridge start: ${file}`, { cause: error });
    }
  }
  return cancelled;
}
