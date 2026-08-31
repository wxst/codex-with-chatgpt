import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../src/workspace/manager.js";
import {
  ensureOpenAITunnelToken,
  openAITunnelTokenFile,
  revokeOpenAITunnelToken,
  writeTransportMode,
} from "../src/tunnel/transport-mode.js";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
import { cleanup, isolateStateDir, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

function makeWorkspace(name: string): Workspace {
  const root = makeTmpDir(name);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return new Workspace(root);
}

function fakeRuntime(workspace: Workspace) {
  return {
    service: "codex-with-chatgpt",
    version: "0.1.0",
    workspaceId: workspace.id,
    workspaceRoot: workspace.root,
    pid: 424242,
    port: 48765,
    adminToken: "test",
    publicUrl: null,
    startedAt: new Date().toISOString(),
  };
}

function liveThenDown(workspace: Workspace) {
  const runtime = fakeRuntime(workspace);
  let calls = 0;
  return async () => (++calls === 1 ? runtime : null);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.C2C_STATE_DIR;
  for (const root of roots.splice(0)) cleanup(root);
});

describe("review finding: OpenAI tunnel credential revocation", () => {
  it("removes the current token and regenerates a different credential", () => {
    isolateStateDir();
    const workspace = makeWorkspace("revoke-token");
    const before = ensureOpenAITunnelToken(workspace.id);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(true);
    expect(revokeOpenAITunnelToken(workspace.id)).toBe(true);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
    expect(ensureOpenAITunnelToken(workspace.id)).not.toBe(before);
  });

  it("stops a live OpenAI bridge, deletes its tunnel credential, and revokes legacy tokens", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-openai");
    writeTransportMode(workspace.id, "openai");
    const before = ensureOpenAITunnelToken(workspace.id);
    let revokedLegacy = false;
    let stopped = false;

    const result = await revokeWorkspaceAccess(workspace.root, {
      findLiveBridge: liveThenDown(workspace),
      adminFetch: async () => {
        revokedLegacy = true;
        return { revoked: 1 };
      },
      stopBridge: async () => {
        stopped = true;
        return true;
      },
    });

    expect(revokedLegacy).toBe(true);
    expect(stopped).toBe(true);
    expect(result.transportMode).toBe("openai");
    expect(result.tunnelCredentialRevoked).toBe(true);
    expect(result.bridgeStopped).toBe(true);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
    expect(ensureOpenAITunnelToken(workspace.id)).not.toBe(before);
  });

  it("revokes a dormant OpenAI token even when the current transport is Cloudflare", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-dormant-openai");
    writeTransportMode(workspace.id, "openai");
    ensureOpenAITunnelToken(workspace.id);
    writeTransportMode(workspace.id, "cloudflare");

    const result = await revokeWorkspaceAccess(workspace.root, {
      findLiveBridge: async () => null,
      authStoreFactory: () => ({ revokeAll: () => 0 }),
    });

    expect(result.transportMode).toBe("cloudflare");
    expect(result.tunnelCredentialRevoked).toBe(true);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });

  it("stops a live bridge even when persisted transport state says Cloudflare", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-state-drift");
    writeTransportMode(workspace.id, "openai");
    ensureOpenAITunnelToken(workspace.id);
    writeTransportMode(workspace.id, "cloudflare");
    let stopped = false;

    const result = await revokeWorkspaceAccess(workspace.root, {
      findLiveBridge: liveThenDown(workspace),
      adminFetch: async () => ({ revoked: 0 }),
      stopBridge: async () => {
        stopped = true;
        return true;
      },
    });

    expect(result.transportMode).toBe("cloudflare");
    expect(stopped).toBe(true);
    expect(result.bridgeStopped).toBe(true);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });

  it("deletes the tunnel credential and stops the bridge even when OAuth revocation fails", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-oauth-failure");
    writeTransportMode(workspace.id, "openai");
    ensureOpenAITunnelToken(workspace.id);
    let stopped = false;

    await expect(
      revokeWorkspaceAccess(workspace.root, {
        findLiveBridge: liveThenDown(workspace),
        adminFetch: async () => {
          throw new Error("admin timeout");
        },
        stopBridge: async () => {
          stopped = true;
          return true;
        },
      })
    ).rejects.toThrow(/Failed to fully revoke/);

    expect(stopped).toBe(true);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });

  it("falls back to persisted OAuth revocation after live admin revocation fails", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-oauth-persisted-fallback");
    writeTransportMode(workspace.id, "openai");
    ensureOpenAITunnelToken(workspace.id);
    let persistedRevoked = false;

    await expect(
      revokeWorkspaceAccess(workspace.root, {
        findLiveBridge: liveThenDown(workspace),
        adminFetch: async () => {
          throw new Error("admin timeout");
        },
        authStoreFactory: () => ({
          revokeAll: () => {
            persistedRevoked = true;
            return 2;
          },
        }),
        stopBridge: async () => true,
      })
    ).rejects.toThrow(/Failed to fully revoke/);

    expect(persistedRevoked).toBe(true);
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });

  it("still stops the bridge when tunnel credential deletion fails", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-token-delete-failure");
    writeTransportMode(workspace.id, "openai");
    let stopped = false;

    await expect(
      revokeWorkspaceAccess(workspace.root, {
        findLiveBridge: liveThenDown(workspace),
        adminFetch: async () => ({ revoked: 0 }),
        revokeTunnelToken: () => {
          throw new Error("unlink denied");
        },
        stopBridge: async () => {
          stopped = true;
          return true;
        },
      })
    ).rejects.toThrow(/Failed to fully revoke/);

    expect(stopped).toBe(true);
  });

  it("removes the persisted tunnel credential even when bridge shutdown reports failure", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-stop-failure");
    writeTransportMode(workspace.id, "openai");
    ensureOpenAITunnelToken(workspace.id);

    await expect(
      revokeWorkspaceAccess(workspace.root, {
        findLiveBridge: liveThenDown(workspace),
        adminFetch: async () => ({ revoked: 0 }),
        stopBridge: async () => false,
      })
    ).rejects.toThrow(/Failed to fully revoke/);

    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });

  it("uses persisted runtime/PID state instead of health to find and confirm a bridge", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-process-state");
    writeTransportMode(workspace.id, "openai");
    ensureOpenAITunnelToken(workspace.id);
    const runtime = fakeRuntime(workspace);
    let stopped = false;
    let pidChecks = 0;

    const result = await revokeWorkspaceAccess(
      workspace.root,
      {
        // A health-based discovery path says the bridge is unavailable.
        findLiveBridge: async () => null,
        stopBridge: async () => {
          stopped = true;
          return true;
        },
        authStoreFactory: () => ({ revokeAll: () => 0 }),
        // Future hardened path: the runtime file still identifies the process.
        readRuntimeState: () => runtime,
        isProcessAlive: () => {
          pidChecks += 1;
          return pidChecks < 2;
        },
        sleep: async () => undefined,
      } as never
    );

    expect(stopped).toBe(true);
    expect(pidChecks).toBeGreaterThanOrEqual(2);
    expect(result.bridgeStopped).toBe(true);
  });

  it("wires the CLI unpair command through the hardened revocation path", () => {
    const cli = fs.readFileSync(path.join(projectRoot, "src", "cli", "index.ts"), "utf8");
    expect(cli).toContain("await revokeWorkspaceAccess(root)");
  });
});

describe("review finding: reused token permissions", () => {
  it("repairs an existing valid token file back to owner-only permissions", () => {
    isolateStateDir();
    const workspace = makeWorkspace("token-mode");
    const file = openAITunnelTokenFile(workspace.id);
    const token = "c2c_tunnel_" + "a".repeat(43);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token + "\n", { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    expect(ensureOpenAITunnelToken(workspace.id)).toBe(token);
    if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("fails closed on POSIX when an existing token cannot be repaired to 0600", () => {
    if (process.platform === "win32") return;
    isolateStateDir();
    const workspace = makeWorkspace("token-mode-failure");
    const file = openAITunnelTokenFile(workspace.id);
    const token = "c2c_tunnel_" + "b".repeat(43);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, token + "\n", { mode: 0o644 });
    vi.spyOn(fs, "chmodSync").mockImplementation(() => {
      throw new Error("chmod denied");
    });
    expect(() => ensureOpenAITunnelToken(workspace.id)).toThrow(/chmod denied/);
  });
});

describe("review finding: staged upstream merge validation", () => {
  it("checks the cached merge diff for whitespace errors", () => {
    const workflow = fs.readFileSync(path.join(projectRoot, ".github", "workflows", "upstream-sync.yml"), "utf8");
    expect(workflow).toContain("git diff --cached --check");
  });
});
