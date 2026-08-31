import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  acquireWorkspaceLifecycleLock,
  isWorkspaceLifecycleLockHeldBy,
  lifecycleTicketFile,
} from "../src/process/workspace-lock.js";
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
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("workspace lifecycle serialization", () => {
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

  it("serializes concurrent ensureBridge calls so only one startup path wins", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-start");

    try {
      const first = ensureBridge(workspace.root);
      const second = ensureBridge(workspace.root);
      const [a, b] = await Promise.all([first, second]);

      expect(a.runtime.workspaceId).toBe(workspace.id);
      expect(b.runtime.workspaceId).toBe(workspace.id);
      expect(a.runtime.pid).toBe(b.runtime.pid);
      expect([a.spawned, b.spawned].filter(Boolean)).toHaveLength(1);
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
});

describe("daemon source-mode fallback", () => {
  it("retains the TypeScript/tsx fallback when dist CLI is absent", () => {
    const source = fs.readFileSync(path.resolve("src/process/daemon.ts"), "utf8");
    expect(source).toContain("fs.existsSync(distEntry)");
    expect(source).toContain('"--import", "tsx/esm"');
    expect(source).toContain('"src", "cli", "index.ts"');
  });

  it("passes an inherited lifecycle nonce to the child and validates it at the bridge startup boundary", () => {
    const daemonSource = fs.readFileSync(path.resolve("src/process/daemon.ts"), "utf8");
    const bridgeSource = fs.readFileSync(path.resolve("src/bridge/server.ts"), "utf8");
    expect(daemonSource).toContain("LIFECYCLE_LOCK_NONCE_ENV");
    expect(daemonSource).toContain("LIFECYCLE_LOCK_WORKSPACE_ENV");
    expect(bridgeSource).toContain("isWorkspaceLifecycleLockHeldBy");
    expect(bridgeSource).toContain("LIFECYCLE_LOCK_NONCE_ENV");
    expect(bridgeSource).toContain("LIFECYCLE_LOCK_WORKSPACE_ENV");
  });
});
