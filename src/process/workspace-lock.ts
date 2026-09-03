import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateSubdir } from "../config/paths.js";
import {
  processGenerationStatus,
  requireCurrentProcessGeneration,
} from "./process-identity.js";

export interface WorkspaceLifecycleTicket {
  pid: number;
  processGeneration: string | null;
  nonce: string;
  number: number;
  choosing: boolean;
  acquired: boolean;
  createdAt: string;
}

interface TicketEntry {
  file: string;
  mtimeMs: number;
  ticket: WorkspaceLifecycleTicket | null;
}

interface ActiveLifecycleOwner {
  workspaceId: string;
  nonce: string;
  pid: number;
  processGeneration: string;
  number: number;
  stateRoot: string;
}

export interface WorkspaceLifecycleLockOptions {
  timeoutMs?: number;
  pollMs?: number;
  orphanGraceMs?: number;
}

export interface WorkspaceLifecycleLock {
  nonce: string;
  release(): void;
}

export const DEFAULT_LIFECYCLE_ORPHAN_GRACE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const TICKET_SUFFIX = ".ticket.json";
const WINDOWS_RENAME_RETRY_DELAYS_MS = [2, 4, 8, 16, 32, 64] as const;
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const activeLifecycleOwners = new Map<string, ActiveLifecycleOwner>();

function normalizedStateRoot(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function renameTicketWithRetry(temp: string, file: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        process.platform !== "win32" ||
        !WINDOWS_TRANSIENT_RENAME_CODES.has(code) ||
        attempt >= WINDOWS_RENAME_RETRY_DELAYS_MS.length
      ) {
        throw error;
      }
      const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      Atomics.wait(signal, 0, 0, WINDOWS_RENAME_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function assertWorkspaceId(workspaceId: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace id for lifecycle lock");
  }
}

function assertNonce(nonce: string): void {
  if (!/^[A-Za-z0-9_-]{8,}$/.test(nonce)) {
    throw new Error("Invalid lifecycle ticket nonce");
  }
}

function ticketPrefix(workspaceId: string): string {
  assertWorkspaceId(workspaceId);
  return `${workspaceId}.lifecycle.`;
}

function ticketNonceFromFile(workspaceId: string, file: string): string | null {
  const prefix = ticketPrefix(workspaceId);
  const name = path.basename(file);
  if (!name.startsWith(prefix) || !name.endsWith(TICKET_SUFFIX)) return null;
  const nonce = name.slice(prefix.length, -TICKET_SUFFIX.length);
  return /^[A-Za-z0-9_-]{8,}$/.test(nonce) ? nonce : null;
}

function ticketContentMatchesFile(workspaceId: string, entry: TicketEntry): boolean {
  const filenameNonce = ticketNonceFromFile(workspaceId, entry.file);
  return Boolean(entry.ticket && filenameNonce && entry.ticket.nonce === filenameNonce);
}

export function lifecycleTicketFile(workspaceId: string, nonce: string): string {
  return lifecycleTicketFileInDirectory(stateSubdir("locks"), workspaceId, nonce);
}

function lifecycleTicketFileInDirectory(
  locksDirectory: string,
  workspaceId: string,
  nonce: string
): string {
  const prefix = ticketPrefix(workspaceId);
  assertNonce(nonce);
  return path.join(locksDirectory, `${prefix}${nonce}${TICKET_SUFFIX}`);
}

export function parseWorkspaceLifecycleTicket(
  content: string
): WorkspaceLifecycleTicket | null {
  try {
    const value = JSON.parse(content) as Partial<WorkspaceLifecycleTicket>;
    const pid = value.pid;
    const nonce = value.nonce;
    const ticketNumber = value.number;
    const createdAt = value.createdAt;
    if (
      typeof pid !== "number" ||
      !Number.isSafeInteger(pid) ||
      pid <= 0 ||
      typeof nonce !== "string" ||
      !/^[A-Za-z0-9_-]{8,}$/.test(nonce) ||
      typeof ticketNumber !== "number" ||
      !Number.isSafeInteger(ticketNumber) ||
      ticketNumber < 0 ||
      typeof createdAt !== "string" ||
      !Number.isFinite(Date.parse(createdAt))
    ) {
      return null;
    }

    if (
      (value.choosing !== undefined && typeof value.choosing !== "boolean") ||
      (value.acquired !== undefined && typeof value.acquired !== "boolean")
    ) {
      return null;
    }

    const choosing = value.choosing ?? ticketNumber === 0;
    const acquired = value.acquired ?? ticketNumber > 0;
    if (
      (choosing && (ticketNumber !== 0 || acquired)) ||
      (!choosing && ticketNumber === 0) ||
      (acquired && (choosing || ticketNumber <= 0))
    ) {
      return null;
    }

    if (
      value.processGeneration !== undefined &&
      value.processGeneration !== null &&
      (typeof value.processGeneration !== "string" || value.processGeneration.length === 0)
    ) {
      return null;
    }
    const processGeneration = value.processGeneration ?? null;

    return {
      pid,
      processGeneration,
      nonce,
      number: ticketNumber,
      choosing,
      acquired,
      createdAt,
    };
  } catch {
    return null;
  }
}

function ticketIsFresh(entry: TicketEntry, graceMs: number): boolean {
  const ticket = entry.ticket;
  if (ticket?.processGeneration) {
    const status = processGenerationStatus(ticket.pid, ticket.processGeneration);
    if (status === "match" || status === "unknown") return true;
  }
  return entry.mtimeMs > 0 && Date.now() - entry.mtimeMs < graceMs;
}

function sameTicketIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function readTicketEntry(file: string): TicketEntry | null {
  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    throw new Error(`Lifecycle ticket path is not a private regular file: ${file}`);
  }

  const constants = fs.constants as typeof fs.constants & {
    O_NOFOLLOW?: number;
    O_NONBLOCK?: number;
  };
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }

  let content: string;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameTicketIdentity(before, opened)) {
      throw new Error(`Lifecycle ticket changed while it was being opened: ${file}`);
    }
    content = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }

  let current: fs.BigIntStats;
  try {
    current = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1n ||
    !sameTicketIdentity(before, current)
  ) {
    throw new Error(`Lifecycle ticket changed while it was being inspected: ${file}`);
  }
  return {
    file,
    mtimeMs: Number(current.mtimeMs),
    ticket: parseWorkspaceLifecycleTicket(content),
  };
}

function listTicketsInDirectory(workspaceId: string, dir: string): TicketEntry[] {
  const prefix = ticketPrefix(workspaceId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }

  const entries: TicketEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(TICKET_SUFFIX)) continue;
    const file = path.join(dir, name);
    try {
      const entry = readTicketEntry(file);
      if (entry) entries.push(entry);
    } catch (error) {
      // The owner can release its unique ticket while another contender scans.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return entries;
}

function writeTicket(file: string, ticket: WorkspaceLifecycleTicket): void {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(fd, JSON.stringify(ticket), "utf8");
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
    renameTicketWithRetry(temp, file);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // preserve the original write failure
      }
    }
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // A successful rename already moved the temp path away.
    }
  }
}

function compareTickets(a: WorkspaceLifecycleTicket, b: WorkspaceLifecycleTicket): number {
  if (a.number !== b.number) return a.number - b.number;
  return a.nonce.localeCompare(b.nonce);
}

function refreshTicket(file: string, expected: WorkspaceLifecycleTicket): boolean {
  let descriptor: number | null = null;
  try {
    if (!path.basename(file).endsWith(`.lifecycle.${expected.nonce}${TICKET_SUFFIX}`)) return false;
    const before = fs.lstatSync(file, { bigint: true });
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) return false;
    const constants = fs.constants as typeof fs.constants & {
      O_NOFOLLOW?: number;
      O_NONBLOCK?: number;
    };
    descriptor = fs.openSync(
      file,
      fs.constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      !sameTicketIdentity(before, opened) ||
      opened.size !== before.size ||
      opened.mtimeNs !== before.mtimeNs
    ) {
      return false;
    }
    const ticket = parseWorkspaceLifecycleTicket(fs.readFileSync(descriptor, "utf8"));
    if (
      !ticket ||
      ticket.nonce !== expected.nonce ||
      ticket.pid !== process.pid ||
      ticket.pid !== expected.pid ||
      !ticket.processGeneration ||
      ticket.processGeneration !== expected.processGeneration ||
      ticket.number !== expected.number ||
      ticket.choosing !== expected.choosing ||
      ticket.acquired !== expected.acquired ||
      ticket.createdAt !== expected.createdAt
    ) {
      return false;
    }

    // The owner heartbeat has no grace fallback: only the exact process
    // generation captured during acquisition may keep this ticket fresh.
    if (processGenerationStatus(ticket.pid, ticket.processGeneration) !== "match") return false;

    const current = fs.lstatSync(file, { bigint: true });
    const stillOpened = fs.fstatSync(descriptor, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      stillOpened.nlink !== 1n ||
      !sameTicketIdentity(before, current) ||
      !sameTicketIdentity(before, stillOpened) ||
      current.size !== before.size ||
      stillOpened.size !== before.size ||
      current.mtimeNs !== before.mtimeNs ||
      stillOpened.mtimeNs !== before.mtimeNs
    ) {
      return false;
    }

    const now = new Date();
    fs.futimesSync(descriptor, now, now);
    return true;
  } catch {
    return false;
  } finally {
    if (descriptor !== null) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // A failed close cannot make the ticket trustworthy again.
      }
    }
  }
}

function removeOwnTicket(file: string, nonce: string): void {
  try {
    const ticket = parseWorkspaceLifecycleTicket(fs.readFileSync(file, "utf8"));
    if (!ticket || ticket.nonce !== nonce) return;
    fs.unlinkSync(file);
  } catch {
    // Already released or removed by state cleanup outside this process.
  }
}

function ownTicketEntryInDirectory(
  locksDirectory: string,
  workspaceId: string,
  nonce: string
): TicketEntry | null {
  const file = lifecycleTicketFileInDirectory(locksDirectory, workspaceId, nonce);
  return readTicketEntry(file);
}

function isWorkspaceLifecycleLockHeldInDirectory(
  locksDirectory: string,
  workspaceId: string,
  nonce: string,
  orphanGraceMs: number
): boolean {
  if (!nonce) return false;
  const recordedOwner = activeLifecycleOwners.get(nonce);
  if (
    !recordedOwner ||
    recordedOwner.workspaceId !== workspaceId ||
    recordedOwner.nonce !== nonce ||
    recordedOwner.pid !== process.pid ||
    normalizedStateRoot(recordedOwner.stateRoot) !==
      normalizedStateRoot(path.dirname(locksDirectory))
  ) {
    return false;
  }
  const own = ownTicketEntryInDirectory(locksDirectory, workspaceId, nonce);
  if (
    !own ||
    !own.ticket ||
    own.ticket.nonce !== nonce ||
    own.ticket.pid !== recordedOwner.pid ||
    own.ticket.processGeneration !== recordedOwner.processGeneration ||
    own.ticket.number !== recordedOwner.number ||
    own.ticket.number <= 0 ||
    !own.ticket.acquired ||
    own.ticket.choosing
  ) {
    return false;
  }
  if (!own.ticket.processGeneration) return false;
  // The holder itself must positively prove identity before entering/resuming a
  // sensitive critical section. "unknown" fences the holder, while other
  // contenders still treat its ticket as active and remain blocked.
  if (processGenerationStatus(own.ticket.pid, own.ticket.processGeneration) !== "match") return false;

  for (const entry of listTicketsInDirectory(workspaceId, locksDirectory)) {
    if (!ticketIsFresh(entry, orphanGraceMs)) continue;
    if (!ticketContentMatchesFile(workspaceId, entry)) return false;

    const ticket = entry.ticket!;
    if (ticket.nonce === nonce) continue;
    if (ticket.choosing || ticket.number <= 0) return false;
    if (compareTickets(ticket, own.ticket) < 0) return false;
  }
  return true;
}

export function isWorkspaceLifecycleLockHeldBy(
  workspaceId: string,
  nonce: string,
  orphanGraceMs = DEFAULT_LIFECYCLE_ORPHAN_GRACE_MS
): boolean {
  try {
    return isWorkspaceLifecycleLockHeldInDirectory(
      stateSubdir("locks"),
      workspaceId,
      nonce,
      orphanGraceMs
    );
  } catch {
    return false;
  }
}

/**
 * Read-only ownership check for callers that have already validated an
 * existing state root. Unlike the normal helper, this never creates `locks/`.
 */
export function isWorkspaceLifecycleLockHeldByInStateRoot(
  stateRoot: string,
  workspaceId: string,
  nonce: string,
  orphanGraceMs = DEFAULT_LIFECYCLE_ORPHAN_GRACE_MS
): boolean {
  try {
    return isWorkspaceLifecycleLockHeldInDirectory(
      path.join(path.resolve(stateRoot), "locks"),
      workspaceId,
      nonce,
      orphanGraceMs
    );
  } catch {
    return false;
  }
}

export async function acquireWorkspaceLifecycleLock(
  workspaceId: string,
  options: WorkspaceLifecycleLockOptions = {}
): Promise<WorkspaceLifecycleLock> {
  assertWorkspaceId(workspaceId);
  const currentProcessGeneration = requireCurrentProcessGeneration();
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollMs = options.pollMs ?? 50;
  const orphanGraceMs = options.orphanGraceMs ?? DEFAULT_LIFECYCLE_ORPHAN_GRACE_MS;
  const heartbeatMs = Math.max(10, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(orphanGraceMs / 4)));
  const nonce = randomUUID();
  const locksDirectory = stateSubdir("locks");
  const stateRoot = path.dirname(locksDirectory);
  const file = lifecycleTicketFileInDirectory(locksDirectory, workspaceId, nonce);
  const deadline = Date.now() + timeoutMs;
  let heartbeat: NodeJS.Timeout | null = null;
  let released = false;

  const createdAt = new Date().toISOString();
  let ticket: WorkspaceLifecycleTicket = {
    pid: process.pid,
    processGeneration: currentProcessGeneration,
    nonce,
    number: 0,
    choosing: true,
    acquired: false,
    createdAt,
  };

  try {
    writeTicket(file, ticket);

    heartbeat = setInterval(() => {
      if (!refreshTicket(file, ticket) && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    }, heartbeatMs);
    heartbeat.unref();

    const initial = listTicketsInDirectory(workspaceId, locksDirectory).filter((entry) =>
      ticketIsFresh(entry, orphanGraceMs)
    );
    let maxNumber = 0;
    for (const entry of initial) {
      if (!ticketContentMatchesFile(workspaceId, entry)) continue;
      if (entry.ticket!.nonce === nonce) continue;
      if (entry.ticket!.number > maxNumber) maxNumber = entry.ticket!.number;
    }

    ticket = { ...ticket, number: maxNumber + 1, choosing: false };
    writeTicket(file, ticket);

    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace lifecycle lock: ${workspaceId}`);
      }

      const own = ownTicketEntryInDirectory(locksDirectory, workspaceId, nonce);
      if (
        !own ||
        !own.ticket ||
        own.ticket.nonce !== nonce ||
        own.ticket.pid !== process.pid ||
        own.ticket.processGeneration !== currentProcessGeneration ||
        own.ticket.number !== ticket.number ||
        !own.ticket.processGeneration
      ) {
        throw new Error(`Workspace lifecycle ticket lost process-generation ownership: ${workspaceId}`);
      }
      const ownStatus = processGenerationStatus(own.ticket.pid, own.ticket.processGeneration);
      if (ownStatus !== "match") {
        throw new Error(
          ownStatus === "unknown"
            ? `Workspace lifecycle ticket process identity is temporarily unavailable: ${workspaceId}`
            : `Workspace lifecycle ticket lost process-generation ownership: ${workspaceId}`
        );
      }
      ticket = own.ticket;

      let blocked = false;
      for (const entry of listTicketsInDirectory(workspaceId, locksDirectory)) {
        if (!ticketIsFresh(entry, orphanGraceMs)) continue;
        if (!ticketContentMatchesFile(workspaceId, entry)) {
          blocked = true;
          break;
        }
        const other = entry.ticket!;
        if (other.nonce === nonce) continue;
        if (other.choosing || other.number <= 0) {
          blocked = true;
          break;
        }
        if (compareTickets(other, ticket) < 0) {
          blocked = true;
          break;
        }
      }

      if (!blocked) {
        ticket = { ...ticket, acquired: true };
        writeTicket(file, ticket);
        activeLifecycleOwners.set(nonce, {
          workspaceId,
          nonce,
          pid: process.pid,
          processGeneration: currentProcessGeneration,
          number: ticket.number,
          stateRoot,
        });
        if (
          !isWorkspaceLifecycleLockHeldInDirectory(
            locksDirectory,
            workspaceId,
            nonce,
            orphanGraceMs
          )
        ) {
          activeLifecycleOwners.delete(nonce);
          ticket = { ...ticket, acquired: false };
          writeTicket(file, ticket);
          await new Promise((resolve) => setTimeout(resolve, pollMs));
          continue;
        }
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }

    return {
      nonce,
      release(): void {
        if (released) return;
        released = true;
        activeLifecycleOwners.delete(nonce);
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        removeOwnTicket(file, nonce);
      },
    };
  } catch (error) {
    activeLifecycleOwners.delete(nonce);
    if (heartbeat) clearInterval(heartbeat);
    removeOwnTicket(file, nonce);
    throw error;
  }
}

export async function withWorkspaceLifecycleLock<T>(
  workspaceId: string,
  fn: (lock: WorkspaceLifecycleLock) => Promise<T>,
  options: WorkspaceLifecycleLockOptions = {}
): Promise<T> {
  const lock = await acquireWorkspaceLifecycleLock(workspaceId, options);
  try {
    return await fn(lock);
  } finally {
    lock.release();
  }
}
