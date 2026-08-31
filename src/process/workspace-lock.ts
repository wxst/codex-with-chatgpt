import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateSubdir } from "../config/paths.js";

export const LIFECYCLE_LOCK_NONCE_ENV = "C2C_LIFECYCLE_LOCK_NONCE";
export const LIFECYCLE_LOCK_WORKSPACE_ENV = "C2C_LIFECYCLE_LOCK_WORKSPACE";
export const RECLAIM_FILE = ".reclaim.json";

interface LockOwner {
  pid: number;
  nonce: string;
  acquiredAt: string;
}

interface ReclaimClaim {
  expectedNonce: string | null;
  claimantNonce: string;
  claimedAt: string;
}

interface LockGenerationSnapshot {
  owner: LockOwner | null;
  dirDev: number;
  dirIno: number;
  dirBirthtimeMs: number;
  leaseMtimeMs: number;
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
const DEFAULT_HEARTBEAT_MS = 1_000;

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

function reclaimFile(lockDir: string): string {
  return path.join(lockDir, RECLAIM_FILE);
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

function readReclaimClaim(lockDir: string): ReclaimClaim | null {
  try {
    const value = JSON.parse(fs.readFileSync(reclaimFile(lockDir), "utf8")) as Partial<ReclaimClaim>;
    if (
      (value.expectedNonce !== null && typeof value.expectedNonce !== "string") ||
      typeof value.claimantNonce !== "string" ||
      value.claimantNonce.length < 8 ||
      typeof value.claimedAt !== "string" ||
      !Number.isFinite(Date.parse(value.claimedAt))
    ) {
      return null;
    }
    return value as ReclaimClaim;
  } catch {
    return null;
  }
}

function leaseMtimeMs(lockDir: string, owner: LockOwner | null): number {
  try {
    return owner ? fs.statSync(ownerFile(lockDir)).mtimeMs : fs.statSync(lockDir).mtimeMs;
  } catch {
    return 0;
  }
}

function leaseIsFresh(lockDir: string, owner: LockOwner | null, graceMs: number): boolean {
  const mtimeMs = leaseMtimeMs(lockDir, owner);
  return mtimeMs > 0 && Date.now() - mtimeMs < graceMs;
}

function snapshotGeneration(lockDir: string): LockGenerationSnapshot | null {
  try {
    const dir = fs.statSync(lockDir);
    const owner = readOwner(lockDir);
    return {
      owner,
      dirDev: dir.dev,
      dirIno: dir.ino,
      dirBirthtimeMs: dir.birthtimeMs,
      leaseMtimeMs: leaseMtimeMs(lockDir, owner),
    };
  } catch {
    return null;
  }
}

function sameDirectoryGeneration(lockDir: string, observed: LockGenerationSnapshot): boolean {
  try {
    const current = fs.statSync(lockDir);
    return (
      current.dev === observed.dirDev &&
      current.ino === observed.dirIno &&
      current.birthtimeMs === observed.dirBirthtimeMs
    );
  } catch {
    return false;
  }
}

function removeReclaimIfOwned(lockDir: string, claimantNonce: string): void {
  const claim = readReclaimClaim(lockDir);
  if (!claim || claim.claimantNonce !== claimantNonce) return;
  try {
    fs.unlinkSync(reclaimFile(lockDir));
  } catch {
    // Another actor may already have moved/reclaimed this generation.
  }
}

function reclaimClaimIsStale(lockDir: string, graceMs: number): boolean {
  try {
    return Date.now() - fs.statSync(reclaimFile(lockDir)).mtimeMs >= graceMs;
  } catch {
    return false;
  }
}

function tryCreateReclaimClaim(
  lockDir: string,
  expectedNonce: string | null,
  graceMs: number
): string | null {
  const claimantNonce = randomUUID();
  const claim: ReclaimClaim = {
    expectedNonce,
    claimantNonce,
    claimedAt: new Date().toISOString(),
  };

  try {
    fs.writeFileSync(reclaimFile(lockDir), JSON.stringify(claim), { mode: 0o600, flag: "wx" });
    try {
      fs.chmodSync(reclaimFile(lockDir), 0o600);
    } catch {
      // Windows ACLs do not reliably map to POSIX mode bits.
    }
    return claimantNonce;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return null;
    if (code !== "EEXIST") throw error;
  }

  // A reclaimer can itself crash. After a full lease interval, another waiter
  // may clear only that exact reclaim claim and retry. The original claimant
  // rechecks ownership before rename, so a resumed stale claimant cannot act.
  const existing = readReclaimClaim(lockDir);
  if (existing && reclaimClaimIsStale(lockDir, graceMs)) {
    removeReclaimIfOwned(lockDir, existing.claimantNonce);
  }
  return null;
}

function reclaimClaimStillOwned(lockDir: string, claimantNonce: string): boolean {
  return readReclaimClaim(lockDir)?.claimantNonce === claimantNonce;
}

function refreshOwnerHeartbeat(lockDir: string, nonce: string): boolean {
  const current = readOwner(lockDir);
  if (!current || current.nonce !== nonce || current.pid !== process.pid) return false;

  // Once a stale takeover has an exclusive claim, stop renewing the old lease.
  // Keep the timer alive so it can resume if the claimant aborts and removes
  // its marker after discovering a generation mismatch/fresh heartbeat.
  if (fs.existsSync(reclaimFile(lockDir))) return true;

  try {
    const now = new Date();
    fs.utimesSync(ownerFile(lockDir), now, now);
    return true;
  } catch {
    return false;
  }
}

/**
 * Verify an inherited startup nonce against the current lock generation and its
 * heartbeat lease. PID existence is intentionally not used as ownership proof:
 * PIDs can be reused by unrelated processes, while the nonce+heartbeat pair is
 * unique to this lock generation.
 */
export function isWorkspaceLifecycleLockHeldBy(
  workspaceId: string,
  nonce: string,
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS
): boolean {
  if (!nonce) return false;
  const lockDir = lockDirectory(workspaceId);
  const owner = readOwner(lockDir);
  if (!owner || owner.nonce !== nonce) return false;
  if (fs.existsSync(reclaimFile(lockDir))) return false;
  return leaseIsFresh(lockDir, owner, orphanGraceMs);
}

function tryReclaimStaleLock(lockDir: string, orphanGraceMs: number): boolean {
  const observed = snapshotGeneration(lockDir);
  if (!observed) return true;
  if (Date.now() - observed.leaseMtimeMs < orphanGraceMs) return false;

  const expectedNonce = observed.owner?.nonce ?? null;
  const claimantNonce = tryCreateReclaimClaim(lockDir, expectedNonce, orphanGraceMs);
  if (!claimantNonce) return false;

  try {
    // The exclusive marker is only a right to inspect/reclaim the generation we
    // observed. It is not permission to delete whatever later appears at the
    // same pathname. Bind takeover to directory identity and owner nonce.
    if (!reclaimClaimStillOwned(lockDir, claimantNonce)) return false;
    if (!sameDirectoryGeneration(lockDir, observed)) return false;

    const current = readOwner(lockDir);
    if (expectedNonce === null) {
      if (current !== null) return false;
    } else {
      if (!current || current.nonce !== observed.owner?.nonce) return false;
      // Keep this exact expression covered by regression tests: a waiter that
      // observes an old generation must never delete a newer owner.
      if (current.nonce !== observed.owner.nonce) return false;
      if (leaseIsFresh(lockDir, current, orphanGraceMs)) return false;
    }

    if (!reclaimClaimStillOwned(lockDir, claimantNonce)) return false;

    // Release observes RECLAIM_FILE and will not remove/replace this directory,
    // so once the marker is ours the pathname cannot legitimately switch to a
    // new lock generation between this verification and the atomic rename.
    const quarantine = `${lockDir}.reclaimed-${expectedNonce ?? "ownerless"}-${claimantNonce}`;
    try {
      fs.renameSync(lockDir, quarantine);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "EEXIST" || code === "ENOTEMPTY") return false;
      throw error;
    }

    try {
      fs.rmSync(quarantine, { recursive: true, force: true });
    } catch {
      // The active lock pathname is already free. A leftover quarantine has a
      // generation-specific name and cannot be mistaken for the live lock.
    }
    return true;
  } finally {
    removeReclaimIfOwned(lockDir, claimantNonce);
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
  const heartbeatMs = Math.max(10, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(orphanGraceMs / 4)));
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
      const heartbeat = setInterval(() => {
        if (!refreshOwnerHeartbeat(lockDir, nonce)) clearInterval(heartbeat);
      }, heartbeatMs);
      heartbeat.unref();

      return {
        nonce,
        release(): void {
          if (released) return;
          released = true;
          clearInterval(heartbeat);
          const current = readOwner(lockDir);
          if (!current || current.nonce !== nonce || current.pid !== process.pid) return;

          // A generation-safe reclaimer has fenced this owner. Do not remove the
          // directory and create a pathname-reuse race underneath its takeover.
          if (fs.existsSync(reclaimFile(lockDir))) return;
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
