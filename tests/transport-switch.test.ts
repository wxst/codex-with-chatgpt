import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { switchWorkspaceTransport } from "../src/tunnel/switch-transport.js";
import {
  readTransportMode,
  transportStateFile,
  writeTransportMode,
} from "../src/tunnel/transport-mode.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

function makeWorkspace(name: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

function isolateTestState(): void {
  roots.push(isolateStateDir());
}

describe("transactional transport switching", () => {
  it("persists the requested mode after the workspace is fully fenced", async () => {
    isolateTestState();
    const root = makeWorkspace("transport-success");
    const workspace = new Workspace(root);
    writeTransportMode(workspace.id, "cloudflare");
    let stopCalls = 0;

    const result = await switchWorkspaceTransport(root, "openai", {
      stopBridge: async () => {
        stopCalls += 1;
        return true;
      },
    });

    expect(result).toEqual({
      previous: "cloudflare",
      mode: "openai",
      changed: true,
    });
    expect(readTransportMode(workspace.id)).toBe("openai");
    expect(stopCalls).toBe(1);
  });

  it("restores the previous mode when workspace fencing fails", async () => {
    isolateTestState();
    const root = makeWorkspace("transport-rollback");
    const workspace = new Workspace(root);
    writeTransportMode(workspace.id, "cloudflare");

    await expect(
      switchWorkspaceTransport(root, "openai", {
        stopBridge: async () => {
          throw new Error("old bridge survived");
        },
      })
    ).rejects.toThrow(/old bridge survived/);

    expect(readTransportMode(workspace.id)).toBe("cloudflare");
  });

  it("surfaces both the fencing and rollback failures", async () => {
    isolateTestState();
    const root = makeWorkspace("transport-rollback-failure");
    const workspace = new Workspace(root);
    writeTransportMode(workspace.id, "cloudflare");
    const stateFile = transportStateFile(workspace.id);
    const originalRename = fs.renameSync;
    let commits = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((source, destination) => {
      if (path.resolve(String(destination)) === path.resolve(stateFile)) {
        commits += 1;
        if (commits === 2) throw new Error("rollback write failed");
      }
      return originalRename(source, destination);
    });

    await expect(
      switchWorkspaceTransport(root, "openai", {
        stopBridge: async () => {
          throw new Error("old bridge survived");
        },
      })
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof AggregateError &&
        error.errors.some((entry) => /old bridge survived/.test(String(entry))) &&
        error.errors.some((entry) => /rollback write failed/.test(String(entry)))
      );
    });

    expect(commits).toBe(2);
  });

  it("does not stop or rewrite an unchanged mode", async () => {
    isolateTestState();
    const root = makeWorkspace("transport-noop");
    const workspace = new Workspace(root);
    writeTransportMode(workspace.id, "openai");
    const stateFile = transportStateFile(workspace.id);
    const originalWrite = fs.writeFileSync;
    let writes = 0;
    let stopCalls = 0;
    vi.spyOn(fs, "writeFileSync").mockImplementation((file, data, options) => {
      if (path.resolve(String(file)) === path.resolve(stateFile)) writes += 1;
      return originalWrite(file, data, options);
    });

    const result = await switchWorkspaceTransport(root, "openai", {
      stopBridge: async () => {
        stopCalls += 1;
        return true;
      },
    });

    expect(result.changed).toBe(false);
    expect(writes).toBe(0);
    expect(stopCalls).toBe(0);
  });

  it("routes the CLI transport command through the transactional helper", () => {
    const cli = fs.readFileSync(path.join(projectRoot, "src", "cli", "index.ts"), "utf8");
    expect(cli).toContain('from "../tunnel/switch-transport.js"');
    expect(cli).toContain("await switchWorkspaceTransport(root, next)");
  });
});
