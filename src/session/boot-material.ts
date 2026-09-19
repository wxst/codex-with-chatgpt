import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { stateSubdir } from "../config/paths.js";

const PREPARATION_ID = /^c2c_boot_[0-9a-f-]{36}$/u;
const MATERIAL_FILE = /^boot-c2c_boot_[0-9a-f-]{36}\.json$/u;

export interface BootMaterial {
  version: 1;
  preparationId: string;
  workspaceId: string;
  taskId: string;
  conversationId: string;
  generation: number;
  assignmentEpoch: number;
  capabilityId: string;
  token: string;
  messageId: string;
  iteration: number;
  body: string;
  bodySha256: string;
  createdAt: string;
}

function digest(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

function currentWindowsSid(): string {
  try {
    const sid = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", "[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value"],
      { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
    if (!/^S-1-5-\d+(?:-\d+)+$/u.test(sid)) throw new Error("invalid SID");
    return sid;
  } catch {
    throw new Error("BOOT_MATERIAL_PERMISSION_FAILED: cannot determine the current Windows user SID");
  }
}

/** Restrict sensitive material to the current user and SYSTEM. */
function hardenWindowsAcl(target: string, directory: boolean): void {
  const sid = currentWindowsSid();
  const inheritance = directory ? "(OI)(CI)F" : "F";
  const result = spawnSync("icacls.exe", [target, "/inheritance:r", "/grant:r",
    `*${sid}:${inheritance}`, `*S-1-5-18:${inheritance}`],
  { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) {
    throw new Error(`BOOT_MATERIAL_PERMISSION_FAILED: icacls rejected private material (${(result.stderr || result.stdout).trim().slice(0, 160)})`);
  }
}

function ensurePrivateDirectory(): string {
  const directory = stateSubdir("boot-material");
  try {
    if (process.platform === "win32") hardenWindowsAcl(directory, true);
    else fs.chmodSync(directory, 0o700);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("BOOT_MATERIAL_PERMISSION_FAILED")) throw error;
    throw new Error(`BOOT_MATERIAL_PERMISSION_FAILED: cannot secure private material directory (${message.slice(0, 160)})`);
  }
  return directory;
}

function assertPreparationId(id: string): string {
  const normalized = id.trim();
  if (!PREPARATION_ID.test(normalized)) throw new Error("BOOT_PREPARATION_ID_INVALID");
  return normalized;
}

function assertMaterialPath(file: string): string {
  const directory = ensurePrivateDirectory();
  const resolved = path.resolve(file);
  if (path.dirname(resolved) !== directory || !MATERIAL_FILE.test(path.basename(resolved))) {
    throw new Error("BOOT_MATERIAL_PATH_INVALID");
  }
  return resolved;
}

function assertPrivateRegularFile(file: string): void {
  const stat = fs.lstatSync(file, { bigint: true });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1n) {
    throw new Error("BOOT_MATERIAL_TAMPERED: expected a private regular file");
  }
}

function validateMaterial(value: unknown): BootMaterial {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("BOOT_MATERIAL_TAMPERED: invalid JSON");
  const m = value as Partial<BootMaterial>;
  if (m.version !== 1 || typeof m.preparationId !== "string" || !PREPARATION_ID.test(m.preparationId) ||
    ![m.workspaceId, m.taskId, m.conversationId, m.capabilityId, m.token, m.messageId, m.body, m.bodySha256, m.createdAt]
      .every(value => typeof value === "string") ||
    !Number.isSafeInteger(m.generation) || !Number.isSafeInteger(m.assignmentEpoch) ||
    !Number.isSafeInteger(m.iteration) || m.generation! < 1 || m.assignmentEpoch! < 1 || m.iteration! < 0 ||
    !/^c2c_route_id_[0-9a-f-]{36}$/u.test(m.capabilityId!) || !m.token!.startsWith("c2c_route_") ||
    !/^c2c_msg_[0-9a-f-]{36}$/u.test(m.messageId!) || !/^[0-9a-f]{64}$/u.test(m.bodySha256!) ||
    digest(m.body!) !== m.bodySha256) {
    throw new Error("BOOT_MATERIAL_TAMPERED: invalid private BOOT material");
  }
  return m as BootMaterial;
}

export function bootMaterialFile(preparationId: string): string {
  return path.join(ensurePrivateDirectory(), `boot-${assertPreparationId(preparationId)}.json`);
}

export function readBootMaterial(file: string): BootMaterial {
  const resolved = assertMaterialPath(file);
  try {
    assertPrivateRegularFile(resolved);
    const material = validateMaterial(JSON.parse(fs.readFileSync(resolved, "utf8")) as unknown);
    assertPrivateRegularFile(resolved);
    return material;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("BOOT_MATERIAL_MISSING");
    throw error;
  }
}

/**
 * Write material once. A concurrent writer can only recover the byte-identical
 * record; it cannot overwrite another preparation or weaken its ACL.
 */
export function writeBootMaterial(material: BootMaterial): string {
  const file = bootMaterialFile(material.preparationId);
  const validated = validateMaterial(material);
  if (fs.existsSync(file)) {
    const existing = readBootMaterial(file);
    if (JSON.stringify(existing) !== JSON.stringify(validated)) throw new Error("BOOT_MATERIAL_CONFLICT");
    return file;
  }
  const temp = path.join(path.dirname(file), `.boot-${process.pid}-${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temp, "wx", 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(validated), "utf8");
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (process.platform === "win32") hardenWindowsAcl(temp, false);
    else fs.chmodSync(temp, 0o600);
    try {
      fs.renameSync(temp, file);
    } catch (error) {
      if (!fs.existsSync(file)) throw error;
      const existing = readBootMaterial(file);
      if (JSON.stringify(existing) !== JSON.stringify(validated)) throw new Error("BOOT_MATERIAL_CONFLICT");
      return file;
    }
    if (process.platform === "win32") hardenWindowsAcl(file, false);
    else fs.chmodSync(file, 0o600);
    assertPrivateRegularFile(file);
    return file;
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* preserve the original failure */ }
    const message = error instanceof Error ? error.message : String(error);
    if (message.startsWith("BOOT_")) throw error;
    throw new Error(`BOOT_MATERIAL_PERMISSION_FAILED: cannot write private BOOT material (${message.slice(0, 160)})`);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* preserve the original failure */ }
    }
  }
}

export function removeBootMaterial(file: string): void {
  const resolved = assertMaterialPath(file);
  try {
    assertPrivateRegularFile(resolved);
    fs.unlinkSync(resolved);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

export function bootMaterialDigest(body: string): string {
  return digest(body);
}
