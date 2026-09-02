import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { waitForBridgeStartup } from "../src/process/daemon.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const roots: string[] = [];

function makeWorkspace(name: string): Workspace {
  const root = makeTmpDir(name);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return new Workspace(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe("failed Bridge startup cleanup", () => {
  it("surfaces an aggregate error when lifecycle-fenced cleanup also fails", async () => {
    const workspace = makeWorkspace("startup-cleanup-failure");
    let cleanupCalls = 0;

    const promise = waitForBridgeStartup(
      workspace,
      { exitCode: 17 },
      "pending-start-id",
      path.join(workspace.root, "bridge.log"),
      {
        timeoutMs: 100,
        pollMs: 1,
        findLive: async () => null,
        sleep: async () => undefined,
        stopBridge: async () => {
          cleanupCalls += 1;
          throw new Error("exact Bridge generation survived cleanup");
        },
      }
    );

    await expect(promise).rejects.toMatchObject({
      name: "AggregateError",
      message: "Bridge startup failed and the workspace could not be fully fenced during cleanup",
    });
    expect(cleanupCalls).toBe(1);
  });

  it("preserves the original startup error after confirmed cleanup", async () => {
    const workspace = makeWorkspace("startup-cleanup-noop");
    let cleanupCalls = 0;

    const promise = waitForBridgeStartup(
      workspace,
      { exitCode: 23 },
      "pending-start-id",
      path.join(workspace.root, "bridge.log"),
      {
        timeoutMs: 100,
        pollMs: 1,
        findLive: async () => null,
        sleep: async () => undefined,
        stopBridge: async () => {
          cleanupCalls += 1;
          return true;
        },
      }
    );

    await expect(promise).rejects.toThrow(/Bridge process exited with code 23/);
    expect(cleanupCalls).toBe(1);
  });

  it("runs lifecycle-fenced cleanup after a health timeout", async () => {
    const workspace = makeWorkspace("startup-cleanup-timeout");
    let cleanupCalls = 0;

    const promise = waitForBridgeStartup(
      workspace,
      { exitCode: null },
      "pending-start-id",
      path.join(workspace.root, "bridge.log"),
      {
        timeoutMs: 0,
        pollMs: 1,
        findLive: async () => null,
        sleep: async () => undefined,
        stopBridge: async () => {
          cleanupCalls += 1;
          return true;
        },
      }
    );

    await expect(promise).rejects.toThrow(/did not become healthy/);
    expect(cleanupCalls).toBe(1);
  });
});
