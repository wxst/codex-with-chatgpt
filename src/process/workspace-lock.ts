import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateSubdir } from "../config/paths.js";

export const LIFECYCLE_LOCK_NONCE_ENV = "C2C_LIFECYCLE_LOCK_NONCE";
export const LIFECYCLE_LOCK_WORKSPACE_ENV = "C2C_LIFECYCLE_LOCK_WORKSPACE";

interface LockOwner {
  pid: number;
  nonce: string;
  acquiredAt: string;
}

export interface WorkspaceLifecycleLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  orphanGraceMs?: number;
}

export interface WorkspaceLifecycleLock {
  /** Opaque proof passed only to a child startup process spawned under this lock. */
  nonce: string;
  release(): void;
}

const DEFAULT_ORPHAN_GRACE_MS = 30_000;

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace id for lifecycle lock");
  }
}

function lockDirectory(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return path.join(stateSubdir("locks"), `${workspaceId}.lifecycle.lock`);
}

function ownerFile(lockDir: string): string {
  return path.join(lockDir, "owner.json");
}

function readOwner(lockDir: string): LockOwner | null {
  try {
    const value = JSON.parse(fs.readFileSync(ownerFile(lockDir), "utf8")) as Partial<LockOwner>;
    if (
      !Number.isSafeInteger(value.pid) ||
      (value.pid ?? 0) <= 0 ||
      typeof value.nonce !== "string" ||
      value.nonce.length < 8 ||
      typeof value.acquiredAt !== "string" ||
      !Number.isFinite(Date.parse(value.acquiredAt))
    ) {
      return null;
    }
    return value as LockOwner;
  } catch {
    return null;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function ownerAgeMs(owner: LockOwner): number {
  return Math.max(0, Date.now() - Date.parse(owner.acquiredAt));
}

/**
 * Verify an inherited startup nonce without trusting an environment variable by
 * itself. A dead parent remains a valid owner only during the startup grace
 * window, which is longer than ensureBridge's normal 20 second startup wait.
 */
export function isWorkspaceLifecycleLockHeldBy(
  workspaceId: string,
  nonce: string,
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS
): boolean {
  if (!nonce) return false;
  const owner = readOwner(lockDirectory(workspaceId));
  if (!owner || owner.nonce !== nonce) return false;
  if (processExists(owner.pid)) return true;
  return ownerAgeMs(owner) < orphanGraceMs;
}

function tryReclaimStaleLock(lockDir: string, orphanGraceMs: number): boolean {
  const owner = readOwner(lockDir);
  if (owner) {
    if (processExists(owner.pid)) return false;

    // A parent can die immediately after spawning the bridge but before the
    // child publishes runtime state. Preserve the dead owner's lock for a full
    // startup window so unpair/another starter cannot enter that gap.
    if (ownerAgeMs(owner) < orphanGraceMs) return false;

    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  // mkdir and owner-file creation are separate syscalls. A missing owner file
  // can therefore be a lock that is still being initialized. Only reclaim an
  // ownerless directory after the same generous grace period.
  try {
    const ageMs = Date.now() - fs.statSync(lockDir).mtimeMs;
    if (ageMs < orphanGraceMs) return false;
    fs.rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

export async function acquireWorkspaceLifecycleLock(
  workspaceId: string,
  options: WorkspaceLifecycleLockOptions = {}
): Promise<WorkspaceLifecycleLock> {
  assertWorkspaceId(workspaceId);
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 50;
  const orphanGraceMs = options.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const lockDir = lockDirectory(workspaceId);
  const nonce = randomUUID();
  const deadline = Date.now() + timeoutMs;

  while (true) {
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(
        ownerFile(lockDir),
        JSON.stringify({ pid: process.pid, nonce, acquiredAt: new Date().toISOString() } satisfies LockOwner),
        { mode: 0o600, flag: "wx" }
      );
      try {
        fs.chmodSync(lockDir, 0o700);
        fs.chmodSync(ownerFile(lockDir), 0o600);
      } catch {
        // Windows ACLs do not reliably map to POSIX mode bits.
      }

      let released = false;
      return {
        nonce,
        release(): void {
          if (released) return;
          released = true;
          const current = readOwner(lockDir);
          if (!current || current.nonce !== nonce || current.pid !== process.pid) return;
          fs.rmSync(lockDir, { recursive: true, force: true });
        },
      };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST") {
        // If owner-file creation failed after mkdir, remove only the directory
        // that still has no valid owner. Never disturb an established lock.
        const current = readOwner(lockDir);
        if (!current) {
          try {
            fs.rmSync(lockDir, { recursive: true, force: true });
          } catch {
            // Preserve the original error.
          }
        }
        throw error;
      }
    }

    if (tryReclaimStaleLock(lockDir, orphanGraceMs)) continue;
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for workspace lifecycle lock: ${workspaceId}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

export async function withWorkspaceLifecycleLock<T>(
  workspaceId: string,
  fn: () => Promise<T>,
  options: WorkspaceLifecycleLockOptions = {}
): Promise<T> {
  const lock = await acquireWorkspaceLifecycleLock(workspaceId, options);
  try {
    return await fn();
  } finally {
    lock.release();
  }
}
