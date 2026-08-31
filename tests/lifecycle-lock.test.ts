import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { acquireWorkspaceLifecycleLock } from "../src/process/workspace-lock.js";
import { ensureBridge } from "../src/process/daemon.js";
import { revokeWorkspaceAccess } from "../src/auth/revoke.js";
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
  for (const root of roots.splice(0)) cleanup(root);
});

describe("workspace lifecycle serialization", () => {
  it("blocks revocation while the same workspace lifecycle lock is held", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-revoke");
    const held = await acquireWorkspaceLifecycleLock(workspace.id, { timeoutMs: 1000, pollMs: 5 });
    let enteredRevocation = false;

    const pending = revokeWorkspaceAccess(workspace.root, {
      readRuntimeState: () => {
        enteredRevocation = true;
        return null;
      },
      authStoreFactory: () => ({ revokeAll: () => 0 }),
      revokeTunnelToken: () => false,
      sleep: async () => undefined,
    });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(enteredRevocation).toBe(false);

    held.release();
    await pending;
    expect(enteredRevocation).toBe(true);
  });

  it("serializes concurrent ensureBridge calls so only one startup path wins", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("lifecycle-start");
    const first = ensureBridge(workspace.root);
    const second = ensureBridge(workspace.root);

    const [a, b] = await Promise.all([first, second]);
    expect(a.runtime.workspaceId).toBe(workspace.id);
    expect(b.runtime.workspaceId).toBe(workspace.id);
    expect(a.runtime.pid).toBe(b.runtime.pid);
    expect([a.spawned, b.spawned].filter(Boolean)).toHaveLength(1);
  }, 30_000);
});

describe("daemon source-mode fallback", () => {
  it("retains the TypeScript/tsx fallback when dist CLI is absent", () => {
    const source = fs.readFileSync(path.resolve("src/process/daemon.ts"), "utf8");
    expect(source).toContain("fs.existsSync(distEntry)");
    expect(source).toContain('"--import", "tsx/esm"');
    expect(source).toContain('"src", "cli", "index.ts"');
  });
});
