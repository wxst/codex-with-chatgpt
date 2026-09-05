import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";

const WINDOWS_ATOMIC_RENAME_RETRY_MS = [2, 4, 8, 16, 32, 64] as const;
const WINDOWS_TRANSIENT_RENAME_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);

function atomicRename(temp: string, file: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(temp, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (process.platform !== "win32" || !WINDOWS_TRANSIENT_RENAME_CODES.has(code) || attempt >= WINDOWS_ATOMIC_RENAME_RETRY_MS.length) {
        throw error;
      }
      const signal = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
      Atomics.wait(signal, 0, 0, WINDOWS_ATOMIC_RENAME_RETRY_MS[attempt]);
    }
  }
}

/**
 * State directory resolution, following OS conventions.
 *
 * Production callers always share the canonical user directory. Test runs and
 * the narrowly-scoped legacy cleanup transaction may opt into an isolated
 * directory so they never split live Chat ownership.
 */
export function getStateDir(): string {
  const override = process.env.C2C_STATE_DIR;
  const allowOverride = process.env.VITEST === "true" ||
    process.env.NODE_ENV === "test" ||
    process.env.C2C_INTERNAL_STATE_DIR === "legacy-cleanup" ||
    process.env.C2C_INTERNAL_STATE_DIR === "test";
  if (allowOverride && override && override.trim() !== "") return path.resolve(override);
  const home = os.homedir();
  switch (process.platform) {
    case "darwin":
      return path.join(home, "Library", "Application Support", "codex-with-chatgpt");
    case "win32":
      // Packaged Windows callers can virtualize individual files under
      // LOCALAPPDATA into a package-specific LocalCache. Detached processes
      // then resolve the same-looking path to a different credential file.
      // Keep shared local state in the user's non-virtualized home tree.
      return path.join(home, ".config", "codex-with-chatgpt", "c2c-state");
    default: {
      const base = process.env.XDG_STATE_HOME ?? path.join(home, ".local", "state");
      return path.join(base, "codex-with-chatgpt");
    }
  }
}

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

export function stateSubdir(name: string): string {
  return ensureDir(path.join(getStateDir(), name));
}

/** Write a JSON file with owner-only permissions. */
export function writeSecureJson(file: string, data: unknown): void {
  ensureDir(path.dirname(file));
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  const serialized = JSON.stringify(data, null, 2);
  const descriptor = fs.openSync(temp, "w", 0o600);
  try {
    fs.writeFileSync(descriptor, serialized, "utf8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  try {
    fs.chmodSync(temp, 0o600);
  } catch {
    // best effort on platforms without chmod semantics
  }
  try {
    atomicRename(temp, file);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch { /* best effort */ }
    throw error;
  }
}

export function readJsonIfExists<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

export const DEFAULT_PORT = 48765;
export const DEFAULT_HOST = "127.0.0.1";
