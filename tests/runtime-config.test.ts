import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildManagedRuntimeEnvironment,
  diagnoseRuntimeHeader,
  diagnoseWindowsUserRuntimeHeader,
  probeManagedRuntime,
  summarizeManagedRuntimeProbe,
  repairRuntimeProfileHeader,
  repairWindowsUserRuntimeHeader,
  tunnelHeaderFileReference,
} from "../src/tunnel/runtime-config.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const roots: string[] = [];

function temp(): string {
  const root = makeTmpDir("runtime-config");
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe("OpenAI runtime token-file diagnostics", () => {
  it("uses the canonical DPAPI paths and removes inherited runtime credentials", () => {
    const root = temp();
    const environment = buildManagedRuntimeEnvironment({
      inherited: {
        CONTROL_PLANE_API_KEY: "stale-user-key",
        CONTROL_PLANE_TUNNEL_ID: "stale-tunnel-id",
        PATH: "test-path",
      },
      keyFile: path.join(root, "tunnel-runtime-key.dpapi"),
      tunnelIdFile: path.join(root, "tunnel-runtime-id.dpapi"),
      runtimeAlias: "c2c-test",
    });

    expect(environment).toMatchObject({
      PATH: "test-path",
      C2C_MANAGED_RUNTIME_KEY_FILE: path.join(root, "tunnel-runtime-key.dpapi"),
      C2C_MANAGED_RUNTIME_TUNNEL_ID_FILE: path.join(root, "tunnel-runtime-id.dpapi"),
      C2C_MANAGED_RUNTIME_ALIAS: "c2c-test",
    });
    expect(environment.CONTROL_PLANE_API_KEY).toBeUndefined();
    expect(environment.CONTROL_PLANE_TUNNEL_ID).toBeUndefined();
    expect(JSON.stringify(environment)).not.toContain("stale-user-key");
  });

  it("treats only the DPAPI probe result as the runtime credential state", () => {
    expect(summarizeManagedRuntimeProbe({
      credentialState: "verified",
      runtime: { process_running: true, healthy: true, ready: true, stale: false },
    })).toMatchObject({
      credentialSource: "managed_dpapi",
      credentialState: "verified",
      processRunning: true,
      healthy: true,
      ready: true,
      stale: false,
    });

    expect(summarizeManagedRuntimeProbe({
      credentialState: "invalid",
      remoteLookup: { status: 401, code: "invalid_api_key" },
      runtime: { process_running: false, healthy: false, ready: false, stale: true },
    })).toMatchObject({
      credentialSource: "managed_dpapi",
      credentialState: "invalid",
      remoteLookup: { status: 401, code: "invalid_api_key" },
    });

    expect(summarizeManagedRuntimeProbe({ credentialState: "missing" })).toMatchObject({
      credentialSource: "managed_dpapi",
      credentialState: "missing",
      processRunning: false,
      healthy: false,
      ready: false,
      stale: true,
    });
  });

  it("runs the managed probe with DPAPI file references instead of an inherited Key", () => {
    const root = temp();
    const keyFile = path.join(root, "tunnel-runtime-key.dpapi");
    const tunnelIdFile = path.join(root, "tunnel-runtime-id.dpapi");
    const result = probeManagedRuntime({
      platform: "win32",
      inherited: { CONTROL_PLANE_API_KEY: "stale-user-key", PATH: "test-path" },
      keyFile,
      tunnelIdFile,
      runtimeAlias: "c2c-test",
      run: (command, args, options) => {
        expect(command).toMatch(/powershell\.exe$/iu);
        expect(args).toContain("-EncodedCommand");
        expect(options.env).toMatchObject({
          C2C_MANAGED_RUNTIME_KEY_FILE: keyFile,
          C2C_MANAGED_RUNTIME_TUNNEL_ID_FILE: tunnelIdFile,
          C2C_MANAGED_RUNTIME_ALIAS: "c2c-test",
        });
        expect(options.env.CONTROL_PLANE_API_KEY).toBeUndefined();
        expect(JSON.stringify(options.env)).not.toContain("stale-user-key");
        return {
          status: 0,
          stdout: JSON.stringify({
            credentialState: "verified",
            runtime: { process_running: true, healthy: true, ready: true, stale: false },
          }),
          stderr: "tunnel-client emitted a non-JSON diagnostic on stderr",
        };
      },
    });

    expect(result).toMatchObject({
      credentialSource: "managed_dpapi",
      credentialState: "verified",
      processRunning: true,
      ready: true,
    });
  });

  it("maps the managed DPAPI probe's 401 and missing outcomes without consulting a parent Key", () => {
    const root = temp();
    const shared = {
      platform: "win32" as const,
      inherited: { CONTROL_PLANE_API_KEY: "stale-user-key" },
      keyFile: path.join(root, "tunnel-runtime-key.dpapi"),
      tunnelIdFile: path.join(root, "tunnel-runtime-id.dpapi"),
      runtimeAlias: "c2c-test",
    };

    const invalid = probeManagedRuntime({
      ...shared,
      run: (_command, _args, options) => {
        expect(options.env.CONTROL_PLANE_API_KEY).toBeUndefined();
        return {
          status: 0,
          stdout: JSON.stringify({
            credentialState: "invalid",
            remoteLookup: { status: 401, code: "invalid_api_key" },
          }),
          stderr: "",
        };
      },
    });
    expect(invalid).toMatchObject({
      credentialSource: "managed_dpapi",
      credentialState: "invalid",
      remoteLookup: { status: 401, code: "invalid_api_key" },
    });

    const missing = probeManagedRuntime({
      ...shared,
      run: () => ({
        status: 0,
        stdout: JSON.stringify({ credentialState: "missing", errorClass: "managed_credential_file_missing" }),
        stderr: "",
      }),
    });
    expect(missing).toMatchObject({
      credentialSource: "managed_dpapi",
      credentialState: "missing",
      errorClass: "managed_credential_file_missing",
    });
    expect(JSON.stringify({ invalid, missing })).not.toContain("stale-user-key");
  });

  it("recognizes the effective environment reference and never exposes runtime API keys", () => {
    const root = temp();
    const canonical = path.join(root, "state", "transports", "workspace.token");
    const legacy = path.join(root, "AppData", "Local", "codex-with-chatgpt", "workspace.token");
    const diagnosis = diagnoseRuntimeHeader({
      canonicalTokenFile: canonical,
      profileFile: path.join(root, "runtime.yaml"),
      environmentHeaders: `X-C2C-Tunnel-Token: file:${legacy}`,
    });

    expect(diagnosis).toMatchObject({ configuredTokenFile: legacy, source: "environment", state: "legacy_path" });
    expect(JSON.stringify(diagnosis)).not.toContain("runtime-api-key-secret");
  });

  it("atomically repairs only an exact stale token path in a persisted profile", () => {
    const root = temp();
    const canonical = path.join(root, "state", "transports", "workspace.token");
    const legacy = path.join(root, "AppData", "Local", "codex-with-chatgpt", "workspace.token");
    const profile = path.join(root, "runtime.yaml");
    fs.writeFileSync(profile, `mcp:\n  extra-headers:\n    - X-C2C-Tunnel-Token: file:${legacy}\n`);

    const repaired = repairRuntimeProfileHeader({
      profileFile: profile,
      expectedTokenFile: legacy,
      canonicalTokenFile: canonical,
    });

    expect(repaired).toMatchObject({ configuredTokenFile: canonical, source: "profile", state: "matching" });
    expect(fs.readFileSync(profile, "utf8")).toContain(canonical);
    expect(fs.readFileSync(profile, "utf8")).not.toContain(legacy);
  });

  it("rejects absent or changed profile references instead of overwriting unrelated settings", () => {
    const root = temp();
    const profile = path.join(root, "runtime.yaml");
    fs.writeFileSync(profile, "mcp:\n  server_urls: []\n");
    expect(() => repairRuntimeProfileHeader({
      profileFile: profile,
      expectedTokenFile: path.join(root, "old.token"),
      canonicalTokenFile: path.join(root, "new.token"),
    })).toThrow(/no C2C tunnel token file reference/);
    expect(tunnelHeaderFileReference("X-C2C-Tunnel-Token: file:C:\\temp\\token"))
      .toBe(path.resolve("C:\\temp\\token"));
  });

  it("repairs only the stale Windows user-environment file reference for future runtime launches", () => {
    const root = temp();
    const canonical = path.join(root, "state", "transports", "workspace.token");
    const legacy = path.join(root, "AppData", "Local", "codex-with-chatgpt", "workspace.token");
    const calls: Array<{ command: string; args: string[] }> = [];
    const result = repairWindowsUserRuntimeHeader({
      canonicalTokenFile: canonical,
      platform: "win32",
      run: (command, args) => {
        calls.push({ command, args });
        if (args[0] === "query") {
          return { status: 0, stdout: `MCP_EXTRA_HEADERS    REG_SZ    X-C2C-Tunnel-Token: file:${legacy}\n`, stderr: "" };
        }
        return { status: 0, stdout: "The operation completed successfully.\n", stderr: "" };
      },
    });

    expect(result).toMatchObject({ previousTokenFile: legacy, canonicalTokenFile: canonical, changed: true });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ command: "reg.exe" });
    expect(calls[1]?.args).toContain(`X-C2C-Tunnel-Token: file:${canonical}`);
  });

  it("reports the post-repair future user environment separately from a stale current process", () => {
    const root = temp();
    const canonical = path.join(root, "state", "transports", "workspace.token");
    const result = diagnoseWindowsUserRuntimeHeader({
      canonicalTokenFile: canonical,
      platform: "win32",
      run: () => ({ status: 0, stdout: `MCP_EXTRA_HEADERS REG_SZ X-C2C-Tunnel-Token: file:${canonical}\n`, stderr: "" }),
    });
    expect(result).toEqual({ configuredTokenFile: canonical, state: "matching" });
  });
});
