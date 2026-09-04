import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { waitForBridgeStartup } from "../src/process/daemon.js";
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

describe("failed-start cleanup", () => {
  it("reports an aggregate cleanup failure when the stop fence returns false", async () => {
    isolateStateDir();
    const workspace = makeWorkspace("startup-cleanup-false");

    await expect(
      waitForBridgeStartup(workspace, { exitCode: null }, "missing-start", "bridge.log", {
        timeoutMs: 0,
        pollMs: 0,
        findLive: async () => null,
        sleep: async () => undefined,
        stopBridge: async () => false,
      })
    ).rejects.toSatisfy((error: unknown) => {
      return (
        error instanceof AggregateError &&
        /could not be fully fenced/u.test(error.message) &&
        error.errors.some((entry) => /did not become healthy/u.test(String(entry))) &&
        error.errors.some((entry) => /cleanup was not confirmed/u.test(String(entry)))
      );
    });
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

  it("checks an existing managed runtime before requesting tunnel credentials", () => {
    const skill = read("skill/SKILL.md");
    const statusCheck = skill.indexOf("tunnel-client runtimes status <runtimeAlias> --json");
    const credentialCheck = skill.indexOf("When a start or reconnect is required");

    expect(statusCheck).toBeGreaterThan(-1);
    expect(credentialCheck).toBeGreaterThan(statusCheck);
    expect(skill).toContain(
      "Missing control-plane variables in the current Codex process are not a failure when that managed runtime is already healthy"
    );
    expect(skill).toContain("process_running, healthy, ready, and stale");

    for (const file of ["README.md", "README.zh-CN.md"]) {
      const instructions = read(file);
      const readmeStatusCheck = instructions.indexOf("tunnel-client runtimes status <runtimeAlias> --json");
      const readmeCredentialCheck = instructions.indexOf("CONTROL_PLANE_TUNNEL_ID");
      expect(readmeStatusCheck, file).toBeGreaterThan(-1);
      expect(readmeCredentialCheck, file).toBeGreaterThan(readmeStatusCheck);
    }
  });

  it("routes task-owned standby Chats through the direct host channel", () => {
    const skill = read("skill/SKILL.md");
    const architecture = read("docs/architecture.md");
    const protocol = read("docs/protocol.md");
    const cli = read("src/cli/index.ts");
    const sessionState = read("src/session/state.ts");
    const verifier = read("scripts/verify-codex-app-host.mjs");

    expect(skill).toContain("C2C_STANDBY_READY");
    expect(skill).toContain("session pool claim");
    expect(skill).toContain("C2C_ROUTE_TOKEN");
    expect(skill).toContain("route_token");
    expect(skill).toContain("send_message_to_thread");
    expect(skill).toContain("read_thread");
    expect(skill).toContain("Do not use `wait_threads` for ChatGPT Chats");
    expect(cli).toContain('.command("router")');
    expect(cli).toContain('session.command("pool")');
    expect(cli).toContain('pool.command("claim")');
    expect(cli).toContain('pool.command("import")');
    expect(cli).not.toContain('.command("bootstrap-start")');
    expect(protocol).toContain("ROUTE_ACCESS_DENIED");
    expect(protocol).toContain("C2C_STANDBY_READY_PRO");
    expect(architecture).toContain("Global C2C Router");
    expect(sessionState).toContain("claimStandbyConversation");
    expect(sessionState).toContain("routeCapabilityId");
    expect(verifier).toContain('"list_threads"');
    expect(verifier).toContain('"read_thread"');
    expect(verifier).toContain('"send_message_to_thread"');
    expect(verifier).not.toContain("create_chatgpt_conversation");
  });

  it("keeps maximum ChatGPT reasoning offload with repository-aware sources and one writer", () => {
    const skill = read("skill/SKILL.md");
    expect(skill).toContain("GitHub connector");
    expect(skill).toContain("mem / OpenDeepWiki");
    expect(skill).toContain("current C2C workspace is final authority");
    expect(skill).toContain("Only the main coordinating agent");
    expect(skill).toContain("Subagents return findings");
    expect(skill).toContain("one in-flight request");
    expect(skill).toContain("xhigh");
    expect(skill).toContain("Pro");
  });
  it("documents the two-view Windows legacy cleanup command", () => {
    const cli = read("src/cli/index.ts");
    const troubleshooting = read("docs/troubleshooting.md");

    expect(cli).toContain('.command("legacy-cleanup")');
    expect(troubleshooting).toContain("c2c legacy-cleanup -w <workspace>");
    expect(troubleshooting).toContain("inside packaged Codex or ChatGPT");
  });

  it("validates the legacy view before selecting it as active state", () => {
    const cli = read("src/cli/index.ts");
    const revokeSource = read("src/auth/revoke.ts");
    const command = cli.indexOf('.command("legacy-cleanup")');
    const dedicatedCall = cli.indexOf("revokeLegacyWindowsWorkspaceAccess(root)", command);
    const dedicatedFunction = revokeSource.indexOf("function revokeLegacyWindowsWorkspaceAccess");
    const outerPreflight = revokeSource.indexOf(
      "validateLegacyWindowsStateForCleanup",
      dedicatedFunction
    );
    const stateSelection = revokeSource.indexOf(
      "process.env.C2C_STATE_DIR = preflight.legacyRoot",
      outerPreflight
    );
    const lifecycleLock = revokeSource.indexOf("withWorkspaceLifecycleLock", stateSelection);
    const lockedPreflight = revokeSource.indexOf(
      "validateLegacyWindowsStateForCleanup",
      lifecycleLock
    );
    const revokeLocked = revokeSource.indexOf(
      "revokeWorkspaceAccessLocked(identity",
      lockedPreflight
    );
    const cleanupLocked = revokeSource.indexOf(
      "cleanupLegacyWindowsWorkspaceArtifacts(workspaceId,",
      revokeLocked
    );
    const cleanupUsesLockNonce = revokeSource.indexOf(
      "activeLifecycleNonce: lock.nonce",
      cleanupLocked
    );
    const finalPostflight = revokeSource.indexOf(
      "const postflight = validateLegacyWindowsStateForCleanup",
      cleanupUsesLockNonce
    );

    expect(command).toBeGreaterThan(-1);
    expect(dedicatedCall).toBeGreaterThan(command);
    expect(dedicatedFunction).toBeGreaterThan(-1);
    expect(outerPreflight).toBeGreaterThan(dedicatedFunction);
    expect(stateSelection).toBeGreaterThan(outerPreflight);
    expect(lifecycleLock).toBeGreaterThan(stateSelection);
    expect(lockedPreflight).toBeGreaterThan(lifecycleLock);
    expect(revokeLocked).toBeGreaterThan(lockedPreflight);
    expect(cleanupLocked).toBeGreaterThan(revokeLocked);
    expect(cleanupUsesLockNonce).toBeGreaterThan(cleanupLocked);
    expect(finalPostflight).toBeGreaterThan(cleanupUsesLockNonce);
  });

  it("keeps Windows ACL inspection input out of the CreateProcess environment", () => {
    const legacyState = read("src/config/legacy-state.ts");

    expect(legacyState).not.toContain("C2C_LEGACY_ACL_TARGETS");
    expect(legacyState).toContain("[Console]::In.ReadToEnd()");
    expect(legacyState).toContain("[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)");
    expect(legacyState).toContain("WINDOWS_ACL_TARGET_BATCH_SIZE");
    expect(legacyState).toContain("WINDOWS_ACL_MAX_TARGETS");
    expect(legacyState).toContain("bounded inspection limit");
    expect(legacyState).toContain("input: JSON.stringify(batch)");
  });
});

describe("release automation contract", () => {
  it("contains no consumed one-shot write workflow", () => {
    for (const workflow of [
      "apply-install-readiness-patch.yml",
      "finalize-install-readiness.yml",
      "update-stop-tests.yml",
    ]) {
      expect(fs.existsSync(path.join(process.cwd(), ".github", "workflows", workflow))).toBe(false);
    }
  });

  it("runs a clean installation smoke test on Linux and Windows", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
    };
    const ci = fs.readFileSync(path.join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const installSmoke = fs.readFileSync(
      path.join(process.cwd(), ".github", "workflows", "install-smoke.yml"),
      "utf8"
    );
    const installSmokeScript = fs.readFileSync(
      path.join(process.cwd(), "scripts", "install-smoke.mjs"),
      "utf8"
    );

    expect(pkg.scripts?.["smoke:install"]).toBe("node scripts/install-smoke.mjs");
    expect(ci).toContain("ubuntu-24.04");
    expect(ci).toContain("windows-latest");
    expect(ci).toContain("Install smoke test");
    expect(ci).toContain("pnpm smoke:install");
    expect(installSmoke).toContain("pnpm smoke:install");
    expect(installSmoke).not.toContain("pnpm test:install");
    expect(installSmokeScript).toContain('["session", "--help"]');
    expect(installSmokeScript).toContain('["session", "pool", "--help"]');
    expect(installSmokeScript).toContain("confirm-send-accepted");
    expect(installSmokeScript).toContain("record-delivery-pending");
    expect(installSmokeScript).toContain('["session", "fail-delivery", "--help"]');
    expect(installSmokeScript).toContain("CODEX_THREAD_ID: \"install-smoke-task\"");
  });

  it("bounds Windows integration concurrency to a stable level", () => {
    const config = fs.readFileSync(path.join(process.cwd(), "vitest.config.ts"), "utf8");
    const match = config.match(/maxWorkers:\s*(\d+)/u);

    expect(match).not.toBeNull();
    expect(Number(match?.[1])).toBeLessThanOrEqual(2);
  });
});
