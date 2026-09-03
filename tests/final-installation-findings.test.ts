import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readRuntimeState,
  writeRuntimeState,
  type RuntimeState,
} from "../src/bridge/runtime.js";
import { stopBridge } from "../src/process/daemon.js";
import { requireCurrentProcessGeneration } from "../src/process/process-identity.js";
import {
  acquireWorkspaceLifecycleLock,
  type WorkspaceLifecycleLock,
} from "../src/process/workspace-lock.js";
import {
  ensureWorkspaceOpenAITunnelToken,
  switchWorkspaceTransport,
} from "../src/tunnel/switch-transport.js";
import {
  openAITunnelTokenFile,
  readTransportMode,
  writeTransportMode,
} from "../src/tunnel/transport-mode.js";
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

function runtimeFor(
  workspace: Workspace,
  overrides: Partial<RuntimeState> = {}
): RuntimeState {
  return {
    service: SERVICE_NAME,
    version: "0.1.0",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: process.pid,
    processGeneration: requireCurrentProcessGeneration(),
    port: 49201,
    adminToken: "c2c_admin_final_review",
    publicUrl: null,
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("serialized transport transactions", () => {
  it("does not let a concurrent same-target request observe provisional state", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("transport-concurrency");
    writeTransportMode(workspace.id, "cloudflare");

    let stopCalls = 0;
    let firstEntered!: () => void;
    let releaseFirst!: () => void;
    const entered = new Promise<void>((resolve) => {
      firstEntered = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const stop = async (): Promise<boolean> => {
      stopCalls += 1;
      if (stopCalls === 1) {
        firstEntered();
        await release;
        throw new Error("first transition could not stop the old bridge");
      }
      return false;
    };

    const first = switchWorkspaceTransport(workspace.root, "openai", { stopBridge: stop });
    await entered;

    let secondSettled = false;
    const second = switchWorkspaceTransport(workspace.root, "openai", { stopBridge: stop }).finally(() => {
      secondSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(secondSettled).toBe(false);

    releaseFirst();
    await expect(first).rejects.toThrow(/could not stop/);
    await expect(second).resolves.toMatchObject({ mode: "openai", changed: true });
    expect(stopCalls).toBe(2);
    expect(readTransportMode(workspace.id)).toBe("openai");
  });

  it("can lifecycle-fence an unchanged transport before a subordinate choice mutation", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("same-mode-fence");
    writeTransportMode(workspace.id, "cloudflare");
    let stopCalls = 0;

    const result = await switchWorkspaceTransport(workspace.root, "cloudflare", {
      forceFence: true,
      stopBridge: async () => {
        stopCalls += 1;
        return false;
      },
    });

    expect(stopCalls).toBe(1);
    expect(result).toEqual({ previous: "cloudflare", mode: "cloudflare", changed: false });
  });

  it("holds the lifecycle lock while a subordinate transport choice is committed", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("choice-lock");
    writeTransportMode(workspace.id, "cloudflare");

    let contenderSettled = false;
    let contender: Promise<WorkspaceLifecycleLock> | null = null;
    await switchWorkspaceTransport(workspace.root, "cloudflare", {
      forceFence: true,
      stopBridge: async () => false,
      afterFence: async () => {
        contender = acquireWorkspaceLifecycleLock(workspace.id).then((lock) => {
          contenderSettled = true;
          return lock;
        });
        await new Promise((resolve) => setTimeout(resolve, 75));
        expect(contenderSettled).toBe(false);
      },
    });

    expect(contender).not.toBeNull();
    const acquired = await contender!;
    expect(contenderSettled).toBe(true);
    acquired.release();
  });

  it("serializes OpenAI token creation with workspace revocation and lifecycle mutation", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("token-lock");
    writeTransportMode(workspace.id, "openai");
    const tokenFile = openAITunnelTokenFile(workspace.id);
    const lock = await acquireWorkspaceLifecycleLock(workspace.id);

    let settled = false;
    const tokenPromise = ensureWorkspaceOpenAITunnelToken(workspace.root).finally(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(settled).toBe(false);
    expect(fs.existsSync(tokenFile)).toBe(false);

    lock.release();
    await expect(tokenPromise).resolves.toMatch(/^c2c_tunnel_/);
    expect(fs.existsSync(tokenFile)).toBe(true);
  });
});

describe("runtime compatibility cleanup", () => {
  it("treats a generationless legacy runtime with a positively absent PID as stopped", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("dead-legacy-runtime");
    writeRuntimeState(
      runtimeFor(workspace, {
        service: "codex-with-chatgpt",
        pid: 2_147_483_647,
        processGeneration: undefined,
        port: 49202,
        startedAt: "2026-01-01T00:00:00.000Z",
      })
    );
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("legacy endpoint is gone"));

    await expect(stopBridge(workspace.root)).resolves.toBe(true);
  });

  it("refreshes a generation-bearing canonical mirror after its exact process is dead", () => {
    isolateStateDir();
    const workspace = makeWorkspace("dead-hardened-mirror");
    writeRuntimeState(
      runtimeFor(workspace, {
        pid: 2_147_483_647,
        processGeneration: "linux:dead-hardened-generation",
        port: 49203,
        startedAt: "2026-01-01T00:00:00.000Z",
      })
    );

    const current = runtimeFor(workspace, {
      port: 49204,
      startedAt: "2026-01-02T00:00:00.000Z",
    });
    writeRuntimeState(current);

    expect(readRuntimeState(workspace.id)?.pid).toBe(current.pid);
    expect(readRuntimeState(workspace.id)?.port).toBe(current.port);
    expect(readRuntimeState(workspace.id)?.processGeneration).toBe(current.processGeneration);
  });
});

describe("CLI recovery contracts", () => {
  it("supports machine-readable unpair", () => {
    const cli = fs.readFileSync(path.join(process.cwd(), "src", "cli", "index.ts"), "utf8");
    expect(cli).toMatch(/\.command\("unpair"\)[\s\S]*?\.option\("--json"/u);
    expect(cli).toMatch(/handleCliError\(error, opts\.json\)/u);
  });

  it("fences Cloudflare quick/named choice changes and commits them inside the transaction", () => {
    const cli = fs
      .readFileSync(path.join(process.cwd(), "src", "cli", "index.ts"), "utf8")
      .replace(/\r\n?/gu, "\n");
    const chooseStart = cli.indexOf('tunnelCmd\n  .command("choose")'.replace("\\n", "\n"));
    const chooseEnd = cli.indexOf('tunnelCmd\n  .command("login")'.replace("\\n", "\n"), chooseStart);
    const choose = cli.slice(chooseStart, chooseEnd);

    expect(chooseStart).toBeGreaterThanOrEqual(0);
    expect(chooseEnd).toBeGreaterThan(chooseStart);
    expect(choose.match(/switchWorkspaceTransport\(root, "cloudflare"/gu)?.length).toBe(2);
    expect(choose.match(/forceFence: true/gu)?.length).toBe(2);
    expect(choose.match(/afterFence:/gu)?.length).toBe(2);
    expect(choose).not.toContain("findLiveBridge");
  });
});
