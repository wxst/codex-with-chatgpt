import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function linuxGeneration(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;

    // /proc/<pid>/stat field 3 starts immediately after the command's closing
    // parenthesis. Field 22 is process starttime in clock ticks since boot, so
    // it remains stable for one process generation and changes when a PID is
    // recycled. Include boot_id so a stale state file cannot match after reboot.
    const fieldsFromThree = stat.slice(closeParen + 1).trim().split(/\s+/);
    const startTicks = fieldsFromThree[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return null;
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!bootId) return null;
    return `linux:${bootId}:${startTicks}`;
  } catch {
    return null;
  }
}

function unixPsGeneration(pid: number): string | null {
  try {
    const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8",
      timeout: 1500,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const started = String(result.stdout ?? "").trim().replace(/\s+/g, " ");
    if (!started) return null;
    return `${process.platform}:${started}`;
  } catch {
    return null;
  }
}

function windowsGeneration(pid: number): string | null {
  try {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$p=Get-Process -Id ${pid}`,
      "$p.StartTime.ToUniversalTime().ToString('o')",
    ].join("; ");
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 2500,
      windowsHide: true,
    });
    if (result.status !== 0) return null;
    const started = String(result.stdout ?? "").trim();
    if (!started) return null;
    return `win32:${started}`;
  } catch {
    return null;
  }
}

/**
 * Return an OS-derived identity for one exact process generation.
 *
 * Numeric PIDs are intentionally insufficient because operating systems reuse
 * them. The returned value binds a PID to its creation/start generation; `null`
 * means the generation cannot be proven and callers should fail closed or fall
 * back to an authenticated application-level identity check.
 */
export function getProcessGeneration(pid: number): string | null {
  if (!validPid(pid)) return null;
  if (process.platform === "linux") return linuxGeneration(pid);
  if (process.platform === "win32") return windowsGeneration(pid);
  if (process.platform === "darwin" || process.platform === "freebsd" || process.platform === "openbsd") {
    return unixPsGeneration(pid);
  }
  return null;
}

export function processGenerationMatches(pid: number, expectedGeneration: string): boolean {
  if (!expectedGeneration) return false;
  return getProcessGeneration(pid) === expectedGeneration;
}

export function requireCurrentProcessGeneration(): string {
  const generation = getProcessGeneration(process.pid);
  if (!generation) {
    throw new Error(`Unable to determine process generation on ${process.platform}`);
  }
  return generation;
}
