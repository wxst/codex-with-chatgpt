import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { processGenerationStatus } from "../process/process-identity.js";
import {
  DEFAULT_LIFECYCLE_ORPHAN_GRACE_MS,
  isWorkspaceLifecycleLockHeldByInStateRoot,
  parseWorkspaceLifecycleTicket,
} from "../process/workspace-lock.js";

export interface LegacyWindowsStateProbeOptions {
  platform?: NodeJS.Platform;
  localAppData?: string;
  home?: string;
}

export interface LegacyWindowsCleanupOptions extends LegacyWindowsStateProbeOptions {
  /** Nonce of the lifecycle lock held in the selected legacy state root. */
  activeLifecycleNonce?: string;
}

/**
 * Raised before the new Windows state directory is touched when the previous
 * LocalAppData location can still own credentials or lifecycle state.
 */
export class LegacyWindowsStateError extends Error {
  constructor(
    readonly legacyRoot: string,
    readonly artifacts: string[],
    readonly inspectionFailures: string[] = [],
    readonly manualInspectionFailures: string[] = []
  ) {
    const messages: string[] = [];
    const manual = new Set(manualInspectionFailures);
    const retryableArtifacts = artifacts.filter((artifact) => !manual.has(artifact));
    if (retryableArtifacts.length > 0) {
      const shown = retryableArtifacts.slice(0, 3).join(", ");
      const remainder = retryableArtifacts.length > 3 ? ` (+${retryableArtifacts.length - 3} more)` : "";
      messages.push(
        `Legacy Windows state detected for this workspace: ${shown}${remainder}. ` +
          "Run c2c legacy-cleanup -w <workspace> from a regular Windows Terminal first to stop the old Bridge and " +
          "clean the host view. Then run the same command once inside packaged Codex or ChatGPT to clean its private " +
          "view. Retry with the new default directory only after both runs pass."
      );
    }
    if (manualInspectionFailures.length > 0) {
      messages.push(
        `Legacy lifecycle ticket requires manual inspection because its owner may still be active: ` +
          `${manualInspectionFailures.join(", ")}. From a regular Windows Terminal, stop the old c2c process for ` +
          "this workspace and verify its recorded PID has exited. Then rerun legacy-cleanup. If a malformed ticket " +
          "remains after every old c2c process has exited, remove only the exact listed ticket file and keep the " +
          "shared locks directory."
      );
    }
    if (inspectionFailures.length > 0) {
      messages.push(
        `Legacy Windows state inspection failed for shared path(s): ${inspectionFailures.join(", ")}. ` +
          "Repair access or restore the expected directory structure and retry; do not delete shared directories, " +
          "because they may contain lifecycle state for other workspaces."
      );
    }
    super(messages.join(" "));
    this.name = "LegacyWindowsStateError";
  }
}

interface EntryScan {
  matches: string[];
  inspectionFailures: string[];
}

function matchingEntriesInValidatedDirectory(
  dir: string,
  predicate: (name: string) => boolean
): EntryScan {
  try {
    return {
      matches: fs.readdirSync(dir).filter(predicate).map((name) => path.join(dir, name)),
      inspectionFailures: [],
    };
  } catch (error) {
    return { matches: [], inspectionFailures: [dir] };
  }
}

export function getLegacyWindowsStateDir(options: Pick<LegacyWindowsStateProbeOptions, "localAppData" | "home"> = {}): string {
  const home = options.home ?? os.homedir();
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
  return path.resolve(localAppData, "codex-with-chatgpt");
}

function assertSafeLegacyWindowsBasePath(
  options: Pick<LegacyWindowsStateProbeOptions, "localAppData" | "home">,
  platform: NodeJS.Platform
): void {
  if (platform !== "win32") return;
  const home = options.home ?? os.homedir();
  const candidate = options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");

  // POSIX temp paths keep the Windows-state logic testable on non-Windows CI.
  if (process.platform !== "win32" && path.posix.isAbsolute(candidate) && !candidate.startsWith("//")) {
    return;
  }

  const windowsPath = candidate.replace(/\//gu, "\\");
  if (!/^[A-Za-z]:\\/u.test(windowsPath)) {
    throw new Error("Legacy Windows state root must use a local drive; UNC, device, and root-relative paths are unsafe");
  }
}

function normalizedPath(value: string, platform: NodeJS.Platform): string {
  const resolved = path.normalize(path.resolve(value));
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

const ALLOWED_OPENAI_WINDOWS_PACKAGE_FAMILIES = new Set([
  "openai.codex_2p2nqsd0c76g0",
  "openai.chatgpt-desktop_2p2nqsd0c76g0",
]);

/** Match only the exact LocalAppData package projection used by Codex/ChatGPT. */
export function isAllowedLegacyWindowsPackageProjection(
  requestedPath: string,
  realPath: string,
  legacyRoot: string
): boolean {
  const requested = path.win32.resolve(requestedPath);
  const resolvedRoot = path.win32.resolve(legacyRoot);
  if (path.win32.basename(resolvedRoot).toLowerCase() !== "codex-with-chatgpt") return false;
  const requestedRelative = path.win32.relative(resolvedRoot, requested);
  if (
    requestedRelative === ".." ||
    requestedRelative.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(requestedRelative)
  ) {
    return false;
  }

  const packagesRoot = path.win32.join(path.win32.dirname(resolvedRoot), "Packages");
  const real = path.win32.resolve(realPath);
  const realRelative = path.win32.relative(packagesRoot, real);
  if (
    realRelative === ".." ||
    realRelative.startsWith(`..${path.win32.sep}`) ||
    path.win32.isAbsolute(realRelative)
  ) {
    return false;
  }
  const parts = realRelative.split(path.win32.sep).filter(Boolean);
  const family = parts[0]?.toLowerCase();
  if (!family || !ALLOWED_OPENAI_WINDOWS_PACKAGE_FAMILIES.has(family)) return false;
  const expected = path.win32.join(
    packagesRoot,
    parts[0],
    "LocalCache",
    "Local",
    "codex-with-chatgpt",
    requestedRelative
  );
  return path.win32.normalize(real).toLowerCase() === path.win32.normalize(expected).toLowerCase();
}

function assertSafeLegacyDirectoryChain(
  legacyRoot: string,
  directory: string,
  platform: NodeJS.Platform
): void {
  const resolvedRoot = path.resolve(legacyRoot);
  const resolvedDirectory = path.resolve(directory);
  const relative = path.relative(resolvedRoot, resolvedDirectory);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Legacy workspace artifact escaped its state root: ${resolvedDirectory}`);
  }

  const segments = relative ? relative.split(path.sep).filter(Boolean) : [];
  let cursor = resolvedRoot;
  for (const segment of ["", ...segments]) {
    if (segment) cursor = path.join(cursor, segment);
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Legacy state directory is a symbolic link, reparse point, or non-directory: ${cursor}`);
    }
    const real = fs.realpathSync.native(cursor);
    if (
      normalizedPath(real, platform) !== normalizedPath(cursor, platform) &&
      !(
        platform === "win32" &&
        isAllowedLegacyWindowsPackageProjection(cursor, real, resolvedRoot)
      )
    ) {
      throw new Error(`Legacy state directory real path differs from its requested path: ${cursor}`);
    }
  }
}

interface LegacyWindowsDirectoryLayout {
  legacyRoot: string;
  existingDirectories: Set<string>;
  inspectionFailures: string[];
}

function inspectSafeLegacyDirectory(
  layout: LegacyWindowsDirectoryLayout,
  directory: string,
  platform: NodeJS.Platform
): boolean {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    layout.inspectionFailures.push(directory);
    return false;
  }
  if (stat.isSymbolicLink()) {
    throw new Error(`Legacy state directory is a symbolic link or reparse point: ${directory}`);
  }
  if (!stat.isDirectory()) {
    layout.inspectionFailures.push(directory);
    return false;
  }
  assertSafeLegacyDirectoryChain(layout.legacyRoot, directory, platform);
  layout.existingDirectories.add(directory);
  return true;
}

function inspectLegacyWindowsDirectoryLayout(
  workspaceId: string,
  options: LegacyWindowsStateProbeOptions,
  platform: NodeJS.Platform
): LegacyWindowsDirectoryLayout {
  assertSafeLegacyWindowsBasePath(options, platform);
  const legacyRoot = getLegacyWindowsStateDir(options);
  const layout: LegacyWindowsDirectoryLayout = {
    legacyRoot,
    existingDirectories: new Set<string>(),
    inspectionFailures: [],
  };
  if (!inspectSafeLegacyDirectory(layout, legacyRoot, platform)) return layout;

  const runtime = path.join(legacyRoot, "runtime");
  const runtimeGenerations = path.join(legacyRoot, "runtime-generations");
  inspectSafeLegacyDirectory(layout, runtime, platform);
  const hasRuntimeGenerations = inspectSafeLegacyDirectory(layout, runtimeGenerations, platform);
  if (hasRuntimeGenerations) {
    inspectSafeLegacyDirectory(
      layout,
      path.join(runtimeGenerations, workspaceId),
      platform
    );
  }
  for (const name of ["auth", "transports", "tunnels", "endpoints", "pending-starts", "locks"]) {
    inspectSafeLegacyDirectory(layout, path.join(legacyRoot, name), platform);
  }
  return layout;
}

function sameFileIdentity(left: fs.BigIntStats, right: fs.BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export const CODEX_WINDOWS_SANDBOX_CAPABILITY_SID =
  "S-1-15-3-2968813833-811790644-2202111208-3784096404-1081847329-2708967783-1438471679";
export const CHATGPT_WINDOWS_SANDBOX_CAPABILITY_SID =
  "S-1-15-3-2569235138-1347164924-3176874416-3980197141-1442029411-569003742-1232801007";

// Elevated Windows tokens commonly make BUILTIN\Administrators the owner of
// newly created objects. Owners can rewrite the DACL, so accept only the same
// principals that already form the host trust boundary; app capabilities stay
// writer-only and never qualify as owners.
export function isTrustedLegacyWindowsAclOwner(sid: string, currentSid: string): boolean {
  return sid === currentSid || sid === "S-1-5-18" || sid === "S-1-5-32-544";
}

export function isTrustedLegacyWindowsAclWriter(sid: string, currentSid: string): boolean {
  return (
    isTrustedLegacyWindowsAclOwner(sid, currentSid) ||
    sid === CODEX_WINDOWS_SANDBOX_CAPABILITY_SID ||
    sid === CHATGPT_WINDOWS_SANDBOX_CAPABILITY_SID
  );
}

const LEGACY_WINDOWS_ATOMIC_WRITE_MASK =
  2n | // WriteData / CreateFiles
  4n | // AppendData / CreateDirectories
  16n | // WriteExtendedAttributes
  64n | // DeleteSubdirectoriesAndFiles
  256n | // WriteAttributes
  65_536n | // Delete
  262_144n | // ChangePermissions
  524_288n | // TakeOwnership
  268_435_456n | // GenericAll
  1_073_741_824n; // GenericWrite

export function hasLegacyWindowsWriteRights(rights: bigint | number | string): boolean {
  let value: bigint;
  try {
    value = BigInt(rights);
  } catch {
    throw new Error("Legacy state directory ACL inspection returned invalid rights");
  }
  return (value & LEGACY_WINDOWS_ATOMIC_WRITE_MASK) !== 0n;
}

const WINDOWS_ACL_INSPECTION_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
$payload = [Console]::In.ReadToEnd()
$targets = ConvertFrom-Json -InputObject $payload
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
Write-Output ('CURRENT|' + $currentSid)
foreach ($target in $targets) {
  $sections = [System.Security.AccessControl.AccessControlSections]::Owner -bor
    [System.Security.AccessControl.AccessControlSections]::Access
  if ($target.kind -eq 'directory') {
    $acl = [System.IO.Directory]::GetAccessControl($target.path, $sections)
  } elseif ($target.kind -eq 'file') {
    $acl = [System.IO.File]::GetAccessControl($target.path, $sections)
  } else {
    throw 'Unknown ACL target kind'
  }
  $ownerSid = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  Write-Output ('OWNER|' + $ownerSid)
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
    Write-Output ('ALLOW|' + $rule.IdentityReference.Value + '|' + [Int64]$rule.FileSystemRights)
  }
  Write-Output 'END'
}
`;

interface LegacyWindowsAclTarget {
  path: string;
  kind: "directory" | "file";
}

const WINDOWS_ACL_TARGET_BATCH_SIZE = 64;
const WINDOWS_ACL_MAX_TARGETS = 4096;

function assertPrivateWindowsAcls(targets: LegacyWindowsAclTarget[], platform: NodeJS.Platform): void {
  if (platform !== "win32" || process.platform !== "win32" || targets.length === 0) return;
  if (targets.length > WINDOWS_ACL_MAX_TARGETS) {
    throw new Error(
      `Legacy state ACL target count exceeds the bounded inspection limit ` +
        `(${targets.length} > ${WINDOWS_ACL_MAX_TARGETS})`
    );
  }
  const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
  const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  let expectedCurrentSid: string | null = null;
  for (let offset = 0; offset < targets.length; offset += WINDOWS_ACL_TARGET_BATCH_SIZE) {
    const batch = targets.slice(offset, offset + WINDOWS_ACL_TARGET_BATCH_SIZE);
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_INSPECTION_SCRIPT],
      {
        encoding: "utf8",
        timeout: 15_000,
        maxBuffer: 1_048_576,
        windowsHide: true,
        input: JSON.stringify(batch),
      }
    );
    if (result.status !== 0) {
      const outcome = result.error
        ? result.error.message
        : result.signal
          ? `signal ${result.signal}`
          : `status ${String(result.status)}`;
      throw new Error(
        `Legacy state directory owner or ACL inspection failed in bounded batch ` +
          `${Math.floor(offset / WINDOWS_ACL_TARGET_BATCH_SIZE) + 1} (${outcome})`
      );
    }

    const lines = result.stdout.split(/\r?\n/gu).map((line) => line.trim()).filter(Boolean);
    const currentLine = lines.shift();
    if (!currentLine?.startsWith("CURRENT|")) {
      throw new Error("Legacy state directory ACL inspection returned malformed output");
    }
    const currentSid = currentLine.slice("CURRENT|".length);
    if (expectedCurrentSid !== null && currentSid !== expectedCurrentSid) {
      throw new Error("Legacy state directory ACL inspection principal changed between batches");
    }
    expectedCurrentSid = currentSid;
    let ownerCount = 0;
    let endCount = 0;
    for (const line of lines) {
      if (line.startsWith("OWNER|")) {
        ownerCount += 1;
        if (!isTrustedLegacyWindowsAclOwner(line.slice("OWNER|".length), currentSid)) {
          throw new Error("Legacy state directory owner is not a trusted Windows principal");
        }
      } else if (line.startsWith("ALLOW|")) {
        const fields = line.split("|");
        if (fields.length !== 3) {
          throw new Error("Legacy state directory ACL inspection returned malformed output");
        }
        const [, writer, rights] = fields;
        if (hasLegacyWindowsWriteRights(rights) && !isTrustedLegacyWindowsAclWriter(writer, currentSid)) {
          throw new Error("Legacy state directory ACL grants write access to an untrusted principal");
        }
      } else if (line === "END") {
        endCount += 1;
      } else {
        throw new Error("Legacy state directory ACL inspection returned malformed output");
      }
    }
    if (ownerCount !== batch.length || endCount !== batch.length) {
      throw new Error("Legacy state directory ACL inspection returned an incomplete result");
    }
  }
}

export interface LegacyWindowsStateInspection {
  legacyRoot: string;
  artifacts: string[];
  directArtifacts: string[];
  lifecycleTickets: string[];
  inspectionFailures: string[];
  manualInspectionFailures: string[];
}

function inspectLegacyWindowsWorkspaceState(
  workspaceId: string,
  options: LegacyWindowsStateProbeOptions,
  requirePrivateAcls = false
): LegacyWindowsStateInspection {
  const platform = options.platform ?? process.platform;
  const layout = inspectLegacyWindowsDirectoryLayout(workspaceId, options, platform);
  const legacyRoot = layout.legacyRoot;
  if (layout.inspectionFailures.length > 0) {
    return {
      legacyRoot,
      artifacts: [],
      directArtifacts: [],
      lifecycleTickets: [],
      inspectionFailures: [...new Set(layout.inspectionFailures)].sort(),
      manualInspectionFailures: [],
    };
  }
  if (requirePrivateAcls) {
    assertPrivateWindowsAcls(
      [...layout.existingDirectories].sort().map((directory) => ({
        path: directory,
        kind: "directory" as const,
      })),
      platform
    );
  }

  const directArtifacts: string[] = [];
  const inspectionFailures: string[] = [];
  const hasDirectory = (...segments: string[]): boolean =>
    layout.existingDirectories.has(path.join(legacyRoot, ...segments));
  const addLeafIfPresent = (file: string): void => {
    try {
      fs.lstatSync(file);
      directArtifacts.push(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") directArtifacts.push(file);
    }
  };

  if (hasDirectory("runtime")) {
    addLeafIfPresent(path.join(legacyRoot, "runtime", `${workspaceId}.json`));
  }
  if (hasDirectory("runtime-generations", workspaceId)) {
    const generations = matchingEntriesInValidatedDirectory(
      path.join(legacyRoot, "runtime-generations", workspaceId),
      (name) => name.endsWith(".json")
    );
    directArtifacts.push(...generations.matches);
    inspectionFailures.push(...generations.inspectionFailures);
  }
  if (hasDirectory("transports")) {
    addLeafIfPresent(path.join(legacyRoot, "transports", `${workspaceId}.token`));
    addLeafIfPresent(path.join(legacyRoot, "transports", `${workspaceId}.json`));
  }
  if (hasDirectory("auth")) {
    addLeafIfPresent(path.join(legacyRoot, "auth", `${workspaceId}.json`));
  }
  if (hasDirectory("tunnels")) {
    addLeafIfPresent(path.join(legacyRoot, "tunnels", `${workspaceId}.json`));
  }
  if (hasDirectory("endpoints")) {
    addLeafIfPresent(path.join(legacyRoot, "endpoints", `${workspaceId}.json`));
  }

  const artifacts = [...directArtifacts];
  const lifecycleTickets: string[] = [];
  if (hasDirectory("pending-starts")) {
    const pending = matchingEntriesInValidatedDirectory(
      path.join(legacyRoot, "pending-starts"),
      (name) => name.startsWith(`${workspaceId}.`) && name.endsWith(".pending.json")
    );
    artifacts.push(...pending.matches);
    inspectionFailures.push(...pending.inspectionFailures);
  }
  if (hasDirectory("locks")) {
    const locks = matchingEntriesInValidatedDirectory(
      path.join(legacyRoot, "locks"),
      (name) => name.startsWith(`${workspaceId}.lifecycle.`) && name.endsWith(".ticket.json")
    );
    lifecycleTickets.push(...locks.matches);
    artifacts.push(...lifecycleTickets);
    inspectionFailures.push(...locks.inspectionFailures);
  }

  return {
    legacyRoot,
    artifacts: [...new Set(artifacts)].sort(),
    directArtifacts: [...new Set(directArtifacts)].sort(),
    lifecycleTickets: [...new Set(lifecycleTickets)].sort(),
    inspectionFailures: [...new Set(inspectionFailures)].sort(),
    manualInspectionFailures: [],
  };
}

type LegacyLifecycleTicketDisposition = "preserve" | "removable" | "manual";

function processIsDefinitelyAbsent(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

function legacyLifecycleTicketDisposition(
  workspaceId: string,
  file: string,
  activeNonce: string,
  mtimeMs: number,
  content: string
): LegacyLifecycleTicketDisposition {
  const prefix = `${workspaceId}.lifecycle.`;
  const suffix = ".ticket.json";
  const name = path.basename(file);
  if (!name.startsWith(prefix) || !name.endsWith(suffix)) return "preserve";
  const filenameNonce = name.slice(prefix.length, -suffix.length);
  const isActiveTicket = filenameNonce === activeNonce;
  const ticket = parseWorkspaceLifecycleTicket(content);
  if (!ticket || ticket.nonce !== filenameNonce) return "manual";
  if (
    !isActiveTicket &&
    (mtimeMs <= 0 || Date.now() - mtimeMs < DEFAULT_LIFECYCLE_ORPHAN_GRACE_MS)
  ) {
    return "preserve";
  }
  if (isActiveTicket) return "preserve";
  const { pid, processGeneration } = ticket;
  if (processGeneration === undefined || processGeneration === null) {
    return processIsDefinitelyAbsent(pid) ? "removable" : "manual";
  }
  if (
    typeof processGeneration !== "string" ||
    !/^win32:\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/u.test(processGeneration) ||
    !Number.isFinite(Date.parse(processGeneration.slice("win32:".length)))
  ) {
    return "manual";
  }
  return processGenerationStatus(pid, processGeneration) === "mismatch"
    ? "removable"
    : "preserve";
}

function unlinkProvenStaleLifecycleTicket(
  legacyRoot: string,
  workspaceId: string,
  file: string,
  activeNonce: string,
  platform: NodeJS.Platform
): boolean {
  assertLegacyCleanupLockHeld(workspaceId, activeNonce, legacyRoot, platform);
  const resolvedFile = path.resolve(file);
  assertSafeLegacyDirectoryChain(legacyRoot, path.dirname(resolvedFile), platform);
  const constants = fs.constants as typeof fs.constants & { O_NOFOLLOW?: number; O_NONBLOCK?: number };
  let descriptor: number;
  try {
    descriptor = fs.openSync(
      resolvedFile,
      fs.constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let opened: fs.BigIntStats;
  let content: string;
  try {
    opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw new Error(`Legacy lifecycle ticket is not a private regular file: ${resolvedFile}`);
    }
    content = fs.readFileSync(descriptor, "utf8");
  } finally {
    fs.closeSync(descriptor);
  }
  if (legacyLifecycleTicketDisposition(
    workspaceId,
    resolvedFile,
    activeNonce,
    Number(opened.mtimeMs),
    content
  ) !== "removable") {
    return false;
  }
  assertPrivateWindowsAcls([{ path: resolvedFile, kind: "file" }], platform);
  assertLegacyCleanupLockHeld(workspaceId, activeNonce, legacyRoot, platform);
  assertSafeLegacyDirectoryChain(legacyRoot, path.dirname(resolvedFile), platform);
  const current = fs.lstatSync(resolvedFile, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1n ||
    !sameFileIdentity(opened, current) ||
    current.mtimeMs !== opened.mtimeMs
  ) {
    throw new Error(`Legacy lifecycle ticket changed before cleanup: ${resolvedFile}`);
  }
  fs.unlinkSync(resolvedFile);
  return true;
}

/** Validate every path that revoke may read, create, or remove before selecting the old state root. */
export function validateLegacyWindowsStateForCleanup(
  workspaceId: string,
  options: LegacyWindowsCleanupOptions = {}
): LegacyWindowsStateInspection {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("Legacy Windows state cleanup is supported only on Windows");
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace id for legacy Windows state cleanup");
  }
  const inspection = inspectLegacyWindowsWorkspaceState(workspaceId, options, true);
  if (inspection.inspectionFailures.length > 0) {
    throw new LegacyWindowsStateError(
      inspection.legacyRoot,
      inspection.artifacts,
      inspection.inspectionFailures
    );
  }

  const identities = new Map<string, fs.BigIntStats>();
  for (const file of inspection.artifacts) {
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(file, { bigint: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Legacy workspace artifact is a symbolic link, reparse point, or non-file: ${file}`);
    }
    if (stat.nlink !== 1n) {
      throw new Error(`Legacy workspace artifact has multiple hard links: ${file}`);
    }
    identities.set(file, stat);
  }
  assertPrivateWindowsAcls(
    [...identities.keys()].map((file) => ({ path: file, kind: "file" as const })),
    platform
  );
  for (const [file, before] of identities) {
    assertSafeLegacyDirectoryChain(inspection.legacyRoot, path.dirname(file), platform);
    const current = fs.lstatSync(file, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameFileIdentity(before, current)
    ) {
      throw new Error(`Legacy workspace artifact changed during cleanup preflight: ${file}`);
    }
  }
  const manualInspectionFailures: string[] = [];
  for (const file of inspection.lifecycleTickets) {
    const before = identities.get(file);
    if (!before) continue;
    const constants = fs.constants as typeof fs.constants & { O_NOFOLLOW?: number; O_NONBLOCK?: number };
    let descriptor: number;
    try {
      descriptor = fs.openSync(
        file,
        fs.constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    let opened: fs.BigIntStats;
    let content: string;
    try {
      opened = fs.fstatSync(descriptor, { bigint: true });
      if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) {
        throw new Error(`Legacy lifecycle ticket changed during cleanup preflight: ${file}`);
      }
      content = fs.readFileSync(descriptor, "utf8");
    } finally {
      fs.closeSync(descriptor);
    }
    assertSafeLegacyDirectoryChain(inspection.legacyRoot, path.dirname(file), platform);
    const current = fs.lstatSync(file, { bigint: true });
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.nlink !== 1n ||
      !sameFileIdentity(opened, current) ||
      current.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`Legacy lifecycle ticket changed during cleanup preflight: ${file}`);
    }
    if (
      legacyLifecycleTicketDisposition(
        workspaceId,
        file,
        options.activeLifecycleNonce ?? "",
        Number(opened.mtimeMs),
        content
      ) === "manual"
    ) {
      manualInspectionFailures.push(file);
    }
  }
  if (manualInspectionFailures.length > 0) {
    throw new LegacyWindowsStateError(
      inspection.legacyRoot,
      inspection.artifacts,
      inspection.inspectionFailures,
      manualInspectionFailures
    );
  }
  return inspection;
}

function unlinkVerifiedWorkspaceArtifact(
  legacyRoot: string,
  file: string,
  platform: NodeJS.Platform
): boolean {
  const resolvedFile = path.resolve(file);
  assertSafeLegacyDirectoryChain(legacyRoot, path.dirname(resolvedFile), platform);

  let before: fs.BigIntStats;
  try {
    before = fs.lstatSync(resolvedFile, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error(`Legacy workspace artifact is a symbolic link, reparse point, or non-file: ${resolvedFile}`);
  }
  if (before.nlink !== 1n) {
    throw new Error(`Legacy workspace artifact has multiple hard links: ${resolvedFile}`);
  }

  const constants = fs.constants as typeof fs.constants & { O_NOFOLLOW?: number; O_NONBLOCK?: number };
  const descriptor = fs.openSync(
    resolvedFile,
    fs.constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)
  );
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameFileIdentity(before, opened)) {
      throw new Error(`Legacy workspace artifact changed while it was being opened: ${resolvedFile}`);
    }
  } finally {
    fs.closeSync(descriptor);
  }

  // Re-check the complete parent chain and leaf identity immediately before
  // unlinking so a junction or replacement introduced during inspection does
  // not redirect cleanup outside the legacy state root.
  assertSafeLegacyDirectoryChain(legacyRoot, path.dirname(resolvedFile), platform);
  const current = fs.lstatSync(resolvedFile, { bigint: true });
  if (
    current.isSymbolicLink() ||
    !current.isFile() ||
    current.nlink !== 1n ||
    !sameFileIdentity(before, current)
  ) {
    throw new Error(`Legacy workspace artifact changed before cleanup: ${resolvedFile}`);
  }
  fs.unlinkSync(resolvedFile);
  return true;
}

function assertLegacyCleanupLockHeld(
  workspaceId: string,
  activeNonce: string | undefined,
  legacyRoot: string,
  platform: NodeJS.Platform
): asserts activeNonce is string {
  const selectedStateDir = process.env.C2C_STATE_DIR;
  if (
    !activeNonce ||
    !selectedStateDir ||
    normalizedPath(selectedStateDir, platform) !== normalizedPath(legacyRoot, platform)
  ) {
    throw new Error("Legacy cleanup does not hold the selected workspace lifecycle lock");
  }
  const locksDirectory = path.join(legacyRoot, "locks");
  try {
    assertSafeLegacyDirectoryChain(legacyRoot, locksDirectory, platform);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Legacy cleanup does not hold the selected workspace lifecycle lock");
    }
    throw error;
  }
  if (!isWorkspaceLifecycleLockHeldByInStateRoot(legacyRoot, workspaceId, activeNonce)) {
    throw new Error("Legacy cleanup lost its selected workspace lifecycle lock");
  }
}

/**
 * Revalidate the complete legacy view and prove the selected lock is still
 * owned before any credential or runtime revocation starts.
 */
export function validateLegacyWindowsStateForCleanupUnderLock(
  workspaceId: string,
  options: LegacyWindowsCleanupOptions & { activeLifecycleNonce: string }
): LegacyWindowsStateInspection {
  const platform = options.platform ?? process.platform;
  const inspection = validateLegacyWindowsStateForCleanup(workspaceId, options);
  assertLegacyCleanupLockHeld(
    workspaceId,
    options.activeLifecycleNonce,
    inspection.legacyRoot,
    platform
  );
  return inspection;
}

/**
 * Remove only exact per-workspace records after revokeWorkspaceAccess has
 * already proved quiescence. Shared directories stay in place. When the caller
 * proves lifecycle-lock ownership, cleanup removes only expired tickets whose
 * process generation mismatches or whose generationless PID is confirmed gone.
 * The active ticket and every fresh, ambiguous, or malformed contender remain
 * untouched.
 */
export function cleanupLegacyWindowsWorkspaceArtifacts(
  workspaceId: string,
  options: LegacyWindowsCleanupOptions = {}
): { legacyRoot: string; removed: number } {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") throw new Error("Legacy Windows state cleanup is supported only on Windows");
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace id for legacy Windows state cleanup");
  }

  const legacyRoot = getLegacyWindowsStateDir(options);
  const activeNonce = options.activeLifecycleNonce;
  if (!activeNonce) {
    throw new Error("Legacy cleanup does not hold the selected workspace lifecycle lock");
  }
  const inspection = validateLegacyWindowsStateForCleanupUnderLock(workspaceId, {
    ...options,
    activeLifecycleNonce: activeNonce,
  });
  let removed = 0;
  for (const file of inspection.directArtifacts) {
    assertLegacyCleanupLockHeld(workspaceId, activeNonce, legacyRoot, platform);
    if (unlinkVerifiedWorkspaceArtifact(legacyRoot, file, platform)) removed += 1;
  }

  for (const file of inspection.lifecycleTickets) {
    assertLegacyCleanupLockHeld(workspaceId, activeNonce, legacyRoot, platform);
    if (
      unlinkProvenStaleLifecycleTicket(
        legacyRoot,
        workspaceId,
        file,
        activeNonce,
        platform
      )
    ) {
      removed += 1;
    }
  }

  assertLegacyCleanupLockHeld(workspaceId, activeNonce, legacyRoot, platform);
  const remaining = validateLegacyWindowsStateForCleanup(workspaceId, options).directArtifacts;
  assertLegacyCleanupLockHeld(workspaceId, activeNonce, legacyRoot, platform);
  if (remaining.length > 0) throw new LegacyWindowsStateError(legacyRoot, remaining);
  return { legacyRoot, removed };
}

/**
 * The pre-0.1 Windows default was LocalAppData. Packaged callers can see a
 * virtualized copy there while detached processes see the host copy. Until the
 * old workspace is explicitly quiesced, silently switching directories could
 * create two Bridges with different credentials.
 */
export function assertNoLegacyWindowsWorkspaceState(
  workspaceId: string,
  options: LegacyWindowsStateProbeOptions = {}
): void {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return;
  if (!/^[A-Za-z0-9._-]+$/.test(workspaceId)) {
    throw new Error("Invalid workspace id for legacy Windows state inspection");
  }

  assertSafeLegacyWindowsBasePath(options, platform);
  const home = options.home ?? os.homedir();
  const legacyRoot = getLegacyWindowsStateDir(options);
  const newRoot = path.resolve(home, ".config", "codex-with-chatgpt", "c2c-state");
  if (legacyRoot.toLowerCase() === newRoot.toLowerCase()) return;
  // Never classify an old runtime record as dead from inside a packaged
  // process. AppData's package overlay can present a stale private record at
  // the same logical pathname while hiding a live full-trust host record.
  // Requiring every workspace-specific record to be cleared externally makes
  // either view fail closed instead of trusting the masked PID snapshot.
  const inspection = inspectLegacyWindowsWorkspaceState(workspaceId, options);
  if (inspection.artifacts.length > 0 || inspection.inspectionFailures.length > 0) {
    throw new LegacyWindowsStateError(
      legacyRoot,
      inspection.artifacts,
      inspection.inspectionFailures
    );
  }
}
