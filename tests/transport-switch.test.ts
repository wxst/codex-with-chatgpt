import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { switchWorkspaceTransport } from "../src/tunnel/switch-transport.js";
import type { TransportMode } from "../src/tunnel/transport-mode.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];

function makeWorkspace(name: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name }));
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe("transactional transport switching", () => {
  it("persists the requested mode after the workspace is fully fenced", async () => {
    const root = makeWorkspace("transport-success");
    let mode: TransportMode = "cloudflare";
    const writes: TransportMode[] = [];
    let stopCalls = 0;

    const result = await switchWorkspaceTransport(root, "openai", {
      readMode: () => mode,
      writeMode: (_workspaceId, next) => {
        writes.push(next);
        mode = next;
      },
      stopWorkspace: async () => {
        stopCalls += 1;
        return true;
      },
    });

    expect(result).toEqual({
      previous: "cloudflare",
      mode: "openai",
      changed: true,
      bridgeActivityStopped: true,
    });
    expect(mode).toBe("openai");
    expect(writes).toEqual(["openai"]);
    expect(stopCalls).toBe(1);
  });

  it("restores the previous mode when workspace fencing fails", async () => {
    const root = makeWorkspace("transport-rollback");
    let mode: TransportMode = "cloudflare";
    const writes: TransportMode[] = [];

    await expect(
      switchWorkspaceTransport(root, "openai", {
        readMode: () => mode,
        writeMode: (_workspaceId, next) => {
          writes.push(next);
          mode = next;
        },
        stopWorkspace: async () => {
          throw new Error("old bridge survived");
        },
      })
    ).rejects.toThrow(/restored cloudflare/);

    expect(mode).toBe("cloudflare");
    expect(writes).toEqual(["openai", "cloudflare"]);
  });

  it("surfaces both the fencing and rollback failures", async () => {
    const root = makeWorkspace("transport-rollback-failure");
    let writes = 0;

    await expect(
      switchWorkspaceTransport(root, "openai", {
        readMode: () => "cloudflare",
        writeMode: () => {
          writes += 1;
          if (writes === 2) throw new Error("rollback write failed");
        },
        stopWorkspace: async () => {
          throw new Error("old bridge survived");
        },
      })
    ).rejects.toBeInstanceOf(AggregateError);

    expect(writes).toBe(2);
  });

  it("does not stop or rewrite an unchanged mode", async () => {
    const root = makeWorkspace("transport-noop");
    let writes = 0;
    let stopCalls = 0;

    const result = await switchWorkspaceTransport(root, "openai", {
      readMode: () => "openai",
      writeMode: () => {
        writes += 1;
      },
      stopWorkspace: async () => {
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
