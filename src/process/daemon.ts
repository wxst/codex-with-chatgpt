import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Workspace } from "../workspace/manager.js";
import { Logger } from "../logger/index.js";
import { stateSubdir } from "../config/paths.js";
import { findLiveBridge, probeBridge, readRuntimeState, type RuntimeState } from "../bridge/runtime.js";

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.resolve(moduleDir, "../cli/index.js");

function daemonLogFile(workspaceId: string): string {
  return path.join(stateSubdir("logs"), `bridge-${workspaceId}.out.log`);
}

export async function ensureBridge(workspaceRoot: string): Promise<{ runtime: RuntimeState; spawned: boolean }> {
  const workspace = new Workspace(workspaceRoot);
  const existing = await findLiveBridge(workspace.id);
  if (existing) return { runtime: existing, spawned: false };

  const logFile = daemonLogFile(workspace.id);
  const logFd = fs.openSync(logFile, "a", 0o600);
  const child = spawn(process.execPath, [cliEntry, "serve", "--workspace", workspace.root], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.closeSync(logFd);

  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const runtime = await findLiveBridge(workspace.id);
    if (runtime) return { runtime, spawned: true };
    if (child.exitCode !== null && child.exitCode !== 0) {
      throw new Error(`Bridge process exited with code ${child.exitCode}. See ${logFile}`);
    }
  }
  throw new Error(`Bridge did not become healthy within 20s. See ${logFile}`);
}

export async function adminFetch<T = unknown>(
  runtime: RuntimeState,
  method: "GET" | "POST",
  route: string,
  timeoutMs = 60_000
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.port}${route}`, {
      method,
      headers: { Authorization: `Bearer ${runtime.adminToken}` },
      signal: controller.signal,
    });
    const body = (await response.json().catch(() => ({}))) as T & { message?: string };
    if (!response.ok) {
      throw new Error((body as { message?: string }).message ?? `Admin request failed (${response.status})`);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

export async function stopBridge(workspaceRoot: string): Promise<boolean> {
  const workspace = new Workspace(workspaceRoot);
  const runtime = readRuntimeState(workspace.id);
  if (!runtime) return false;

  // A persisted PID can be stale and later reused by an unrelated process.
  // Never send a signal until this runtime has been positively identified as
  // the bridge for the requested workspace.
  const healthy = await probeBridge(runtime.port);
  let identityConfirmed = Boolean(healthy && healthy.workspaceId === workspace.id);

  if (!identityConfirmed) {
    try {
      const info = await adminFetch<{ workspaceId?: string }>(runtime, "GET", "/admin/info", 2000);
      identityConfirmed = info.workspaceId === workspace.id;
    } catch {
      identityConfirmed = false;
    }
  }

  if (!identityConfirmed) return false;

  try {
    await adminFetch(runtime, "POST", "/admin/shutdown", 5000);
    return true;
  } catch {
    // Identity was confirmed above, so a PID-level fallback cannot target an
    // arbitrary stale/reused process merely because the runtime file survived.
  }

  try {
    process.kill(runtime.pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}
