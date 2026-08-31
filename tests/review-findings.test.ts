import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
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

    const after = ensureOpenAITunnelToken(workspace.id);
    expect(after).not.toBe(before);
  });

  it("makes unpair-style revocation stop a live OpenAI bridge and revoke legacy tokens", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("unpair-openai");
    writeTransportMode(workspace.id, "openai");
    const before = ensureOpenAITunnelToken(workspace.id);

    let revokedLegacy = false;
    let stopped = false;
    const fakeRuntime = { port: 48765, adminToken: "test" } as never;

    const result = await revokeWorkspaceAccess(workspace.root, {
      findLiveBridge: async () => fakeRuntime,
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
    if (process.platform !== "win32") {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
  });
});

describe("review finding: staged upstream merge validation", () => {
  it("checks the cached merge diff for whitespace errors", () => {
    const workflow = fs.readFileSync(path.join(projectRoot, ".github", "workflows", "upstream-sync.yml"), "utf8");
    expect(workflow).toContain("git diff --cached --check");
  });
});
