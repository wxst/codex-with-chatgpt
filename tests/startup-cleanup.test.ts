import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getStateDir } from "../src/config/paths.js";
import { waitForBridgeStartup } from "../src/process/daemon.js";
import {
  openAITunnelTokenFile,
  OPENAI_TUNNEL_TOKEN_FILE_ENV,
  writeTransportMode,
} from "../src/tunnel/transport-mode.js";
import { Workspace } from "../src/workspace/manager.js";
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
  delete process.env.C2C_OPENAI_TUNNEL_TOKEN_FILE;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("failed Bridge startup cleanup", () => {
  it("hands the parent-selected tunnel token file to a detached Bridge", async () => {
    roots.push(isolateStateDir());
    const workspace = makeWorkspace("startup-token-file-handoff");
    const daemon = await import("../src/process/daemon.js");
    const buildEnvironment = (
      daemon as typeof daemon & {
        bridgeDaemonEnvironment?: (workspace: Workspace, base?: NodeJS.ProcessEnv) => NodeJS.ProcessEnv;
      }
    ).bridgeDaemonEnvironment;

    expect(buildEnvironment).toBeTypeOf("function");
    if (!buildEnvironment) return;

    const environment = buildEnvironment(workspace, {
      C2C_STATE_DIR: "child-would-resolve-another-directory",
      c2c_state_dir: "stale-state-directory",
      c2c_openai_tunnel_token_file: "stale-token-file",
    });
    expect(environment.C2C_STATE_DIR).toBe(getStateDir());
    expect(Object.keys(environment).filter((key) => key.toUpperCase() === "C2C_STATE_DIR")).toEqual([
      "C2C_STATE_DIR",
    ]);
    expect(environment.C2C_OPENAI_TUNNEL_TOKEN_FILE).toBe(openAITunnelTokenFile(workspace.id));
    expect(
      Object.keys(environment).filter(
        (key) => key.toUpperCase() === OPENAI_TUNNEL_TOKEN_FILE_ENV
      )
    ).toEqual([OPENAI_TUNNEL_TOKEN_FILE_ENV]);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });

  it("removes every case variant of the token file handoff outside OpenAI mode", async () => {
    roots.push(isolateStateDir());
    const workspace = makeWorkspace("startup-token-file-cloudflare");
    writeTransportMode(workspace.id, "cloudflare");
    const { bridgeDaemonEnvironment } = await import("../src/process/daemon.js");

    const environment = bridgeDaemonEnvironment(workspace, {
      c2c_openai_tunnel_token_file: "stale-token-file",
    });

    expect(
      Object.keys(environment).filter(
        (key) => key.toUpperCase() === OPENAI_TUNNEL_TOKEN_FILE_ENV
      )
    ).toEqual([]);
  });

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
