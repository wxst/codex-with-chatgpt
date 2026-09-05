import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createWorkspaceRouter, revokeWorkspaceRoutes, routerStateFile } from "../src/router/state.js";
import { startWorkspaceRouter, type WorkspaceRouterBridge } from "../src/router/server.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, isolateStateDir, makeTmpDir, write } from "./helpers.js";

const run = promisify(execFile);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots: string[] = [];
let stateDir: string;
let anchor: Workspace;
let consumer: Workspace;
let prelude: string;
let bridge: WorkspaceRouterBridge | undefined;
let managedProbe: unknown;

function temp(name: string): string {
  const root = makeTmpDir(name);
  roots.push(root);
  return root;
}

function snapshot(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  const visit = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(file);
      else files[path.relative(root, file)] = fs.readFileSync(file).toString("base64");
    }
  };
  visit(root);
  return files;
}

beforeEach(() => {
  stateDir = isolateStateDir();
  roots.push(stateDir);
  anchor = new Workspace(temp("diagnostic-anchor"));
  consumer = new Workspace(temp("diagnostic-consumer"));
  managedProbe = { credentialState: "verified", runtime: {
    process_running: true, healthy: true, ready: true, stale: false,
  } };
  // Only the managed probe subprocess is replaced. No live credential or
  // control plane is accessed; CLI routing and Bridge checks remain real.
  prelude = pathToFileURL(write(temp("diagnostic-prelude"), "probe.mjs", `
import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const original = cp.spawnSync;
cp.spawnSync = function(command, args, options) {
  if (options?.env?.C2C_MANAGED_RUNTIME_ALIAS) {
    return { status: 0, stdout: process.env.C2C_TEST_MANAGED_PROBE, stderr: '' };
  }
  return original.apply(this, arguments);
};
syncBuiltinESMExports();
`)).href;
});

afterEach(async () => {
  await bridge?.close();
  bridge = undefined;
  for (const root of roots.splice(0).reverse()) cleanup(root);
  delete process.env.C2C_STATE_DIR;
});

async function cli(...args: string[]) {
  const result = await run(process.execPath,
    ["--import", prelude, "--import", "tsx", "src/cli/index.ts", ...args, "-w", consumer.root, "--json"],
    { cwd: projectRoot, env: { ...process.env, C2C_STATE_DIR: stateDir, NODE_ENV: "test", VITEST: "true",
      C2C_TEST_MANAGED_PROBE: JSON.stringify(managedProbe) }, windowsHide: true });
  return JSON.parse(result.stdout);
}

describe("Router diagnostic context", () => {
  it("reports unregistered workspace separately from the healthy anchor Bridge", async () => {
    await createWorkspaceRouter(anchor.root);
    bridge = await startWorkspaceRouter({ anchorRoot: anchor.root, port: 0 });
    const before = snapshot(stateDir);
    const result = await cli("status");
    expect(result).toMatchObject({
      ok: false, running: true, router: true,
      workspaceId: consumer.id, anchorWorkspaceId: anchor.id,
      workspaceRoot: consumer.root, anchorWorkspaceRoot: anchor.root,
      workspaceRegistration: "unregistered", errorClass: "workspace_not_registered",
    });
    expect(snapshot(stateDir)).toEqual(before);
  });

  it.each(["unregistered", "registered", "revoked"] as const)(
    "uses the global alias for a %s workspace without changing registration", async state => {
      const router = await createWorkspaceRouter(anchor.root);
      if (state !== "unregistered") await router.register(consumer.root);
      if (state === "revoked") await revokeWorkspaceRoutes(consumer.id);
      const before = snapshot(stateDir);
      const result = await cli("runtime", "diagnose");
      expect(result).toMatchObject({
        ok: state === "registered" && process.platform === "win32", router: true, workspaceId: consumer.id,
        anchorWorkspaceId: anchor.id, runtimeAlias: `c2c-${anchor.id}`,
        runtimeAliasSource: "router_anchor", workspaceRegistration: state,
      });
      expect(result.errorClass).toBe(state === "registered" ? undefined
        : state === "revoked" ? "workspace_revoked" : "workspace_not_registered");
      if (process.platform === "win32") {
        expect(result.runtime).toMatchObject({ credentialState: "verified", healthy: true, ready: true });
      }
      expect(snapshot(stateDir)).toEqual(before);
    });

  it("honors an explicit diagnostic alias without claiming that it is the anchor alias", async () => {
    await createWorkspaceRouter(anchor.root);
    const result = await cli("runtime", "diagnose", "--runtime-alias", "custom-runtime");
    expect(result).toMatchObject({
      runtimeAlias: "custom-runtime", runtimeAliasSource: "explicit",
      workspaceRegistration: "unregistered", anchorWorkspaceId: anchor.id,
      errorClass: "workspace_not_registered",
    });
  });

  it("does not report overall success when a registered workspace has no healthy runtime", async () => {
    const router = await createWorkspaceRouter(anchor.root);
    await router.register(consumer.root);
    managedProbe = { credentialState: "verified", runtime: {
      process_running: true, healthy: false, ready: false, stale: false,
    } };
    const result = await cli("runtime", "diagnose");
    expect(result).toMatchObject({ ok: false, workspaceRegistration: "registered" });
    expect(result.runtime.healthy).toBe(false);
  });

  it("keeps legacy per-workspace diagnostics when there is no global Router", async () => {
    const before = snapshot(stateDir);
    const result = await cli("runtime", "diagnose");
    expect(result).toMatchObject({
      ok: process.platform === "win32", router: false, workspaceRegistration: "legacy",
      workspaceId: consumer.id, anchorWorkspaceId: consumer.id,
      runtimeAlias: `c2c-${consumer.id}`, runtimeAliasSource: "legacy_workspace",
    });
    const status = await cli("status");
    expect(status).toMatchObject({ running: false, router: false,
      workspaceRegistration: "legacy", anchorWorkspaceId: consumer.id });
    expect(snapshot(stateDir)).toEqual(before);
    expect(fs.existsSync(routerStateFile())).toBe(false);
  });

  it.each(["unregistered", "revoked"] as const)(
    "rejects both repair commands for a %s workspace before any write", async state => {
      const router = await createWorkspaceRouter(anchor.root);
      if (state === "revoked") {
        await router.register(consumer.root);
        await revokeWorkspaceRoutes(consumer.id);
      }
      const profile = write(temp("diagnostic-profile"), "profile.json", '{"headers":{"keep":"sentinel"}}');
      const before = snapshot(stateDir);
      const originalProfile = fs.readFileSync(profile, "utf8");
      for (const args of [
        ["runtime", "repair-profile", "--profile-file", profile, "--runtime-alias", "custom-runtime"],
        ["runtime", "repair-user-environment"],
      ]) {
        const result = await run(process.execPath,
          ["--import", prelude, "--import", "tsx", "src/cli/index.ts", ...args, "-w", consumer.root, "--json"],
          { cwd: projectRoot, env: { ...process.env, C2C_STATE_DIR: stateDir, NODE_ENV: "test", VITEST: "true" }, windowsHide: true }
        ).then(() => { throw new Error("repair unexpectedly succeeded"); }, error => error);
        expect(result.code).toBe(1);
        expect(JSON.parse(result.stdout)).toMatchObject({
          ok: false, errorClass: state === "revoked" ? "workspace_revoked" : "workspace_not_registered",
        });
      }
      expect(fs.readFileSync(profile, "utf8")).toBe(originalProfile);
      expect(snapshot(stateDir)).toEqual(before);
    });

  it.each(["malformed", "unreadable", "duplicate-active-first", "duplicate-revoked-first"])(
    "rejects %s Router state for diagnostics and repair without falling back to legacy", async kind => {
      const router = await createWorkspaceRouter(anchor.root);
      await router.register(consumer.root);
      if (kind === "malformed") fs.writeFileSync(routerStateFile(), "{");
      else if (kind === "unreadable") {
        fs.unlinkSync(routerStateFile());
        fs.mkdirSync(routerStateFile());
      }
      else {
        const state = await router.read();
        const registration = state.workspaces.find(entry => entry.workspaceId === consumer.id)!;
        const revoked = { ...registration, revokedAt: new Date().toISOString() };
        state.workspaces = [state.anchor, ...(kind === "duplicate-active-first"
          ? [registration, revoked] : [revoked, registration])];
        fs.writeFileSync(routerStateFile(), JSON.stringify(state));
      }
      const before = snapshot(stateDir);
      for (const args of [["status"], ["runtime", "diagnose"], ["runtime", "repair-profile"], ["runtime", "repair-user-environment"]]) {
        const result = await run(process.execPath,
          ["--import", prelude, "--import", "tsx", "src/cli/index.ts", ...args, "-w", consumer.root, "--json"],
          { cwd: projectRoot, env: { ...process.env, C2C_STATE_DIR: stateDir, NODE_ENV: "test", VITEST: "true" }, windowsHide: true }
        ).then(value => ({ ...value, code: 0 }), error => error);
        expect(result.code).toBe(1);
        const payload = JSON.parse(result.stdout);
        expect(payload).toMatchObject({ ok: false, errorClass: kind === "unreadable" ? "router_state_unavailable" : "router_state_invalid" });
        expect(payload.runtimeAlias).toBeUndefined();
      }
      expect(snapshot(stateDir)).toEqual(before);
    });
});
