import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync, type SpawnSyncReturns } from "node:child_process";

export type RuntimeHeaderSource = "environment" | "profile" | null;
export type RuntimeHeaderState = "matching" | "legacy_path" | "missing";

export interface RuntimeHeaderDiagnosis {
  canonicalTokenFile: string;
  configuredTokenFile: string | null;
  source: RuntimeHeaderSource;
  state: RuntimeHeaderState;
  profileFile: string;
}

export interface DiagnoseRuntimeHeaderOptions {
  canonicalTokenFile: string;
  profileFile: string;
  environmentHeaders?: string;
}

export interface WindowsUserEnvironmentRepairResult {
  previousHeader: string;
  updatedHeader: string;
  previousTokenFile: string;
  canonicalTokenFile: string;
  changed: boolean;
}

export interface WindowsUserEnvironmentHeaderDiagnosis {
  configuredTokenFile: string | null;
  state: RuntimeHeaderState;
}

export type ManagedRuntimeCredentialState = "verified" | "invalid" | "missing";

export interface ManagedRuntimeCredentialFiles {
  keyFile: string;
  tunnelIdFile: string;
}

export interface ManagedRuntimeProbe {
  credentialState: ManagedRuntimeCredentialState;
  remoteLookup?: { status?: unknown; code?: unknown };
  runtime?: {
    process_running?: unknown;
    healthy?: unknown;
    ready?: unknown;
    stale?: unknown;
  };
  errorClass?: string;
}

export interface ManagedRuntimeSummary {
  available: boolean;
  credentialSource: "managed_dpapi";
  credentialState: ManagedRuntimeCredentialState;
  processRunning: boolean;
  healthy: boolean;
  ready: boolean;
  stale: boolean;
  remoteLookup: { status: unknown; code: unknown } | null;
  errorClass?: string;
}

type CommandRunner = (command: string, args: string[]) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;
type ManagedRuntimeProbeRunner = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv },
) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;

const MANAGED_RUNTIME_KEY_FILE_ENV = "C2C_MANAGED_RUNTIME_KEY_FILE";
const MANAGED_RUNTIME_TUNNEL_ID_FILE_ENV = "C2C_MANAGED_RUNTIME_TUNNEL_ID_FILE";
const MANAGED_RUNTIME_ALIAS_ENV = "C2C_MANAGED_RUNTIME_ALIAS";

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
}

/** The managed launcher and every C2C runtime probe share these DPAPI paths. */
export function defaultManagedRuntimeCredentialFiles(home = os.homedir()): ManagedRuntimeCredentialFiles {
  const root = path.join(home, ".config", "codex-with-chatgpt");
  return {
    keyFile: path.join(root, "tunnel-runtime-key.dpapi"),
    tunnelIdFile: path.join(root, "tunnel-runtime-id.dpapi"),
  };
}

/**
 * Child runtime tools receive only non-secret DPAPI file references. Any
 * inherited control-plane values are deliberately excluded before PowerShell
 * decrypts the managed secret in its own process.
 */
export function buildManagedRuntimeEnvironment(options: {
  inherited?: NodeJS.ProcessEnv;
  keyFile: string;
  tunnelIdFile: string;
  runtimeAlias: string;
}): NodeJS.ProcessEnv {
  const environment = { ...(options.inherited ?? process.env) };
  delete environment.CONTROL_PLANE_API_KEY;
  delete environment.CONTROL_PLANE_TUNNEL_ID;
  environment[MANAGED_RUNTIME_KEY_FILE_ENV] = path.resolve(options.keyFile);
  environment[MANAGED_RUNTIME_TUNNEL_ID_FILE_ENV] = path.resolve(options.tunnelIdFile);
  environment[MANAGED_RUNTIME_ALIAS_ENV] = options.runtimeAlias;
  return environment;
}

/** Convert the sanitized PowerShell probe record into the public CLI shape. */
export function summarizeManagedRuntimeProbe(probe: ManagedRuntimeProbe): ManagedRuntimeSummary {
  const runtime = probe.runtime;
  const remote = probe.remoteLookup;
  const available = probe.credentialState === "verified" && Boolean(runtime);
  return {
    available,
    credentialSource: "managed_dpapi",
    credentialState: probe.credentialState,
    processRunning: runtime?.process_running === true,
    healthy: runtime?.healthy === true,
    ready: runtime?.ready === true,
    stale: runtime?.stale === true || !runtime,
    remoteLookup: remote ? { status: remote.status ?? null, code: remote.code ?? null } : null,
    ...(probe.errorClass ? { errorClass: probe.errorClass } : {}),
  };
}

function managedRuntimeProbeScript(): string {
  return `
$ErrorActionPreference = "Stop"
$credentialState = "missing"
$apiBlob = $null
$tunnelIdBlob = $null
$apiBytes = $null
$tunnelIdBytes = $null
$apiKey = $null
$tunnelId = $null

function Emit-Probe([hashtable]$Value) {
  [Console]::Out.Write(($Value | ConvertTo-Json -Compress -Depth 12))
}

try {
  $keyFile = $env:C2C_MANAGED_RUNTIME_KEY_FILE
  $tunnelIdFile = $env:C2C_MANAGED_RUNTIME_TUNNEL_ID_FILE
  $alias = $env:C2C_MANAGED_RUNTIME_ALIAS
  if ([string]::IsNullOrWhiteSpace($keyFile) -or [string]::IsNullOrWhiteSpace($tunnelIdFile) -or
      [string]::IsNullOrWhiteSpace($alias)) {
    Emit-Probe @{ credentialState = "missing"; errorClass = "managed_credential_file_missing" }
    return
  }

  try {
    $keyExists = Test-Path -LiteralPath $keyFile -PathType Leaf
    $tunnelIdExists = Test-Path -LiteralPath $tunnelIdFile -PathType Leaf
  }
  catch {
    Emit-Probe @{ credentialState = "missing"; errorClass = "managed_credential_file_unreadable" }
    return
  }
  if (-not $keyExists -or -not $tunnelIdExists) {
    Emit-Probe @{ credentialState = "missing"; errorClass = "managed_credential_file_missing" }
    return
  }

  try {
    $apiBlob = [IO.File]::ReadAllBytes($keyFile)
    $tunnelIdBlob = [IO.File]::ReadAllBytes($tunnelIdFile)
  }
  catch {
    Emit-Probe @{ credentialState = "missing"; errorClass = "managed_credential_file_unreadable" }
    return
  }

  try {
    Add-Type -AssemblyName System.Security
    $apiBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $apiBlob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $tunnelIdBytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
      $tunnelIdBlob, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser
    )
    $apiKey = [Text.Encoding]::UTF8.GetString($apiBytes)
    $tunnelId = [Text.Encoding]::UTF8.GetString($tunnelIdBytes)
    # tunnel-client may need the same short-lived managed credential for its
    # status request. It is created only inside this child and cleared below.
    $env:CONTROL_PLANE_API_KEY = $apiKey
  }
  catch {
    Emit-Probe @{ credentialState = "missing"; errorClass = "managed_credential_dpapi_unreadable" }
    return
  }

  try {
    $response = Invoke-WebRequest -UseBasicParsing -Method Get -Uri ("https://api.openai.com/v1/tunnels/" + $tunnelId) -Headers @{ Authorization = ("Bearer " + $apiKey) } -TimeoutSec 20
    $status = [int]$response.StatusCode
    if ($status -eq 401) {
      Emit-Probe @{ credentialState = "invalid"; remoteLookup = @{ status = 401; code = "invalid_api_key" } }
      return
    }
    if ($status -lt 200 -or $status -ge 300) {
      Emit-Probe @{ credentialState = "missing"; errorClass = "managed_control_plane_probe_failed" }
      return
    }
  }
  catch {
    $status = $null
    try {
      if ($null -ne $_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    }
    catch {
      $status = $null
    }
    if ($status -eq 401) {
      Emit-Probe @{ credentialState = "invalid"; remoteLookup = @{ status = 401; code = "invalid_api_key" } }
      return
    }
    Emit-Probe @{ credentialState = "missing"; errorClass = "managed_control_plane_probe_failed" }
    return
  }

  # The control-plane lookup completed successfully. Runtime query failures
  # below describe the runtime only and must never downgrade this state.
  $credentialState = "verified"
  $runtimeStdout = ""
  $runtimeStderr = ""
  $runtimeExitCode = 0
  $runtimeCommandFailed = $false
  $stdoutFile = $null
  $stderrFile = $null
  try {
    $stdoutFile = [IO.Path]::GetTempFileName()
    $stderrFile = [IO.Path]::GetTempFileName()
    $nativeErrorActionPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    try {
      $LASTEXITCODE = 0
      & tunnel-client runtimes status $alias --json 1> $stdoutFile 2> $stderrFile
      if ($null -ne $LASTEXITCODE) { $runtimeExitCode = [int]$LASTEXITCODE }
    }
    catch {
      $runtimeCommandFailed = $true
      $runtimeExitCode = -1
    }
    finally {
      $ErrorActionPreference = $nativeErrorActionPreference
    }

    try {
      if ($null -ne $stdoutFile) { $runtimeStdout = [IO.File]::ReadAllText($stdoutFile) }
      if ($null -ne $stderrFile) { $runtimeStderr = [IO.File]::ReadAllText($stderrFile) }
    }
    catch {
      Emit-Probe @{ credentialState = "verified"; errorClass = "runtime_status_output_unreadable" }
      return
    }
  }
  finally {
    if ($null -ne $stdoutFile) { Remove-Item -LiteralPath $stdoutFile -Force -ErrorAction SilentlyContinue }
    if ($null -ne $stderrFile) { Remove-Item -LiteralPath $stderrFile -Force -ErrorAction SilentlyContinue }
  }

  $start = $runtimeStdout.IndexOf("{")
  if ($start -lt 0) {
    if ($runtimeCommandFailed -or $runtimeExitCode -ne 0) {
      Emit-Probe @{ credentialState = "verified"; errorClass = "runtime_status_command_failed" }
    }
    elseif (-not [string]::IsNullOrWhiteSpace($runtimeStderr)) {
      Emit-Probe @{ credentialState = "verified"; errorClass = "runtime_status_stderr" }
    }
    else {
      Emit-Probe @{ credentialState = "verified"; errorClass = "runtime_status_unparseable" }
    }
    return
  }

  try {
    $runtime = $runtimeStdout.Substring($start) | ConvertFrom-Json
  }
  catch {
    Emit-Probe @{ credentialState = "verified"; errorClass = "runtime_status_invalid_json" }
    return
  }

  if ($runtimeCommandFailed -or $runtimeExitCode -ne 0) {
    Emit-Probe @{ credentialState = "verified"; errorClass = "runtime_status_command_failed" }
    return
  }
  Emit-Probe @{ credentialState = "verified"; runtime = $runtime }
}
catch {
  if ($credentialState -eq "verified") {
    Emit-Probe @{ credentialState = "verified"; errorClass = "runtime_status_probe_failed" }
  }
  else {
    Emit-Probe @{ credentialState = "missing"; errorClass = "managed_credential_unreadable" }
  }
}
finally {
  Remove-Item Env:CONTROL_PLANE_API_KEY, Env:CONTROL_PLANE_TUNNEL_ID -ErrorAction SilentlyContinue
  $apiKey = $null
  $tunnelId = $null
  if ($null -ne $apiBlob) { [Array]::Clear($apiBlob, 0, $apiBlob.Length) }
  if ($null -ne $tunnelIdBlob) { [Array]::Clear($tunnelIdBlob, 0, $tunnelIdBlob.Length) }
  if ($null -ne $apiBytes) { [Array]::Clear($apiBytes, 0, $apiBytes.Length) }
  if ($null -ne $tunnelIdBytes) { [Array]::Clear($tunnelIdBytes, 0, $tunnelIdBytes.Length) }
}
`;
}

function powershellExecutable(): string {
  const systemRoot = process.env.SystemRoot ?? process.env.WINDIR;
  return systemRoot ? path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") : "powershell.exe";
}

function parseManagedRuntimeProbe(raw: string): ManagedRuntimeProbe | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  try {
    const value = JSON.parse(raw.slice(start)) as Partial<ManagedRuntimeProbe>;
    if (value.credentialState !== "verified" && value.credentialState !== "invalid" && value.credentialState !== "missing") {
      return null;
    }
    return value as ManagedRuntimeProbe;
  } catch {
    return null;
  }
}

/**
 * Run the read-only runtime check under the single managed DPAPI credential.
 * The parent process Key is removed before PowerShell starts and is never read.
 */
export function probeManagedRuntime(options: {
  runtimeAlias: string;
  keyFile?: string;
  tunnelIdFile?: string;
  inherited?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  run?: ManagedRuntimeProbeRunner;
}): ManagedRuntimeSummary {
  if ((options.platform ?? process.platform) !== "win32") {
    return summarizeManagedRuntimeProbe({ credentialState: "missing", errorClass: "managed_dpapi_windows_only" });
  }
  const defaults = defaultManagedRuntimeCredentialFiles();
  const environment = buildManagedRuntimeEnvironment({
    inherited: options.inherited,
    keyFile: options.keyFile ?? defaults.keyFile,
    tunnelIdFile: options.tunnelIdFile ?? defaults.tunnelIdFile,
    runtimeAlias: options.runtimeAlias,
  });
  const encoded = Buffer.from(managedRuntimeProbeScript(), "utf16le").toString("base64");
  const result = (options.run ?? ((command, args, runtimeOptions) => spawnSync(command, args, {
    encoding: "utf8",
    windowsHide: true,
    env: runtimeOptions.env,
  })))
    (powershellExecutable(), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], { env: environment });
  // The helper writes its sole JSON record to stdout. tunnel-client may write
  // diagnostics to stderr after that record, so combining the streams would
  // turn a valid result into malformed JSON.
  const probe = parseManagedRuntimeProbe(result.stdout ?? "");
  return summarizeManagedRuntimeProbe(probe ?? {
    credentialState: "missing",
    errorClass: result.error ? "managed_runtime_probe_unavailable" : "managed_runtime_probe_unparseable",
  });
}

/** Extract only the local tunnel-token file reference, never its contents. */
export function tunnelHeaderFileReference(headers: string | undefined): string | null {
  if (!headers) return null;
  const match = /(?:^|[\r\n,;])\s*(?:-\s*)?x-c2c-tunnel-token\s*:\s*file:([^\r\n,;]+)/iu.exec(headers);
  if (!match?.[1]) return null;
  const value = match[1].trim().replace(/^["']|["']$/gu, "");
  return value ? path.resolve(value) : null;
}

function profileHeaderFileReference(profileFile: string): string | null {
  try {
    return tunnelHeaderFileReference(fs.readFileSync(profileFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function defaultRuntimeProfileFile(runtimeAlias: string): string {
  const roaming = process.env.APPDATA
    ?? (process.platform === "win32"
      ? path.join(os.homedir(), "AppData", "Roaming")
      : path.join(os.homedir(), ".config"));
  return path.join(roaming, "tunnel-client", `${runtimeAlias}.yaml`);
}

/**
 * Runtime launch environment takes precedence over the profile. This makes a
 * stale interactive Codex environment visible without mistaking it for a
 * persisted profile mutation.
 */
export function diagnoseRuntimeHeader(options: DiagnoseRuntimeHeaderOptions): RuntimeHeaderDiagnosis {
  const canonicalTokenFile = path.resolve(options.canonicalTokenFile);
  const environmentFile = tunnelHeaderFileReference(options.environmentHeaders);
  const profileFile = path.resolve(options.profileFile);
  const configuredTokenFile = environmentFile ?? profileHeaderFileReference(profileFile);
  const source: RuntimeHeaderSource = environmentFile ? "environment" : configuredTokenFile ? "profile" : null;
  return {
    canonicalTokenFile,
    configuredTokenFile,
    source,
    state: !configuredTokenFile ? "missing" : samePath(configuredTokenFile, canonicalTokenFile) ? "matching" : "legacy_path",
    profileFile,
  };
}

/**
 * Atomically replace only the exact stale file reference in a persisted
 * tunnel-client profile. Environment-only references are intentionally left to
 * their runtime launcher, because a child CLI cannot rewrite its parent app.
 */
export function repairRuntimeProfileHeader(options: {
  profileFile: string;
  expectedTokenFile: string;
  canonicalTokenFile: string;
}): RuntimeHeaderDiagnosis {
  const profileFile = path.resolve(options.profileFile);
  const expectedTokenFile = path.resolve(options.expectedTokenFile);
  const canonicalTokenFile = path.resolve(options.canonicalTokenFile);
  const content = fs.readFileSync(profileFile, "utf8");
  const found = tunnelHeaderFileReference(content);
  if (!found) throw new Error("runtime profile has no C2C tunnel token file reference");
  if (!samePath(found, expectedTokenFile)) {
    throw new Error("runtime profile token file reference changed; inspect again before repair");
  }

  const updated = content.replaceAll(found, canonicalTokenFile);
  if (updated === content) throw new Error("runtime profile token file reference could not be replaced");
  const temporary = `${profileFile}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, updated, { encoding: "utf8", mode: fs.statSync(profileFile).mode });
    fs.renameSync(temporary, profileFile);
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  return diagnoseRuntimeHeader({ canonicalTokenFile, profileFile });
}

function runRegistry(command: string, args: string[]): Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error"> {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true });
}

function userEnvironmentHeaderFromRegistry(run: CommandRunner): string {
  const result = run("reg.exe", ["query", "HKCU\\Environment", "/v", "MCP_EXTRA_HEADERS"]);
  if (result.error || result.status !== 0) throw new Error("MCP_EXTRA_HEADERS is not set in the current user environment");
  const line = `${result.stdout ?? ""}`.split(/\r?\n/u)
    .find((entry) => /^\s*MCP_EXTRA_HEADERS\s+REG_\w+\s+/iu.test(entry));
  if (!line) throw new Error("MCP_EXTRA_HEADERS could not be read from the current user environment");
  const value = line.replace(/^\s*MCP_EXTRA_HEADERS\s+REG_\w+\s+/iu, "").trim();
  if (!value) throw new Error("MCP_EXTRA_HEADERS is empty in the current user environment");
  return value;
}

export function diagnoseWindowsUserRuntimeHeader(options: {
  canonicalTokenFile: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}): WindowsUserEnvironmentHeaderDiagnosis | null {
  if ((options.platform ?? process.platform) !== "win32") return null;
  const configuredTokenFile = tunnelHeaderFileReference(userEnvironmentHeaderFromRegistry(options.run ?? runRegistry));
  return {
    configuredTokenFile,
    state: !configuredTokenFile
      ? "missing"
      : samePath(configuredTokenFile, options.canonicalTokenFile) ? "matching" : "legacy_path",
  };
}

/**
 * Windows stores per-user environment values as individual registry values;
 * reg.exe ADD replaces one value atomically. This changes future process
 * launches only and never writes a token value, merely a file reference.
 */
export function repairWindowsUserRuntimeHeader(options: {
  canonicalTokenFile: string;
  platform?: NodeJS.Platform;
  run?: CommandRunner;
}): WindowsUserEnvironmentRepairResult {
  if ((options.platform ?? process.platform) !== "win32") {
    throw new Error("user-environment runtime header repair is available only on Windows");
  }
  const run = options.run ?? runRegistry;
  const previousHeader = userEnvironmentHeaderFromRegistry(run);
  const previousTokenFile = tunnelHeaderFileReference(previousHeader);
  if (!previousTokenFile) throw new Error("MCP_EXTRA_HEADERS has no C2C tunnel token file reference");
  const canonicalTokenFile = path.resolve(options.canonicalTokenFile);
  const updatedHeader = samePath(previousTokenFile, canonicalTokenFile)
    ? previousHeader
    : previousHeader.replaceAll(previousTokenFile, canonicalTokenFile);
  if (updatedHeader !== previousHeader) {
    const result = run("reg.exe", [
      "add", "HKCU\\Environment", "/v", "MCP_EXTRA_HEADERS", "/t", "REG_SZ", "/d", updatedHeader, "/f",
    ]);
    if (result.error || result.status !== 0) throw new Error("MCP_EXTRA_HEADERS could not be updated in the current user environment");
  }
  return {
    previousHeader,
    updatedHeader,
    previousTokenFile,
    canonicalTokenFile,
    changed: updatedHeader !== previousHeader,
  };
}
