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

type CommandRunner = (command: string, args: string[]) => Pick<SpawnSyncReturns<string>, "status" | "stdout" | "stderr" | "error">;

function normalizedPath(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function samePath(left: string, right: string): boolean {
  return normalizedPath(left) === normalizedPath(right);
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
