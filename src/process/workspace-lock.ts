import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateSubdir } from "../config/paths.js";

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
  release(): void;
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace id for lifecycle lock");
  }
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
      typeof value.acquiredAt !== "string"
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

function tryReclaimStaleLock(lockDir: string, orphanGraceMs: number): boolean {
  const owner = readOwner(lockDir);
  if (owner) {
    if (processExists(owner.pid)) return false;
    try {
      fs.rmSync(lockDir, { recursive: true, force: true });
      return true;
    } catch {
      return false;
    }
  }

  // mkdir and owner-file creation are separate syscalls. A missing owner file
  // can therefore be a lock that is still being initialized. Only reclaim an
  // ownerless directory after a generous grace period.
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
  const orphanGraceMs = options.orphanGraceMs ?? 10_000;
  const lockDir = path.join(stateSubdir("locks"), `${workspaceId}.lifecycle.lock`);
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
