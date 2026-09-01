import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import * as processIdentity from "../src/process/process-identity.js";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
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

afterEach(() => {
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("generationless legacy revocation", () => {
  it("never declares an unresponsive legacy runtime dead while its recorded PID still exists", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("legacy-unresponsive-live-pid");
    const runtime: RuntimeState = {
      service: SERVICE_NAME,
      version: "0.1.0",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      processGeneration: undefined,
      port: 49991,
      adminToken: "legacy-admin-token",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };
    let stopCalls = 0;

    await expect(
      revokeWorkspaceAccess(workspace.root, {
        readRuntimeState: () => runtime,
        adminFetch: async () => {
          throw new Error("legacy admin endpoint timed out");
        },
        probeBridge: async () => null,
        stopBridge: async () => {
          stopCalls += 1;
          return false;
        },
        authStoreFactory: () => ({ revokeAll: () => 0 }),
        revokeTunnelToken: () => false,
        cancelPendingStarts: () => 0,
        listPendingStarts: () => [],
        sleep: async () => undefined,
        stopTimeoutMs: 0,
        maxRuntimeGenerations: 1,
      })
    ).rejects.toThrow(/Failed to fully revoke/);

    // A generationless PID is only conservative liveness evidence. It must
    // never authorize signaling or a stop attempt when app identity is unknown.
    expect(stopCalls).toBe(0);
  });
});

describe("exact process-termination platform support", () => {
  it("explicitly marks macOS unsupported until a generation-bound termination handle exists", () => {
    const support = (
      processIdentity as unknown as {
        supportsExactProcessTermination?: (platform: NodeJS.Platform) => boolean;
      }
    ).supportsExactProcessTermination;

    expect(support).toBeTypeOf("function");
    expect(support!("linux")).toBe(true);
    expect(support!("win32")).toBe(true);
    expect(support!("darwin")).toBe(false);
  });
});
