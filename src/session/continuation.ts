import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { getStateDir, writeSecureJson } from "../config/paths.js";
import { hardenWindowsAcl, assertPrivateWindowsAcl } from "./boot-material.js";

/** Private write-ahead lease receipt. Never serialize this into diagnostics. */
export interface ContinuationReceipt {
  version: 1;
  taskId: string;
  useId: string;
  boundWorkspaceId: string;
  conversationId: string;
  generation: number;
  assignmentEpoch: number;
  createdAt: string;
  updatedAt: string;
  stage: "prepared" | "active" | "released";
}

export function continuationFile(taskId: string): string {
  return path.join(getStateDir(), "continuations", createHash("sha256").update(taskId).digest("hex") + ".json");
}

export function readContinuation(taskId: string): ContinuationReceipt | null {
  const file = continuationFile(taskId);
  try {
    const directory = fs.lstatSync(path.dirname(file));
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
      (process.platform !== "win32" && (directory.mode & 0o077) !== 0)) throw new Error();
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 ||
      (process.platform !== "win32" && (stat.mode & 0o077) !== 0)) throw new Error();
    assertPrivateWindowsAcl([path.dirname(file), file]);
    const r = JSON.parse(fs.readFileSync(file, "utf8")) as ContinuationReceipt;
    if (r.version !== 1 || r.taskId !== taskId || !/^c2c_use_[0-9a-f-]{36}$/.test(r.useId) ||
      typeof r.boundWorkspaceId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(r.boundWorkspaceId) || typeof r.conversationId !== "string" || !r.conversationId.trim() ||
      !Number.isSafeInteger(r.generation) || r.generation < 1 ||
      !Number.isSafeInteger(r.assignmentEpoch) || r.assignmentEpoch < 1 ||
      typeof r.createdAt !== "string" || typeof r.updatedAt !== "string" ||
      !Number.isFinite(Date.parse(r.createdAt)) || !Number.isFinite(Date.parse(r.updatedAt)) ||
      !["prepared", "active", "released"].includes(r.stage)) throw new Error();
    return r;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("LEASE_CONTINUATION_INVALID: private continuation is unreadable or invalid");
  }
}

export function writeContinuation(receipt: ContinuationReceipt): void {
  const file = continuationFile(receipt.taskId), directory = path.dirname(file);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error("LEASE_CONTINUATION_INVALID");
  if (process.platform === "win32") hardenWindowsAcl(directory, true);
  else fs.chmodSync(directory, 0o700);
  // Atomic temporary files inherit the restricted directory ACL on Windows.
  writeSecureJson(file, receipt);
}
