import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { stateSubdir } from "../config/paths.js";
import { getProcessGeneration, processGenerationMatches } from "./process-identity.js";

export const LIFECYCLE_LOCK_NONCE_ENV = "C2C_LIFECYCLE_LOCK_NONCE";
export const LIFECYCLE_LOCK_WORKSPACE_ENV = "C2C_LIFECYCLE_LOCK_WORKSPACE";

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
  /** Opaque proof passed only to a child startup process spawned under this lock. */
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
      // Older/manual fixtures with a positive ticket number represent a fully
      // chosen ticket. Production always writes these fields explicitly.
      choosing: value.choosing ?? ticketNumber === 0,
      acquired: value.acquired ?? ticketNumber > 0,
      createdAt,
    };
  } catch {
    return null;
  }
}

/**
 * A ticket owned by the exact same OS process generation never expires merely
 * because its event loop or the whole machine was paused. This prevents an old
 * critical section from resuming concurrently with a successor. Once that
 * process generation is gone, the mtime lease supplies the bounded startup
 * grace window (important when a parent dies just after spawning a child).
 */
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
      // A ticket can disappear only when its own owner releases it. Ignore the
      // raced-away entry and rescan on the next acquisition iteration.
    }
  }
  return entries;
}

function writeTicket(file: string, ticket: LifecycleTicket): void {
  fs.writeFileSync(file, JSON.stringify(ticket), { mode: 0o600 });
  if (process.platform !== "win32") {
    fs.chmodSync(file, 0o600);
  } else {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Windows ACL semantics do not reliably map to POSIX mode bits.
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

/**
 * Verify inherited startup proof against a unique, acquired, active ticket.
 * No shared pathname is reclaimed or deleted, so a stale generation cannot be
 * confused with a successor generation at the same path.
 */
export function isWorkspaceLifecycleLockHeldBy(
  workspaceId: string,
  nonce: string,
  orphanGraceMs = DEFAULT_ORPHAN_GRACE_MS
): boolean {
  if (!nonce) return false;
  let own: TicketEntry | null;
  try {
    own = ownTicketEntry(workspaceId, nonce);
  } catch {
    return false;
  }
  if (!own || !own.ticket || !own.ticket.acquired || own.ticket.choosing) return false;
  if (!ticketIsFresh(own, orphanGraceMs)) return false;

  // Defensive split-brain detection: an acquired ticket must remain the first
  // active finalized ticket in the total order.
  for (const entry of listTickets(workspaceId)) {
    if (!ticketIsFresh(entry, orphanGraceMs) || !entry.ticket) continue;
    const ticket = entry.ticket;
    if (ticket.nonce === nonce || ticket.choosing || ticket.number <= 0) continue;
    if (ticket.acquired && compareTickets(ticket, own.ticket) < 0) return false;
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
    fs.writeFileSync(file, JSON.stringify(ticket), { mode: 0o600, flag: "wx" });
    if (process.platform !== "win32") fs.chmodSync(file, 0o600);

    // Heartbeat starts before number selection so a live waiter cannot age out
    // while queued behind a long-running holder. Process-generation identity is
    // the stronger fence when timers are paused for longer than the lease.
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
          // A fresh truncated/partial ticket may belong to a process between
          // create and write. Wait for it to become valid or naturally expire.
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
