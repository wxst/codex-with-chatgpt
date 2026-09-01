import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { stopBridgeRuntime } from "../src/process/daemon.js";
import { Workspace } from "../src/workspace/manager.js";
import { SERVICE_NAME } from "../src/version.js";
import type { RuntimeState } from "../src/bridge/runtime.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

function makeLegacyRuntime(workspace: Workspace, pid: number, port: number): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: "0.1.0",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid,
    port,
    adminToken: "legacy-admin-token",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

function authenticatedInfo(runtime: RuntimeState): Response {
  return new Response(
    JSON.stringify({
      service: SERVICE_NAME,
      workspaceId: runtime.workspaceId,
      workspaceRoot: runtime.workspaceRoot,
      pid: runtime.pid,
      port: runtime.port,
      startedAt: runtime.startedAt,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
}

describe("legacy authenticated bridge shutdown", () => {
  it("waits for sustained endpoint and PID disappearance after shutdown is acknowledged", async () => {
    isolateStateDir();
    const root = makeTmpDir("legacy-generationless-shutdown");
    roots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "legacy-generationless-shutdown" }));
    const workspace = new Workspace(root);
    const runtime = makeLegacyRuntime(workspace, 424242, 49077);

    let shutdownAcknowledged = false;
    let infoCalls = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/admin/shutdown")) {
        shutdownAcknowledged = true;
        return new Response(JSON.stringify({ shuttingDown: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/admin/info")) {
        infoCalls += 1;
        if (shutdownAcknowledged) throw new Error("legacy bridge exited");
        return authenticatedInfo(runtime);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(stopBridgeRuntime(workspace.root, runtime)).resolves.toBe(true);
    expect(shutdownAcknowledged).toBe(true);
    // Sustained confirmation requires multiple post-shutdown absence probes.
    expect(infoCalls).toBeGreaterThan(2);
  });

  it("does not treat an unresponsive generationless endpoint as exited while its PID still exists", async () => {
    isolateStateDir();
    const root = makeTmpDir("legacy-paused-shutdown");
    roots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "legacy-paused-shutdown" }));
    const workspace = new Workspace(root);
    // Use the test runner's live PID so numeric death confirmation remains false
    // even after every authenticated endpoint probe times out.
    const runtime = makeLegacyRuntime(workspace, process.pid, 49078);

    let shutdownAcknowledged = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/admin/shutdown")) {
        shutdownAcknowledged = true;
        return new Response(JSON.stringify({ shuttingDown: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/admin/info")) {
        if (shutdownAcknowledged) throw new Error("legacy bridge paused");
        return authenticatedInfo(runtime);
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(stopBridgeRuntime(workspace.root, runtime)).resolves.toBe(false);
    expect(shutdownAcknowledged).toBe(true);
  }, 10_000);
});
