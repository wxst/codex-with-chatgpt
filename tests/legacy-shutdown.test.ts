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

describe("legacy authenticated bridge shutdown", () => {
  it("waits for an authenticated generationless bridge endpoint to disappear after shutdown is acknowledged", async () => {
    isolateStateDir();
    const root = makeTmpDir("legacy-generationless-shutdown");
    roots.push(root);
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "legacy-generationless-shutdown" }));
    const workspace = new Workspace(root);
    const runtime: RuntimeState = {
      service: SERVICE_NAME,
      version: "0.1.0",
      workspaceId: workspace.id,
      workspaceRoot: workspace.root,
      pid: 424242,
      port: 49077,
      adminToken: "legacy-admin-token",
      publicUrl: null,
      startedAt: new Date().toISOString(),
    };

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
        return new Response(
          JSON.stringify({
            service: SERVICE_NAME,
            workspaceId: workspace.id,
            workspaceRoot: workspace.root,
            pid: runtime.pid,
            port: runtime.port,
            startedAt: runtime.startedAt,
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });

    await expect(stopBridgeRuntime(workspace.root, runtime)).resolves.toBe(true);
    expect(shutdownAcknowledged).toBe(true);
    expect(infoCalls).toBeGreaterThanOrEqual(2);
  });
});
