import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { probeManagedRuntime } from "../src/tunnel/runtime-config.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const roots: string[] = [];
const windowsIt = process.platform === "win32" ? it : it.skip;

function temp(): string {
  const root = makeTmpDir("runtime-probe-windows");
  roots.push(root);
  return root;
}

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return systemRoot ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

function createDpapiFixture(root: string): { keyFile: string; tunnelIdFile: string } {
  fs.mkdirSync(root, { recursive: true });
  const keyFile = path.join(root, "tunnel-runtime-key.dpapi");
  const tunnelIdFile = path.join(root, "tunnel-runtime-id.dpapi");
  const result = spawnSync(powershellExecutable(), [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    [
      "Add-Type -AssemblyName System.Security",
      "$api = [Text.Encoding]::UTF8.GetBytes($env:C2C_TEST_DPAPI_API)",
      "$tunnelId = [Text.Encoding]::UTF8.GetBytes($env:C2C_TEST_DPAPI_TUNNEL_ID)",
      "$protectedApi = [System.Security.Cryptography.ProtectedData]::Protect($api, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "$protectedTunnelId = [System.Security.Cryptography.ProtectedData]::Protect($tunnelId, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)",
      "[IO.File]::WriteAllBytes($env:C2C_TEST_DPAPI_KEY_FILE, $protectedApi)",
      "[IO.File]::WriteAllBytes($env:C2C_TEST_DPAPI_TUNNEL_ID_FILE, $protectedTunnelId)",
    ].join("; "),
  ], {
    encoding: "utf8",
    windowsHide: true,
    env: {
      ...process.env,
      C2C_TEST_DPAPI_API: "fixture-api-key",
      C2C_TEST_DPAPI_TUNNEL_ID: "fixture-tunnel-id",
      C2C_TEST_DPAPI_KEY_FILE: keyFile,
      C2C_TEST_DPAPI_TUNNEL_ID_FILE: tunnelIdFile,
    },
  });
  if (result.status !== 0 || result.error || !fs.existsSync(keyFile) || !fs.existsSync(tunnelIdFile)) {
    throw new Error("could not create isolated DPAPI fixture");
  }
  return { keyFile, tunnelIdFile };
}

function createTunnelClientFixture(root: string, body: string): string {
  const bin = path.join(root, "bin");
  fs.mkdirSync(bin, { recursive: true });
  const marker = path.join(root, "tunnel-client-marker.txt");
  fs.writeFileSync(
    path.join(bin, "tunnel-client.cmd"),
    `@echo off\r\necho before-%ERRORLEVEL% > "${marker}"\r\n${body}\r\necho after-%ERRORLEVEL% >> "${marker}"\r\n`,
    "utf8",
  );
  return bin;
}

function runIsolatedProbe(options: {
  root: string;
  tunnelClientBody: string;
  controlPlaneScript?: string;
  runtimeAlias?: string;
}): ReturnType<typeof probeManagedRuntime> {
  const fixture = createDpapiFixture(options.root);
  const tunnelClientBin = createTunnelClientFixture(options.root, options.tunnelClientBody);
  const inherited = { ...process.env };
  delete inherited.PATH;
  inherited.Path = `${tunnelClientBin}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
  const result = probeManagedRuntime({
    platform: "win32",
    inherited,
    keyFile: fixture.keyFile,
    tunnelIdFile: fixture.tunnelIdFile,
    runtimeAlias: options.runtimeAlias ?? "c2c-isolated",
    run: (command, args, spawnOptions) => {
      const encodedFlag = args.indexOf("-EncodedCommand");
      expect(command).toMatch(/powershell\.exe$/iu);
      expect(encodedFlag).toBeGreaterThanOrEqual(0);
      const encoded = args[encodedFlag + 1];
      expect(encoded).toBeTruthy();
      const probeScript = Buffer.from(encoded!, "base64").toString("utf16le");
      const controlPlaneScript = options.controlPlaneScript ?? `
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Method, [string]$Uri, [hashtable]$Headers, [int]$TimeoutSec)
  [pscustomobject]@{ StatusCode = 200 }
}
`;
      return spawnSync(command, [
        ...args.slice(0, encodedFlag),
        "-Command",
        `${controlPlaneScript}\n${probeScript}`,
      ], {
        encoding: "utf8",
        windowsHide: true,
        env: spawnOptions.env,
      });
    },
  });
  // Keep the external command real while proving PATH resolved to this fixture.
  expect(fs.existsSync(path.join(options.root, "tunnel-client-marker.txt"))).toBe(true);
  return result;
}

afterEach(() => {
  for (const root of roots.splice(0)) cleanup(root);
});

describe("managed runtime probe Windows stage boundaries", () => {
  windowsIt("keeps credentials verified when an unknown alias exits nonzero with native stderr", () => {
    const root = temp();
    const result = runIsolatedProbe({
      root,
      runtimeAlias: "c2c-2317f4a0bdd9",
      tunnelClientBody: [
        "echo runtime alias was not found 1>&2",
        "exit /b 1",
      ].join("\r\n"),
    });
    expect(result).toMatchObject({
      available: false,
      credentialSource: "managed_dpapi",
      credentialState: "verified",
      processRunning: false,
      stale: true,
      errorClass: "runtime_status_command_failed",
    });
    expect(result.errorClass).not.toBe("managed_credential_unreadable");
  });

  windowsIt("keeps credentials verified and reports invalid runtime JSON", () => {
    const root = temp();
    const result = runIsolatedProbe({
      root,
      tunnelClientBody: [
        "echo {\"process_running\":true,\"healthy\":true",
        "exit /b 0",
      ].join("\r\n"),
    });
    expect(result).toMatchObject({
      available: false,
      credentialSource: "managed_dpapi",
      credentialState: "verified",
      stale: true,
      errorClass: "runtime_status_invalid_json",
    });
  });

  windowsIt("accepts valid runtime JSON even when tunnel-client writes stderr", () => {
    const root = temp();
    const result = runIsolatedProbe({
      root,
      tunnelClientBody: [
        "echo {\"process_running\":true,\"healthy\":true,\"ready\":true,\"stale\":false}",
        "echo runtime status warning 1>&2",
        "exit /b 0",
      ].join("\r\n"),
    });
    expect(result).toMatchObject({
      available: true,
      credentialSource: "managed_dpapi",
      credentialState: "verified",
      processRunning: true,
      healthy: true,
      ready: true,
      stale: false,
    });
    expect(result.errorClass).toBeUndefined();
  });

  windowsIt("keeps credentials verified and reports a nonzero runtime command with valid JSON", () => {
    const root = temp();
    const result = runIsolatedProbe({
      root,
      tunnelClientBody: [
        "echo {\"process_running\":true,\"healthy\":true,\"ready\":true,\"stale\":false}",
        "exit /b 7",
      ].join("\r\n"),
    });

    expect(result).toMatchObject({
      available: false,
      credentialSource: "managed_dpapi",
      credentialState: "verified",
      processRunning: false,
      healthy: false,
      ready: false,
      stale: true,
      errorClass: "runtime_status_command_failed",
    });
  });

  windowsIt("distinguishes missing files, DPAPI failure, and control-plane 401", () => {
    const root = temp();
    const missing = probeManagedRuntime({
      platform: "win32",
      inherited: process.env,
      keyFile: path.join(root, "missing-key.dpapi"),
      tunnelIdFile: path.join(root, "missing-id.dpapi"),
      runtimeAlias: "c2c-isolated",
    });
    expect(missing).toMatchObject({
      credentialState: "missing",
      errorClass: "managed_credential_file_missing",
    });

    const dpapiKey = path.join(root, "bad-key.dpapi");
    const dpapiTunnelId = path.join(root, "bad-id.dpapi");
    fs.writeFileSync(dpapiKey, "not-a-dpapi-blob", "utf8");
    fs.writeFileSync(dpapiTunnelId, "also-not-a-dpapi-blob", "utf8");
    const dpapiResult = probeManagedRuntime({
      platform: "win32",
      inherited: process.env,
      keyFile: dpapiKey,
      tunnelIdFile: dpapiTunnelId,
      runtimeAlias: "c2c-isolated",
      run: (command, args, spawnOptions) => {
        const encodedFlag = args.indexOf("-EncodedCommand");
        const probeScript = Buffer.from(args[encodedFlag + 1]!, "base64").toString("utf16le");
        return spawnSync(command, [
          ...args.slice(0, encodedFlag),
          "-Command",
          `function Invoke-WebRequest { param([switch]$UseBasicParsing, [string]$Method, [string]$Uri, [hashtable]$Headers, [int]$TimeoutSec); [pscustomobject]@{ StatusCode = 200 } }\n${probeScript}`,
        ], { encoding: "utf8", windowsHide: true, env: spawnOptions.env });
      },
    });
    expect(dpapiResult).toMatchObject({
      credentialState: "missing",
      errorClass: "managed_credential_dpapi_unreadable",
    });

    const fixture = createDpapiFixture(path.join(root, "unauthorized"));
    const unauthorized = probeManagedRuntime({
      platform: "win32",
      inherited: process.env,
      keyFile: fixture.keyFile,
      tunnelIdFile: fixture.tunnelIdFile,
      runtimeAlias: "c2c-isolated",
      run: (command, args, spawnOptions) => {
        const encodedFlag = args.indexOf("-EncodedCommand");
        const probeScript = Buffer.from(args[encodedFlag + 1]!, "base64").toString("utf16le");
        const mock = `
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Method, [string]$Uri, [hashtable]$Headers, [int]$TimeoutSec)
  [pscustomobject]@{ StatusCode = 401 }
}
`;
        return spawnSync(command, [
          ...args.slice(0, encodedFlag),
          "-Command",
          `${mock}\n${probeScript}`,
        ], { encoding: "utf8", windowsHide: true, env: spawnOptions.env });
      },
    });
    expect(unauthorized).toMatchObject({
      credentialState: "invalid",
      remoteLookup: { status: 401, code: "invalid_api_key" },
    });
  });
});
