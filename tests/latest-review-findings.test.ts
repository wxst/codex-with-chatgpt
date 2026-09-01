import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startBridge } from "../src/bridge/server.js";
import { writeRuntimeState, type RuntimeState } from "../src/bridge/runtime.js";
import { stopBridge, waitForBridgeStartup } from "../src/process/daemon.js";
import { getProcessGeneration } from "../src/process/process-identity.js";
import {
  completePendingStart,
  createPendingStart,
  listPendingStarts,
  requirePendingStart,
} from "../src/process/startup-registry.js";
import { openAITunnelTokenFile } from "../src/tunnel/transport-mode.js";
import { Workspace } from "../src/workspace/manager.js";
import { SERVICE_NAME } from "../src/version.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const roots: string[] = [];
const children: Array<ReturnType<typeof spawn>> = [];

function makeWorkspace(name: string): Workspace {
  const root = makeTmpDir(name);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return new Workspace(root);
}

async function processGeneration(pid: number): Promise<string> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const generation = getProcessGeneration(pid);
    if (generation) return generation;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Process generation unavailable for ${pid}`);
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not exit")), 4_000)),
  ]);
}

function runtimeFor(
  workspace: Workspace,
  pid: number,
  generation: string,
  port: number,
  suffix: string
): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: "0.1.0",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid,
    processGeneration: generation,
    port,
    adminToken: `c2c_admin_${suffix}`,
    publicUrl: null,
    startedAt: new Date(Date.now() + port).toISOString(),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  delete process.env.C2C_PENDING_START_ID;
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) cleanup(root);
});

describe("latest automated-review findings", () => {
  it("always lifecycle-fences a transport mode change, even with only a pending child", () => {
    const cliSource = fs.readFileSync(path.join(process.cwd(), "src", "cli", "index.ts"), "utf8");
    expect(cliSource).toContain("if (previous !== next) {\n          await stopBridge(root);");
    expect(cliSource).not.toContain("previous !== next && (await findLiveBridge");
  });

  it("cancels a pending start when the daemon health wait times out", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("startup-timeout-cancel");
    const pending = createPendingStart(workspace.id);

    await expect(
      waitForBridgeStartup(
        workspace,
        { exitCode: null },
        pending.startId,
        "test-daemon.log",
        {
          timeoutMs: 0,
          pollMs: 0,
          findLive: async () => null,
          sleep: async () => undefined,
        }
      )
    ).rejects.toThrow(/did not become healthy/);

    expect(listPendingStarts(workspace.id)).toEqual([]);
    expect(() => requirePendingStart(workspace.id, pending.startId)).toThrow(/cancelled|no longer valid/);
  });

  it("cancels a pending start when the daemon child exits unsuccessfully", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("startup-exit-cancel");
    const pending = createPendingStart(workspace.id);

    await expect(
      waitForBridgeStartup(
        workspace,
        { exitCode: 7 },
        pending.startId,
        "test-daemon.log",
        {
          timeoutMs: 100,
          pollMs: 0,
          findLive: async () => null,
          sleep: async () => undefined,
        }
      )
    ).rejects.toThrow(/exited with code 7/);

    expect(listPendingStarts(workspace.id)).toEqual([]);
  });

  it("stops a runtime when the child consumed its pending intent just before startup timeout cleanup", async () => {
    if (process.platform !== "linux") return;
    isolateStateDir();
    const workspace = makeWorkspace("startup-consumed-timeout");
    const pending = createPendingStart(workspace.id);
    completePendingStart(workspace.id, pending.startId);

    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");
    const generation = await processGeneration(child.pid);
    writeRuntimeState(runtimeFor(workspace, child.pid, generation, 49100, "consumed-timeout"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("startup endpoint unavailable"));

    await expect(
      waitForBridgeStartup(
        workspace,
        child,
        pending.startId,
        "test-daemon.log",
        {
          timeoutMs: 0,
          pollMs: 0,
          findLive: async () => null,
          sleep: async () => undefined,
        }
      )
    ).rejects.toThrow(/did not become healthy/);

    await waitForExit(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it("throws instead of reporting no Bridge when a discovered generation cannot be stopped", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("stop-failure-is-error");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    writeRuntimeState({
      ...runtimeFor(workspace, child.pid, "", 49105, "unstoppable-legacy"),
      service: "codex-with-chatgpt",
      processGeneration: undefined,
    });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("legacy endpoint unavailable"));

    await expect(stopBridge(workspace.root)).rejects.toThrow(/could not be fully stopped/);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it("cancels a pending detached start before reporting the workspace stopped", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("stop-pending-start");
    const pending = createPendingStart(workspace.id);
    expect(listPendingStarts(workspace.id).map((entry) => entry.startId)).toContain(pending.startId);

    expect(await stopBridge(workspace.root)).toBe(true);
    expect(listPendingStarts(workspace.id)).toEqual([]);
    expect(() => requirePendingStart(workspace.id, pending.startId)).toThrow(/cancelled|no longer valid/);

    process.env.C2C_PENDING_START_ID = pending.startId;
    await expect(
      startBridge({
        workspaceRoot: workspace.root,
        port: 0,
        transportMode: "openai",
        persistRuntime: false,
      })
    ).rejects.toThrow(/cancelled|no longer valid/);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });

  it("stops every persisted exact generation even when every admin/health probe is unavailable", async () => {
    if (process.platform !== "linux") return;
    isolateStateDir();
    const workspace = makeWorkspace("stop-all-generations");
    const first = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const second = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    children.push(first, second);
    if (!first.pid || !second.pid) throw new Error("child pid unavailable");

    writeRuntimeState(runtimeFor(workspace, first.pid, await processGeneration(first.pid), 49101, "first"));
    writeRuntimeState(runtimeFor(workspace, second.pid, await processGeneration(second.pid), 49102, "second"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("bridge endpoint wedged"));

    expect(await stopBridge(workspace.root)).toBe(true);
    await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(first.exitCode !== null || first.signalCode !== null).toBe(true);
    expect(second.exitCode !== null || second.signalCode !== null).toBe(true);
  });

  it("refuses replacement startup from process-generation evidence before creating tunnel credentials", async () => {
    if (process.platform !== "linux") return;
    isolateStateDir();
    const workspace = makeWorkspace("startup-generation-fence");
    const generation = await processGeneration(process.pid);
    writeRuntimeState(runtimeFor(workspace, process.pid, generation, 49111, "existing"));
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("existing bridge event loop paused"));

    await expect(
      startBridge({
        workspaceRoot: workspace.root,
        port: 0,
        transportMode: "openai",
        persistRuntime: true,
      })
    ).rejects.toThrow(/already active|may still be active/);

    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });
});
