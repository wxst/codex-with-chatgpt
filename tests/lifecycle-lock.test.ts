import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  acquireWorkspaceLifecycleLock,
  isWorkspaceLifecycleLockHeldBy,
} from "../src/process/workspace-lock.js";
import { ensureBridge, stopBridge } from "../src/process/daemon.js";
import { startBridge, type Bridge } from "../src/bridge/server.js";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
import { stateSubdir } from "../src/config/paths.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const roots: string[] = [];

function makeWorkspace(name: string): Workspace {
  const root = makeTmpDir(name);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return new Workspace(root);
}

function writeManualLock(
  workspaceId: string,
  owner: { pid: number; nonce: string; acquiredAt: string },
  mtimeMs = Date.now()
): string {
  const lockDir = path.join(stateSubdir("locks"), `${workspaceId}.lifecycle.lock`);
  fs.mkdirSync(lockDir, { mode: 0o700 });
  const file = path.join(lockDir, "owner.json");
  fs.writeFileSync(file, JSON.stringify(owner), { mode: 0o600 });
  const date = new Date(mtimeMs);
  fs.utimesSync(file, date, date);
  return lockDir;
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

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(enteredRevocation).toBe(false);

    held.release();
    await pending;
    expect(enteredRevocation).toBe(true);
  });

  it("does not immediately reclaim a dead-owner lock during the bridge startup grace window", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-dead-owner-grace");
    const lockDir = writeManualLock(workspace.id, {
      pid: 2_147_483_647,
      nonce: "dead-owner-nonce",
      acquiredAt: new Date().toISOString(),
    });

    await expect(
      acquireWorkspaceLifecycleLock(workspace.id, {
        timeoutMs: 30,
        pollMs: 5,
        orphanGraceMs: 500,
      })
    ).rejects.toThrow(/Timed out waiting/);
    expect(fs.existsSync(lockDir)).toBe(true);
  });

  it("reclaims an expired owner generation even if its PID has been reused by a live process", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-pid-reuse");
    const old = Date.now() - 10_000;
    writeManualLock(
      workspace.id,
      {
        pid: process.pid,
        nonce: "reused-live-pid-old-generation",
        acquiredAt: new Date(old).toISOString(),
      },
      old
    );

    const lock = await acquireWorkspaceLifecycleLock(workspace.id, {
      timeoutMs: 500,
      pollMs: 5,
      orphanGraceMs: 100,
    });
    try {
      expect(lock.nonce).not.toBe("reused-live-pid-old-generation");
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, lock.nonce, 100)).toBe(true);
    } finally {
      lock.release();
    }
  });

  it("reclaims a dead-owner lock after the startup grace window expires", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-dead-owner-expired");
    const old = Date.now() - 10_000;
    writeManualLock(
      workspace.id,
      {
        pid: 2_147_483_647,
        nonce: "expired-owner-nonce",
        acquiredAt: new Date(old).toISOString(),
      },
      old
    );

    const lock = await acquireWorkspaceLifecycleLock(workspace.id, {
      timeoutMs: 500,
      pollMs: 5,
      orphanGraceMs: 100,
    });
    try {
      expect(isWorkspaceLifecycleLockHeldBy(workspace.id, lock.nonce, 100)).toBe(true);
    } finally {
      lock.release();
    }
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
      await new Promise((resolve) => setTimeout(resolve, 150));
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
});

describe("stale-lock takeover", () => {
  it("uses an exclusive reclaim claim and rechecks the observed owner generation", () => {
    const source = fs.readFileSync(path.resolve("src/process/workspace-lock.ts"), "utf8");
    expect(source).toContain("RECLAIM_FILE");
    expect(source).toContain('flag: "wx"');
    expect(source).toContain("expectedNonce");
    expect(source).toContain("current.nonce !== observed.nonce");
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
