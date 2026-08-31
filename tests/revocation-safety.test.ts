import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
import { writeRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { stopBridge } from "../src/process/daemon.js";
import { writeTransportMode } from "../src/tunnel/transport-mode.js";
import { Workspace } from "../src/workspace/manager.js";
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
    service: "codex-with-chatgpt",
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

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("revocation process identity", () => {
  it("never SIGTERMs a stale/reused PID when bridge identity cannot be proven", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("stale-pid");
    writeRuntimeState(runtimeFor(workspace));

    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connection refused"));
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    expect(await stopBridge(workspace.root)).toBe(false);
    expect(kill).not.toHaveBeenCalled();
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
    });

    expect(result.bridgeStopped).toBe(true);
    expect(storeCalls).toBeGreaterThanOrEqual(2);
    expect(events.lastIndexOf("disk-revoke")).toBeGreaterThan(events.indexOf("stop"));
    expect(events).not.toContain("clear-runtime");
  });
});
