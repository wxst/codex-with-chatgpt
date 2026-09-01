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

    expect(stopCalls).toBe(0);
  });

  it("treats a generation-bearing runtime with temporarily unknown identity as live and never removes it", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("generation-unknown-live-pid");
    const runtime: RuntimeState = {
      service: SERVICE_NAME,
      version: "0.1.0",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      processGeneration: "expected-generation",
      port: 49992,
      adminToken: "hardened-admin-token",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };
    let stopCalls = 0;
    let removeCalls = 0;

    await expect(
      revokeWorkspaceAccess(workspace.root, {
        listRuntimeStates: () => [runtime],
        removeRuntimeStateGeneration: () => {
          removeCalls += 1;
        },
        processGenerationStatus: () => "unknown",
        adminFetch: async () => {
          throw new Error("admin endpoint timed out");
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

    expect(stopCalls).toBe(0);
    expect(removeCalls).toBe(0);
  });

  it("keeps a runtime registered when identity becomes unknown after an exact stop attempt", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("post-stop-unknown-generation");
    const runtime: RuntimeState = {
      service: SERVICE_NAME,
      version: "0.1.0",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: process.pid,
      processGeneration: "expected-generation",
      port: 49993,
      adminToken: "post-stop-admin-token",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };
    let generationChecks = 0;
    let stopCalls = 0;
    let removeCalls = 0;

    await expect(
      revokeWorkspaceAccess(workspace.root, {
        listRuntimeStates: () => [runtime],
        removeRuntimeStateGeneration: () => {
          removeCalls += 1;
        },
        processGenerationStatus: () => {
          generationChecks += 1;
          return generationChecks === 1 ? "match" : "unknown";
        },
        adminFetch: async (_runtime, method, route) => {
          if (method === "POST" && route === "/admin/revoke-all") return { revoked: 0 } as never;
          throw new Error("unexpected admin request");
        },
        probeBridge: async () => null,
        stopBridge: async () => {
          stopCalls += 1;
          return true;
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

    expect(stopCalls).toBe(1);
    expect(removeCalls).toBe(0);
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

  it("probes the real native Windows handle termination chain before credentials can load", () => {
    const source = fs.readFileSync(path.resolve("src/process/process-identity.ts"), "utf8");
    expect(source).toContain("WINDOWS_HANDLE_CAPABILITY_SCRIPT");
    expect(source).toContain("Start-Process");
    expect(source).toContain("OpenProcess");
    expect(source).toContain("GetProcessTimes");
    expect(source).toContain("TerminateProcess");
    expect(source).toContain("WaitForExit(2000)");
    expect(source).toContain("probeWindowsExactTermination()");
  });

  it("does not collapse unknown daemon process identity into a confirmed exit", () => {
    const source = fs.readFileSync(path.resolve("src/process/daemon.ts"), "utf8");
    expect(source).toContain("processGenerationStatus");
    expect(source).not.toContain("processGenerationMatches");
    expect(source).toContain('=== "mismatch"');
  });
});
