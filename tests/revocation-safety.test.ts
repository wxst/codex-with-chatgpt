import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
import {
  listRuntimeStates,
  readRuntimeState,
  runtimeFile,
  runtimeGenerationFile,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { stopBridge, stopBridgeRuntime } from "../src/process/daemon.js";
import { getProcessGeneration } from "../src/process/process-identity.js";
import { writeTransportMode } from "../src/tunnel/transport-mode.js";
import { Workspace } from "../src/workspace/manager.js";
import { SERVICE_NAME } from "../src/version.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const roots: string[] = [];

function makeWorkspace(name: string): Workspace {
  const root = makeTmpDir(name);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return new Workspace(root);
}

function runtimeFor(workspace: Workspace): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: "0.1.0",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: 424242,
    port: 48765,
    adminToken: "stale-admin-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not exit")), 4000)),
  ]);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("runtime snapshot publication", () => {
  it("publishes authoritative runtime JSON through a same-directory atomic rename", () => {
    isolateStateDir();
    const workspace = makeWorkspace("runtime-atomic");
    const runtime = { ...runtimeFor(workspace), pid: process.pid, port: 49001 };
    const rename = vi.spyOn(fs, "renameSync");

    writeRuntimeState(runtime);

    const listed = listRuntimeStates(workspace.id);
    const authoritativeState = listed.find(
      (state) => state.pid === process.pid && state.port === runtime.port && state.workspaceId === workspace.id
    );
    expect(authoritativeState).toBeTruthy();
    const authoritative = runtimeGenerationFile(authoritativeState!);
    const atomicRename = rename.mock.calls.find(([, target]) => String(target) === authoritative);
    expect(atomicRename).toBeTruthy();
    const [source, target] = atomicRename!;
    expect(target).toBe(authoritative);
    expect(path.dirname(String(source))).toBe(path.dirname(authoritative));
    expect(String(source)).toMatch(/\.tmp$/);

    const canonical = runtimeFile(workspace.id);
    expect(fs.existsSync(canonical)).toBe(true);
    expect(readRuntimeState(workspace.id)?.workspaceId).toBe(workspace.id);
    expect(authoritativeState!.processGeneration).toBeTruthy();
    expect(fs.readdirSync(path.dirname(authoritative)).some((name) => name.endsWith(".tmp"))).toBe(false);
    if (process.platform !== "win32") {
      expect(fs.statSync(authoritative).mode & 0o777).toBe(0o600);
      expect(fs.statSync(canonical).mode & 0o777).toBe(0o600);
    }
  });
});

describe("revocation process identity", () => {
  it("uses only non-destructive liveness probes when bridge identity cannot be proven", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("stale-pid");
    writeRuntimeState(runtimeFor(workspace));

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    await expect(stopBridge(workspace.root)).rejects.toThrow(/could not be fully stopped/);
    expect(kill).toHaveBeenCalled();
    expect(kill.mock.calls.every(([, signal]) => signal === 0)).toBe(true);
  });

  it("terminates an unresponsive process only when its exact generation still matches", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("exact-generation-kill");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

    try {
      if (!child.pid) throw new Error("child pid unavailable");
      const generation = getProcessGeneration(child.pid);
      expect(generation).toBeTruthy();
      const runtime: RuntimeState = {
        ...runtimeFor(workspace),
        pid: child.pid,
        processGeneration: generation,
        port: 9,
      };

      vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("admin endpoint hung"));
      expect(await stopBridgeRuntime(workspace.root, runtime)).toBe(true);
      await waitForExit(child);
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  it("force-kills an exact generation when graceful shutdown is acknowledged but never exits", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("wedged-graceful-shutdown");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });

    try {
      if (!child.pid) throw new Error("child pid unavailable");
      const generation = getProcessGeneration(child.pid);
      expect(generation).toBeTruthy();
      const runtime: RuntimeState = {
        ...runtimeFor(workspace),
        pid: child.pid,
        processGeneration: generation,
        port: 49091,
      };

      vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
        const url = String(input);
        if (url.endsWith("/admin/info")) {
          return new Response(
            JSON.stringify({
              service: SERVICE_NAME,
              workspaceId: workspace.id,
              workspaceRoot: workspace.root,
              pid: child.pid,
              processGeneration: generation,
              port: runtime.port,
              startedAt: runtime.startedAt,
            }),
            { status: 200, headers: { "content-type": "application/json" } }
          );
        }
        if (url.endsWith("/admin/shutdown")) {
          return new Response(JSON.stringify({ shuttingDown: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        throw new Error(`unexpected admin request: ${url}`);
      });

      expect(await stopBridgeRuntime(workspace.root, runtime)).toBe(true);
      await waitForExit(child);
      if (process.platform === "linux") {
      expect(child.signalCode).toBe("SIGKILL");
    } else {
      expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    }
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });
});

describe("revocation split-brain detection", () => {
  it("fails closed when stale runtime auth fails but same-workspace health is still live", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("stale-runtime-live-health");
    writeTransportMode(workspace.id, "openai");
    const runtime: RuntimeState = {
      ...runtimeFor(workspace),
      pid: process.pid,
      processGeneration: "definitely-not-the-current-generation",
    };
    let healthChecks = 0;
    const finalizer = vi.fn();

    await expect(
      revokeWorkspaceAccess(workspace.root, {
        readRuntimeState: () => runtime,
        adminFetch: async () => {
          throw new Error("stale admin token");
        },
        probeBridge: async () => {
          healthChecks += 1;
          return {
            service: SERVICE_NAME,
            version: "0.1.0",
            workspaceId: workspace.id,
            status: "ok",
          };
        },
        stopBridge: async () => false,
        authStoreFactory: () => ({ revokeAll: () => 0 }),
        revokeTunnelToken: () => false,
        sleep: async () => undefined,
        stopTimeoutMs: 0,
        maxRuntimeGenerations: 1,
        afterQuiescent: finalizer,
      })
    ).rejects.toThrow(/Failed to fully revoke/);

    expect(healthChecks).toBeGreaterThan(0);
    expect(finalizer).not.toHaveBeenCalled();
  });
});

describe("revocation persistence races", () => {
  it("scrubs persisted OAuth state again after a live bridge is confirmed stopped", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("final-oauth-scrub");
    writeTransportMode(workspace.id, "openai");
    const runtime = runtimeFor(workspace);
    const events: string[] = [];
    let aliveChecks = 0;
    let storeCalls = 0;

    const result = await revokeWorkspaceAccess(workspace.root, {
      readRuntimeState: () => runtime,
      isProcessAlive: () => {
        aliveChecks += 1;
        return aliveChecks === 1;
      },
      adminFetch: async () => {
        events.push("admin-revoke");
        return { revoked: 1 };
      },
      stopBridge: async () => {
        events.push("stop");
        return true;
      },
      clearRuntimeState: () => {
        events.push("clear-runtime");
      },
      authStoreFactory: () => ({
        revokeAll: () => {
          storeCalls += 1;
          events.push("disk-revoke");
          return 1;
        },
      }),
      sleep: async () => undefined,
      afterQuiescent: () => {
        events.push("finalize");
      },
    });

    expect(result.bridgeStopped).toBe(true);
    expect(storeCalls).toBeGreaterThanOrEqual(2);
    expect(events.lastIndexOf("disk-revoke")).toBeGreaterThan(events.indexOf("stop"));
    expect(events.indexOf("finalize")).toBeGreaterThan(events.lastIndexOf("disk-revoke"));
    expect(events).not.toContain("clear-runtime");
  });
});
