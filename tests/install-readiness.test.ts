import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { switchWorkspaceTransport } from "../src/tunnel/switch-transport.js";
import {
  openAITunnelTokenFile,
  readTransportMode,
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
  for (const root of roots.splice(0)) cleanup(root);
});

describe("transactional transport switching", () => {
  it("restores the previous mode when lifecycle-fenced shutdown fails", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("transport-rollback");
    writeTransportMode(workspace.id, "cloudflare");

    await expect(
      switchWorkspaceTransport(workspace.root, "openai", {
        stopBridge: async () => {
          throw new Error("old bridge survived");
        },
      })
    ).rejects.toThrow(/old bridge survived/);

    expect(readTransportMode(workspace.id)).toBe("cloudflare");
    expect(fs.existsSync(openAITunnelTokenFile(workspace.id))).toBe(false);
  });

  it("commits the new mode only after shutdown completes", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("transport-commit");
    writeTransportMode(workspace.id, "cloudflare");
    const observedModes: string[] = [];

    const result = await switchWorkspaceTransport(workspace.root, "openai", {
      stopBridge: async () => {
        observedModes.push(readTransportMode(workspace.id));
        return true;
      },
    });

    expect(observedModes).toEqual(["openai"]);
    expect(result).toEqual({ previous: "cloudflare", mode: "openai", changed: true });
    expect(readTransportMode(workspace.id)).toBe("openai");
  });

  it("does not stop the workspace when the selected mode is unchanged", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("transport-noop");
    writeTransportMode(workspace.id, "openai");
    let stopCalls = 0;

    const result = await switchWorkspaceTransport(workspace.root, "openai", {
      stopBridge: async () => {
        stopCalls += 1;
        return true;
      },
    });

    expect(stopCalls).toBe(0);
    expect(result).toEqual({ previous: "openai", mode: "openai", changed: false });
  });

  it("routes both transport commands through the transactional helper", () => {
    const cli = fs.readFileSync(path.join(process.cwd(), "src", "cli", "index.ts"), "utf8");
    expect(cli).not.toContain('writeTransportMode(workspace.id, "cloudflare")');
    expect(cli.match(/switchWorkspaceTransport\(root,/gu)?.length).toBeGreaterThanOrEqual(2);
  });
});

describe("installation documentation contract", () => {
  const read = (file: string): string => fs.readFileSync(path.join(process.cwd(), file), "utf8");

  it("installs the hardened fork without assuming a global c2c binary", () => {
    const english = read("README.md");
    const chinese = read("README.zh-CN.md");
    const skill = read("skill/SKILL.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).toContain("https://github.com/wxst/codex-with-chatgpt");
    expect(combined).not.toContain("https://github.com/XiaoDuoYa/codex-with-chatgpt");
    expect(combined).toContain("node bin/c2c.js");
    expect(skill).toContain("__C2C_CHECKOUT__");
    expect(skill).toContain('node "__C2C_CHECKOUT__/bin/c2c.js"');
  });

  it("does not reintroduce runtime self-updates or implicit Cloudflare setup", () => {
    const english = read("README.md");
    const chinese = read("README.zh-CN.md");
    const combined = `${english}\n${chinese}`;

    expect(combined).not.toContain("每天自动检查一次 GitHub");
    expect(combined).not.toContain("git pull 更新");
    expect(combined).not.toContain("install cloudflared");
    expect(combined).not.toContain("同时安装 cloudflared");
    expect(combined).toContain("OpenAI Secure MCP Tunnel");
    expect(combined).toContain("Cloudflare");
    expect(combined).toContain("explicit");
  });
});

describe("release automation contract", () => {
  it("contains no consumed one-shot write workflow", () => {
    expect(fs.existsSync(path.join(process.cwd(), ".github", "workflows", "update-stop-tests.yml"))).toBe(false);
  });

  it("runs a clean installation smoke test on Linux and Windows", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const ci = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");

    expect(pkg.scripts?.["smoke:install"]).toBe("node scripts/install-smoke.mjs");
    expect(ci).toContain("ubuntu-24.04");
    expect(ci).toContain("windows-latest");
    expect(ci).toContain("Install smoke test");
    expect(ci).toContain("pnpm smoke:install");
  });
});
