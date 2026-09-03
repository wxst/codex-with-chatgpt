import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  acquireWorkspaceLifecycleLock,
  isWorkspaceLifecycleLockHeldBy,
  lifecycleTicketFile,
} from "../src/process/workspace-lock.js";
import { getProcessGeneration, requireCurrentProcessGeneration } from "../src/process/process-identity.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
import { stateSubdir } from "../src/config/paths.js";
import { writeRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const roots: string[] = [];

function makeWorkspace(name: string): Workspace {
  const root = makeTmpDir(name);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return new Workspace(root);
}

function writeManualTicket(
  workspaceId: string,
  ticket: { pid: number; nonce: string; number: number; createdAt: string },
  mtimeMs = Date.now()
): string {
  const file = lifecycleTicketFile(workspaceId, ticket.nonce);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(ticket), { mode: 0o600 });
  const date = new Date(mtimeMs);
  fs.utimesSync(file, date, date);
  return file;
}

function fakeRuntime(workspace: Workspace, pid: number, port: number): RuntimeState {
  return {
    service: "codex-with-chatgpt",
    version: "0.1.0",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid,
    port,
    adminToken: "stale-admin-token",
    publicUrl: null,
    startedAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("workspace lifecycle serialization", () => {
  it.runIf(process.platform === "win32").each(["EPERM", "EACCES", "EBUSY"])(
    "retries a transient %s ticket rename denial",
    async (code) => {
      isolateStateDir();
      const workspace = makeWorkspace(`lifecycle-transient-rename-${code}`);
      const rename = fs.renameSync.bind(fs);
      let attempts = 0;

      vi.spyOn(fs, "renameSync").mockImplementation((source, target) => {
        if (String(target).endsWith(".ticket.json")) {
          attempts += 1;
          if (attempts === 1) {
            const error = new Error("transient ticket rename denial") as NodeJS.ErrnoException;
            error.code = code;
            throw error;
          }
        }
        return rename(source, target);
      });

      const lock = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
      expect(attempts).toBeGreaterThan(1);
      lock.release();
    }
  );

  it.runIf(process.platform === "win32")("stops after the bounded transient rename retries", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-persistent-rename-denial");
    let attempts = 0;

    vi.spyOn(fs, "renameSync").mockImplementation((_source, target) => {
      if (String(target).endsWith(".ticket.json")) {
        attempts += 1;
        const error = new Error("persistent ticket rename denial") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      }
    });

    await expect(acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 })).rejects.toMatchObject({
      code: "EPERM",
    });
    expect(attempts).toBe(7);
  });

  it.runIf(process.platform === "win32")("does not retry a non-transient rename error", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-non-transient-rename-denial");
    let attempts = 0;

    vi.spyOn(fs, "renameSync").mockImplementation((_source, target) => {
      if (String(target).endsWith(".ticket.json")) {
        attempts += 1;
        const error = new Error("non-transient ticket rename denial") as NodeJS.ErrnoException;
        error.code = "EINVAL";
        throw error;
      }
    });

    await expect(acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 })).rejects.toMatchObject({
      code: "EINVAL",
    });
    expect(attempts).toBe(1);
  });

  it("blocks revocation while the same workspace lifecycle lock is held", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-revoke");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    let enteredRevocation = false;

    expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce)).toBe(true);

    const pending = revokeWorkspaceAccess(workspace.root, {
      readRuntimeState: () => {
        enteredRevocation = true;
        return null;
      },
      authStoreFactory: () => ({ revokeAll: () => 0 }),
      revokeTunnelToken: () => false,
      sleep: async () => undefined,
    });

    await sleep(25);
    expect(enteredRevocation).toBe(false);

    held.release();
    await pending;
    expect(enteredRevocation).toBe(true);
  });

  it("rejects a held ticket whose content nonce or ownership schema was replaced", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-replaced-own-ticket");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    const file = lifecycleTicketFile(workspace.id, held.nonce);
    const original = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;

    try {
      for (const replacement of [
        { ...original, nonce: "different-ticket-nonce" },
        { ...original, choosing: 0 },
        { ...original, acquired: "yes" },
        { ...original, number: 0, choosing: false, acquired: true },
        { ...original, number: 1, choosing: true, acquired: true },
      ]) {
        fs.writeFileSync(file, JSON.stringify(replacement), { mode: 0o600 });
        expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce)).toBe(false);
      }
    } finally {
      fs.writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
      held.release();
    }
  });

  it("rejects a held ticket rebound to another live process generation", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-rebound-owner");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    const file = lifecycleTicketFile(workspace.id, held.nonce);
    const original = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });

    try {
      if (!child.pid) throw new Error("owner fixture PID is missing");
      let generation: string | null = null;
      for (let attempt = 0; attempt < 20 && !generation; attempt += 1) {
        generation = getProcessGeneration(child.pid);
        if (!generation) await sleep(25);
      }
      if (!generation) throw new Error("owner fixture generation is missing");
      fs.writeFileSync(
        file,
        JSON.stringify({ ...original, pid: child.pid, processGeneration: generation }),
        { mode: 0o600 }
      );
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce)).toBe(false);
    } finally {
      fs.writeFileSync(file, JSON.stringify(original), { mode: 0o600 });
      held.release();
      child.kill("SIGKILL");
    }
  });

  it("fails closed when the lock directory cannot be enumerated", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-readdir-denied");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    const locksDirectory = path.dirname(lifecycleTicketFile(workspace.id, held.nonce));
    const realReaddir = fs.readdirSync.bind(fs);
    const readdir = vi.spyOn(fs, "readdirSync").mockImplementation(((target, options) => {
      if (path.resolve(String(target)) === path.resolve(locksDirectory)) {
        const error = new Error("lock directory denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realReaddir(target, options as never);
    }) as typeof fs.readdirSync);

    try {
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce)).toBe(false);
    } finally {
      readdir.mockRestore();
      held.release();
    }
  });

  it("fails closed when a fresh contender cannot be read", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-contender-read-denied");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    const contenderNonce = "fresh-blocking-contender";
    const contender = lifecycleTicketFile(workspace.id, contenderNonce);
    fs.writeFileSync(
      contender,
      JSON.stringify({
        pid: process.pid,
        processGeneration: requireCurrentProcessGeneration(),
        nonce: contenderNonce,
        number: 0,
        choosing: true,
        acquired: false,
        createdAt: new Date().toISOString(),
      }),
      { mode: 0o600 }
    );
    const realReadFile = fs.readFileSync.bind(fs);
    const readFile = vi.spyOn(fs, "readFileSync").mockImplementation(((target, options) => {
      if (path.resolve(String(target)) === path.resolve(contender)) {
        const error = new Error("contender read denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return realReadFile(target, options as never);
    }) as typeof fs.readFileSync);

    try {
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce)).toBe(false);
    } finally {
      readFile.mockRestore();
      held.release();
    }
  });

  it("fails closed when a matching ticket pathname is a directory", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-ticket-directory");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    const directoryTicket = lifecycleTicketFile(workspace.id, "directory-contender");
    fs.mkdirSync(directoryTicket);
    try {
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce)).toBe(false);
    } finally {
      held.release();
    }
  });

  it("fails closed before reading a matching symlink ticket pathname", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-ticket-symlink");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    const target = path.join(path.dirname(lifecycleTicketFile(workspace.id, held.nonce)), "outside-target.json");
    const symlinkTicket = lifecycleTicketFile(workspace.id, "symlink-contender");
    fs.writeFileSync(target, "{}", { mode: 0o600 });
    fs.symlinkSync(target, symlinkTicket, "file");
    const realReadFile = fs.readFileSync.bind(fs);
    let symlinkReads = 0;
    const readFile = vi.spyOn(fs, "readFileSync").mockImplementation(((source, options) => {
      if (path.resolve(String(source)) === path.resolve(symlinkTicket)) symlinkReads += 1;
      return realReadFile(source, options as never);
    }) as typeof fs.readFileSync);
    try {
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce)).toBe(false);
      expect(symlinkReads).toBe(0);
    } finally {
      readFile.mockRestore();
      held.release();
    }
  });

  it("fails closed when another ticket filename contains a clone of the active descriptor", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-cloned-active-ticket");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    const own = lifecycleTicketFile(workspace.id, held.nonce);
    const clone = lifecycleTicketFile(workspace.id, "cloned-active-ticket");
    fs.writeFileSync(clone, fs.readFileSync(own), { mode: 0o600 });
    try {
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce)).toBe(false);
    } finally {
      held.release();
    }
  });

  it.each(["hardlink", "symlink"] as const)(
    "does not refresh an own-ticket %s target outside the lock directory",
    async (kind) => {
      isolateStateDir();
      const workspace = makeWorkspace(`lifecycle-heartbeat-${kind}`);
      const held = await acquireWorkspaceLifecycleLock(workspace.id, {
        timeoutMs: 1000,
        pollMs: 5,
        orphanGraceMs: 80,
      });
      const own = lifecycleTicketFile(workspace.id, held.nonce);
      const original = fs.readFileSync(own);
      const outsideRoot = makeTmpDir(`lifecycle-heartbeat-${kind}-outside`);
      roots.push(outsideRoot);
      const target = path.join(outsideRoot, "target.json");
      fs.writeFileSync(target, original, { mode: 0o600 });
      const old = new Date(Date.now() - 120_000);
      fs.utimesSync(target, old, old);
      const before = fs.statSync(target).mtimeMs;
      fs.unlinkSync(own);
      if (kind === "hardlink") fs.linkSync(target, own);
      else fs.symlinkSync(target, own, "file");

      try {
        await sleep(120);
        expect(fs.statSync(target).mtimeMs).toBe(before);
        expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce, 80)).toBe(false);
      } finally {
        held.release();
      }
    }
  );

  it("stops heartbeat when the own ticket generation no longer matches acquisition", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-heartbeat-generation-replaced");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, {
      timeoutMs: 1000,
      pollMs: 5,
      orphanGraceMs: 80,
    });
    const own = lifecycleTicketFile(workspace.id, held.nonce);
    const original = JSON.parse(fs.readFileSync(own, "utf8")) as Record<string, unknown>;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });

    try {
      if (!child.pid) throw new Error("generation fixture PID is missing");
      let otherGeneration: string | null = null;
      for (let attempt = 0; attempt < 20 && !otherGeneration; attempt += 1) {
        otherGeneration = getProcessGeneration(child.pid);
        if (!otherGeneration) await sleep(25);
      }
      if (!otherGeneration) throw new Error("generation fixture identity is missing");
      fs.writeFileSync(
        own,
        JSON.stringify({ ...original, processGeneration: otherGeneration }),
        { mode: 0o600 }
      );
      const before = fs.statSync(own).mtimeMs;
      await sleep(120);
      expect(fs.statSync(own).mtimeMs).toBe(before);
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, held.nonce, 80)).toBe(false);
    } finally {
      fs.writeFileSync(own, JSON.stringify(original), { mode: 0o600 });
      held.release();
      child.kill("SIGKILL");
    }
  });

  it("makes the bridge process acquire its own ticket before startup", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("child-owned-startup");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    let settled = false;
    let bridge: Bridge | null = null;

    const pending = startBridge({ workspaceRoot: workspace.root, port: 0, persistRuntime: false }).then((value) => {
      settled = true;
      return value;
    });

    try {
      await sleep(30);
      expect(settled).toBe(false);
      held.release();
      bridge = await pending;
      expect(bridge.workspace.id).toBe(workspace.id);
    } finally {
      held.release();
      if (bridge) await bridge.close();
    }
  });

  it("keeps a fresh ticket blocking during the startup grace window", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-fresh-ticket");
    const ticket = writeManualTicket(workspace.id, {
      pid: 2_147_483_647,
      nonce: "fresh-ticket-owner",
      number: 1,
      createdAt: new Date().toISOString(),
    });

    await expect(
      acquireWorkspaceLifecycleLock(workspace.id, {
        timeoutMs: 30,
        pollMs: 5,
        orphanGraceMs: 500,
      })
    ).rejects.toThrow(/Timed out waiting/);
    expect(fs.existsSync(ticket)).toBe(true);
  });

  it("ignores an expired ticket even when its PID has been reused by a live process", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-pid-reuse");
    const old = Date.now() - 10_000;
    writeManualTicket(
      workspace.id,
      {
        pid: process.pid,
        nonce: "reused-live-pid-old-ticket",
        number: 1,
        createdAt: new Date(old).toISOString(),
      },
      old
    );

    const lock = await acquireWorkspaceLifecycleLock(workspace.id, {
      timeoutMs: 500,
      pollMs: 5,
      orphanGraceMs: 100,
    });
    try {
      expect(lock.nonce).not.toBe("reused-live-pid-old-ticket");
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, lock.nonce, 100)).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("ignores malformed stale tickets without deleting somebody else's pathname", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-malformed-ticket");
    const file = lifecycleTicketFile(workspace.id, "malformed-stale-ticket");
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, "{", { mode: 0o600 });
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(file, old, old);

    const lock = await acquireWorkspaceLifecycleLock(workspace.id, {
      timeoutMs: 500,
      pollMs: 5,
      orphanGraceMs: 100,
    });
    try {
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, lock.nonce, 100)).toBe(true);
      expect(fs.existsSync(file)).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("elects only one winner when multiple waiters bypass the same stale ticket", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-single-winner");
    const old = Date.now() - 10_000;
    writeManualTicket(
      workspace.id,
      {
        pid: 2_147_483_647,
        nonce: "stale-predecessor",
        number: 1,
        createdAt: new Date(old).toISOString(),
      },
      old
    );

    let resolved = 0;
    const a = acquireWorkspaceLifecycleLock(workspace.id, {
      timeoutMs: 1000,
      pollMs: 5,
      orphanGraceMs: 100,
    }).then((lock) => {
      resolved += 1;
      return lock;
    });
    const b = acquireWorkspaceLifecycleLock(workspace.id, {
      timeoutMs: 1000,
      pollMs: 5,
      orphanGraceMs: 100,
    }).then((lock) => {
      resolved += 1;
      return lock;
    });

    const first = await Promise.race([a, b]);
    await sleep(30);
    expect(resolved).toBe(1);

    first.release();
    const [lockA, lockB] = await Promise.all([a, b]);
    const second = lockA.nonce === first.nonce ? lockB : lockA;
    expect(second.nonce).not.toBe(first.nonce);
    second.release();
  });

  it("serializes concurrent ensureBridge calls so one persisted bridge wins", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-start");

    try {
      const first = ensureBridge(workspace.root);
      const second = ensureBridge(workspace.root);
      const [a, b] = await Promise.all([first, second]);

      expect(a.runtime.workspaceId).toBe(workspace.id);
      expect(b.runtime.workspaceId).toBe(workspace.id);
      expect(a.runtime.pid).toBe(b.runtime.pid);
    } finally {
      await stopBridge(workspace.root).catch(() => false);
      await sleep(150);
    }
  }, 30_000);

  it("rejects a second persisted bridge startup for the same workspace", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("single-persisted-bridge");
    let first: Bridge | null = null;
    let second: Bridge | null = null;
    let secondError: unknown = null;

    try {
      first = await startBridge({ workspaceRoot: workspace.root, port: 0, persistRuntime: true });
      try {
        second = await startBridge({ workspaceRoot: workspace.root, port: 0, persistRuntime: true });
      } catch (error) {
        secondError = error;
      }

      expect(second).toBeNull();
      expect(secondError).toBeInstanceOf(Error);
      expect(String((secondError as Error).message)).toMatch(/already running|runtime/i);
    } finally {
      if (second) await second.close();
      if (first) await first.close();
    }
  });

  it("does not treat an unrelated live process that reused a stale runtime PID as an active bridge", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("stale-runtime-live-pid");
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    let bridge: Bridge | null = null;

    try {
      if (!unrelated.pid) throw new Error("failed to spawn unrelated process");
      writeRuntimeState(fakeRuntime(workspace, unrelated.pid, 9));
      bridge = await startBridge({ workspaceRoot: workspace.root, port: 0, persistRuntime: true });
      expect(bridge.workspace.id).toBe(workspace.id);
    } finally {
      if (bridge) await bridge.close();
      unrelated.kill("SIGTERM");
    }
  });
});

describe("ticket-lock design", () => {
  it("uses unique ticket paths and never needs a shared reclaim marker", () => {
    const source = fs.readFileSync(path.resolve("src/process/workspace-lock.ts"), "utf8");
    expect(source).toContain("lifecycleTicketFile");
    expect(source).toContain("ticket.number");
    expect(source).not.toContain("RECLAIM_FILE");
    expect(source).not.toContain(".reclaim.json");
  });

  it("publishes ticket state with an atomic same-directory rename", () => {
    const source = fs.readFileSync(path.resolve("src/process/workspace-lock.ts"), "utf8");
    expect(source).toContain("fs.renameSync(temp, file)");
    expect(source).toContain("randomUUID()}.tmp");
    expect(source).toContain("fs.fsyncSync(fd)");
    expect(source).not.toContain('fs.writeFileSync(file, JSON.stringify(ticket)');
  });
});

describe("daemon source-mode fallback", () => {
  it("retains the TypeScript/tsx fallback when dist CLI is absent", () => {
    const source = fs.readFileSync(path.resolve("src/process/daemon.ts"), "utf8");
    expect(source).toContain("fs.existsSync(distEntry)");
    expect(source).toContain('"--import", "tsx/esm"');
    expect(source).toContain('"src", "cli", "index.ts"');
  });

  it("does not pass parent lifecycle authority to the detached child", () => {
    const daemonSource = fs.readFileSync(path.resolve("src/process/daemon.ts"), "utf8");
    const bridgeSource = fs.readFileSync(path.resolve("src/bridge/server.ts"), "utf8");
    expect(daemonSource).not.toContain("LIFECYCLE_LOCK_NONCE_ENV");
    expect(daemonSource).not.toContain("LIFECYCLE_LOCK_WORKSPACE_ENV");
    expect(bridgeSource).not.toContain("isWorkspaceLifecycleLockHeldBy");
    expect(bridgeSource).toContain("withWorkspaceLifecycleLock");
  });
});
