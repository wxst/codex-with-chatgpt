import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateSubdir } from "../config/paths.js";
import { getProcessGeneration, processGenerationMatches } from "./process-identity.js";

interface LifecycleTicket {
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
  ticket: LifecycleTicket | null;
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

const DEFAULT_ORPHAN_GRACE_MS = 30_000;
const DEFAULT_HEARTBEAT_MS = 1_000;
const TICKET_SUFFIX = ".ticket.json";

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

export function lifecycleTicketFile(workspaceId: string, nonce: string): string {
  const prefix = ticketPrefix(workspaceId);
  assertNonce(nonce);
  return path.join(stateSubdir("locks"), `${prefix}${nonce}${TICKET_SUFFIX}`);
}

function parseTicket(content: string): LifecycleTicket | null {
  try {
    const value = JSON.parse(content) as Partial<LifecycleTicket>;
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

    const processGeneration =
      typeof value.processGeneration === "string" && value.processGeneration.length > 0
        ? value.processGeneration
        : null;

    return {
      pid,
      processGeneration,
      nonce,
      number: ticketNumber,
      choosing: value.choosing ?? ticketNumber === 0,
      acquired: value.acquired ?? ticketNumber > 0,
      createdAt,
    };
  } catch {
    return null;
  }
}

function ticketIsFresh(entry: TicketEntry, graceMs: number): boolean {
  const ticket = entry.ticket;
  if (ticket?.processGeneration && processGenerationMatches(ticket.pid, ticket.processGeneration)) {
    return true;
  }
  return entry.mtimeMs > 0 && Date.now() - entry.mtimeMs < graceMs;
}

function listTickets(workspaceId: string): TicketEntry[] {
  const dir = stateSubdir("locks");
  const prefix = ticketPrefix(workspaceId);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }

  const entries: TicketEntry[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(TICKET_SUFFIX)) continue;
    const file = path.join(dir, name);
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) continue;
      entries.push({
        file,
        mtimeMs: stat.mtimeMs,
        ticket: parseTicket(fs.readFileSync(file, "utf8")),
      });
    } catch {
      // The owner can release its unique ticket while another contender scans.
    }
  }
  return entries;
}

/**
 * Publish a complete ticket generation with one same-directory atomic rename.
 * Readers therefore observe either the previous complete JSON object or the new
 * complete object, never a truncate/write intermediate state. Temporary files
 * deliberately do not end in TICKET_SUFFIX and are ignored by contenders.
 */
function writeTicket(file: string, ticket: LifecycleTicket): void {
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
    fs.renameSync(temp, file);
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

function compareTickets(a: LifecycleTicket, b: LifecycleTicket): number {
  if (a.number !== b.number) return a.number - b.number;
  return a.nonce.localeCompare(b.nonce);
}

function refreshTicket(file: string, nonce: string, graceMs: number): boolean {
  try {
    const stat = fs.statSync(file);
    const ticket = parseTicket(fs.readFileSync(file, "utf8"));
    if (!ticket || ticket.nonce !== nonce) return false;

    const sameGeneration =
      Boolean(ticket.processGeneration) && processGenerationMatches(ticket.pid, ticket.processGeneration!);
    if (!sameGeneration && Date.now() - stat.mtimeMs >= graceMs) return false;

    const now = new Date();
    fs.utimesSync(file, now, now);
    return true;
  } catch {
    return false;
  }
}

function removeOwnTicket(file: string, nonce: string): void {
  try {
    const ticket = parseTicket(fs.readFileSync(file, "utf8"));
    if (!ticket || ticket.nonce !== nonce) return;
    fs.unlinkSync(file);
  } catch {
    // Already released or removed by state cleanup outside this process.
  }
}

function ownTicketEntry(workspaceId: string, nonce: string): TicketEntry | null {
  const file = lifecycleTicketFile(workspaceId, nonce);
  try {
    const stat = fs.statSync(file);
    return {
      file,
      mtimeMs: stat.mtimeMs,
      ticket: parseTicket(fs.readFileSync(file, "utf8")),
    };
  } catch {
    return null;
  }
}

export function isWorkspaceLifecycleLockHeldBy(
  workspaceId: string,
  nonce: string,
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS
): boolean {
  if (!nonce) return false;
  const own = ownTicketEntry(workspaceId, nonce);
  if (!own || !own.ticket || !own.ticket.acquired || own.ticket.choosing) return false;
  if (!ticketIsFresh(own, orphanGraceMs)) return false;

  // This is the post-publication fence immediately before the critical section.
  // It must be at least as strict as the main wait loop: a contender that became
  // visible after our prior scan can still be choosing, or can have selected an
  // earlier ticket without having set acquired=true yet. Ignoring either state
  // allows two candidates to pass their final checks concurrently.
  for (const entry of listTickets(workspaceId)) {
    if (!ticketIsFresh(entry, orphanGraceMs)) continue;
    if (!entry.ticket) return false;

    const ticket = entry.ticket;
    if (ticket.nonce === nonce) continue;
    if (ticket.choosing || ticket.number <= 0) return false;
    if (compareTickets(ticket, own.ticket) < 0) return false;
  }
  return true;
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
  const nonce = randomUUID();
  const file = lifecycleTicketFile(workspaceId, nonce);
  const deadline = Date.now() + timeoutMs;
  let heartbeat: NodeJS.Timeout | null = null;
  let released = false;

  const createdAt = new Date().toISOString();
  let ticket: LifecycleTicket = {
    pid: process.pid,
    processGeneration: getProcessGeneration(process.pid),
    nonce,
    number: 0,
    choosing: true,
    acquired: false,
    createdAt,
  };

  try {
    // The final ticket path is invisible until the first complete JSON document
    // is atomically renamed into place.
    writeTicket(file, ticket);

    heartbeat = setInterval(() => {
      if (!refreshTicket(file, nonce, orphanGraceMs) && heartbeat) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
    }, heartbeatMs);
    heartbeat.unref();

    const initial = listTickets(workspaceId).filter((entry) => ticketIsFresh(entry, orphanGraceMs));
    let maxNumber = 0;
    for (const entry of initial) {
      if (!entry.ticket || entry.ticket.nonce === nonce) continue;
      if (entry.ticket.number > maxNumber) maxNumber = entry.ticket.number;
    }

    ticket = { ...ticket, number: maxNumber + 1, choosing: false };
    writeTicket(file, ticket);

    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for workspace lifecycle lock: ${workspaceId}`);
      }

      const own = ownTicketEntry(workspaceId, nonce);
      if (!own || !own.ticket || !ticketIsFresh(own, orphanGraceMs)) {
        throw new Error(`Workspace lifecycle ticket was lost or expired: ${workspaceId}`);
      }
      ticket = own.ticket;

      let blocked = false;
      for (const entry of listTickets(workspaceId)) {
        if (!ticketIsFresh(entry, orphanGraceMs)) continue;
        if (!entry.ticket) {
          // A malformed *fresh* legacy/manual ticket is conservatively blocking;
          // atomic production updates never expose a partial JSON document.
          blocked = true;
          break;
        }
        const other = entry.ticket;
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
        // Re-scan after publishing acquired=true. This catches a contender that
        // completed a lower-priority ticket between our last scan and publish.
        if (!isWorkspaceLifecycleLockHeldBy(workspaceId, nonce, orphanGraceMs)) {
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
        if (heartbeat) {
          clearInterval(heartbeat);
          heartbeat = null;
        }
        removeOwnTicket(file, nonce);
      },
    };
  } catch (error) {
    if (heartbeat) clearInterval(heartbeat);
    removeOwnTicket(file, nonce);
    throw error;
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
