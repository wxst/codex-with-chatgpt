import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as daemon from "../src/process/daemon.js";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
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

function runtimeFor(workspace: Workspace, pid: number, startedAt: string, adminToken: string): RuntimeState {
  return {
    service: "codex-with-chatgpt",
    version: "0.1.0",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid,
    port: 48765,
    adminToken,
    publicUrl: null,
    startedAt,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("authenticated process identity", () => {
  it("does not SIGTERM a PID when health matches but authenticated admin identity does not", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("pid-binding");
    const stale = runtimeFor(workspace, 424242, "2026-01-01T00:00:00.000Z", "stale-admin");
    writeRuntimeState(stale);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(
          JSON.stringify({ service: stale.service, version: stale.version, workspaceId: workspace.id, status: "ok" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.endsWith("/admin/info")) {
        return new Response(
          JSON.stringify({ workspaceId: workspace.id, pid: 999999, startedAt: "2026-02-02T00:00:00.000Z" }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error("stale admin credential");
    });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    await expect(daemon.stopBridge(workspace.root)).rejects.toThrow(/could not be fully stopped/);
    expect(kill).toHaveBeenCalled();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });
});

describe("replacement bridge revocation", () => {
  it("rechecks runtime state and revokes a replacement bridge before success", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("replacement-runtime");
    const first = runtimeFor(workspace, 111111, "2026-01-01T00:00:00.000Z", "admin-one");
    const replacement = runtimeFor(workspace, 222222, "2026-01-01T00:00:01.000Z", "admin-two");
    const stopped = new Set<number>();
    const stopCalls: number[] = [];

    const result = await revokeWorkspaceAccess(workspace.root, {
      readRuntimeState: () => (stopped.has(first.pid) ? replacement : first),
      isProcessAlive: (pid) => !stopped.has(pid),
      adminFetch: async () => ({ revoked: 0 }),
      stopBridge: async (_root, expectedRuntime) => {
        if (!expectedRuntime) return false;
        stopCalls.push(expectedRuntime.pid);
        stopped.add(expectedRuntime.pid);
        return true;
      },
      authStoreFactory: () => ({ revokeAll: () => 0 }),
      revokeTunnelToken: () => false,
      clearRuntimeState: () => undefined,
      sleep: async () => undefined,
      stopTimeoutMs: 100,
    } as never);

    expect(result.bridgeStopped).toBe(true);
    expect(stopCalls).toEqual([first.pid, replacement.pid]);
  });
});

describe("daemon log confidentiality", () => {
  it("repairs a reused log file to owner-only permissions before append", () => {
    if (process.platform === "win32") return;
    const dir = makeTmpDir("daemon-log-mode");
    roots.push(dir);
    const file = path.join(dir, "bridge.log");
    fs.writeFileSync(file, "old log\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    const openPrivateAppendFile = (daemon as unknown as {
      openPrivateAppendFile?: (file: string) => number;
    }).openPrivateAppendFile;
    expect(openPrivateAppendFile).toBeTypeOf("function");
    const fd = openPrivateAppendFile!(file);
    fs.closeSync(fd);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });
});
