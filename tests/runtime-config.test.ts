import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  diagnoseRuntimeHeader,
  diagnoseWindowsUserRuntimeHeader,
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
