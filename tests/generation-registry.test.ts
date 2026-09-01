import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
import { startBridge } from "../src/bridge/server.js";
import {
  listRuntimeStates,
  removeRuntimeStateGeneration,
  runtimeFile,
  runtimeGenerationFile,
  runtimeIdentity,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import {
  cancelPendingStarts,
  createPendingStart,
  listPendingStarts,
  requirePendingStart,
} from "../src/process/startup-registry.js";
import { openAITunnelTokenFile } from "../src/tunnel/transport-mode.js";
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

function runtimeFor(workspace: Workspace, pid: number, port: number, suffix: string): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: "0.1.0",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid,
    processGeneration: `test-generation-${suffix}`,
    port,
    adminToken: `c2c_admin_${suffix}`,
    publicUrl: null,
    startedAt: new Date(Date.now() + port).toISOString(),
  };
}

afterEach(() => {
  delete process.env.C2C_PENDING_START_ID;
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("pending bridge start fencing", () => {
  it("prevents a delayed daemon child from creating credentials after unpair cancels its start", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("cancelled-start");
    const pending = createPendingStart(workspace.id);
    expect(listPendingStarts(workspace.id).map((value) => value.startId)).toContain(pending.startId);

    expect(cancelPendingStarts(workspace.id)).toBe(1);
    expect(() => requirePendingStart(workspace.id, pending.startId)).toThrow(/cancelled|no longer valid/);

    process.env.C2C_PENDING_START_ID = pending.startId;
    await expect(
      startBridge({
        workspaceRoot: workspace.root,
        port: 0,
        persistRuntime: false,
        transportMode: "openai",
      })
    ).rejects.toThrow(/cancelled|no longer valid/);

    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });
});

describe("per-generation runtime registry", () => {
  it("never overwrites the only canonical record of a pre-registry Bridge", () => {
    isolateStateDir();
    const workspace = makeWorkspace("legacy-canonical-preservation");
    const legacy: RuntimeState = {
      ...runtimeFor(workspace, 101010, 48765, "legacy"),
      service: "codex-with-chatgpt",
      processGeneration: undefined,
    };
    const hardened = runtimeFor(workspace, 202020, 49001, "hardened");
    const canonical = runtimeFile(workspace.id);
    const legacyBytes = JSON.stringify(legacy, null, 2);

    fs.writeFileSync(canonical, legacyBytes, { mode: 0o600 });
    writeRuntimeState(hardened);

    expect(fs.readFileSync(canonical, "utf8")).toBe(legacyBytes);
    expect(fs.existsSync(runtimeGenerationFile(hardened))).toBe(true);
    expect(new Set(listRuntimeStates(workspace.id).map((state) => state.port))).toEqual(
      new Set([legacy.port, hardened.port])
    );
  });

  it("keeps multiple ports authoritative even when the legacy canonical snapshot is overwritten", () => {
    isolateStateDir();
    const workspace = makeWorkspace("multi-runtime");
    const first = runtimeFor(workspace, 111111, 48765, "first");
    const second = runtimeFor(workspace, 222222, 49001, "second");

    writeRuntimeState(first);
    writeRuntimeState(second);

    // Simulate restoring an old single-slot snapshot over the compatibility mirror.
    fs.writeFileSync(runtimeFile(workspace.id), JSON.stringify(first, null, 2), { mode: 0o600 });

    const listed = listRuntimeStates(workspace.id);
    expect(new Set(listed.map((state) => state.port))).toEqual(new Set([48765, 49001]));
    expect(new Set(listed.map(runtimeIdentity)).size).toBe(2);

    removeRuntimeStateGeneration(first);
    expect(fs.existsSync(runtimeGenerationFile(first))).toBe(false);
    expect(fs.existsSync(runtimeGenerationFile(second))).toBe(true);
    // Cleanup never unlinks the non-authoritative mirror because a concurrent
    // replacement may have renamed a newer snapshot onto that pathname.
    expect(fs.existsSync(runtimeFile(workspace.id))).toBe(true);
    expect(new Set(listRuntimeStates(workspace.id).map((state) => state.port))).toEqual(new Set([48765, 49001]));
  });

  it("revokes every tracked runtime generation instead of a single canonical candidate", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("revoke-all-generations");
    const first = runtimeFor(workspace, 333331, 48765, "one");
    const second = runtimeFor(workspace, 333332, 49002, "two");
    let states = [first, second];
    const alive = new Set(states.map((state) => state.pid));
    const stoppedPorts: number[] = [];

    await revokeWorkspaceAccess(workspace.root, {
      listRuntimeStates: () => states,
      removeRuntimeStateGeneration: (runtime) => {
        states = states.filter((state) => runtimeIdentity(state) !== runtimeIdentity(runtime));
      },
      isProcessAlive: (pid) => alive.has(pid),
      adminFetch: async (_runtime, method, route) => {
        if (method === "POST" && route === "/admin/revoke-all") return { revoked: 0 } as never;
        throw new Error("unexpected admin request");
      },
      stopBridge: async (_root, runtime) => {
        if (!runtime) return false;
        stoppedPorts.push(runtime.port);
        alive.delete(runtime.pid);
        return true;
      },
      authStoreFactory: () => ({ revokeAll: () => 0 }),
      revokeTunnelToken: () => false,
      cancelPendingStarts: () => 0,
      listPendingStarts: () => [],
      probeBridge: async () => null,
      sleep: async () => undefined,
      stopTimeoutMs: 10,
      maxRuntimeGenerations: 4,
    });

    expect(new Set(stoppedPorts)).toEqual(new Set([48765, 49002]));
    expect(states).toEqual([]);
  });
});
