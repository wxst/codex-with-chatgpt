import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function validPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function linuxGeneration(pid: number): string | null {
  try {
    const procDir = fs.statSync(`/proc/${pid}`);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return null;

    const fieldsFromThree = stat.slice(closeParen + 1).trim().split(/\s+/);
    const startTicks = fieldsFromThree[19];
    if (!startTicks || !/^\d+$/.test(startTicks)) return null;
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    if (!bootId) return null;
    return `linux:${bootId}:${procDir.ino}:${startTicks}`;
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

const LINUX_PIDFD_CAPABILITY_SCRIPT = String.raw`
import os, signal, sys
ok = (
    sys.version_info >= (3, 9)
    and hasattr(os, "pidfd_open")
    and hasattr(signal, "pidfd_send_signal")
)
sys.exit(0 if ok else 20)
`;

let cachedLinuxPidfdPython: string | null | undefined;

function detectLinuxPidfdPython(): string | null {
  if (cachedLinuxPidfdPython !== undefined) return cachedLinuxPidfdPython;
  for (const executable of [process.env.C2C_PYTHON, "python3", "python"]) {
    if (!executable) continue;
    try {
      const result = spawnSync(executable, ["-c", LINUX_PIDFD_CAPABILITY_SCRIPT], {
        encoding: "utf8",
        timeout: 2500,
        windowsHide: true,
      });
      if (result.error && (result.error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (result.status === 0) {
        cachedLinuxPidfdPython = executable;
        return executable;
      }
    } catch {
      // Try the next declared interpreter name.
    }
  }
  cachedLinuxPidfdPython = null;
  return null;
}

/**
 * Validate process-safety prerequisites before a Bridge can load credentials.
 * Linux requires Python 3.9+ exposing pidfd_open/pidfd_send_signal so an
 * unresponsive Bridge can be terminated through a generation-bound kernel
 * process handle instead of an unsafe reusable numeric PID.
 */
export function requireProcessSafetyRuntime(): void {
  if (process.platform !== "linux") return;
  if (!detectLinuxPidfdPython()) {
    throw new Error(
      "Linux requires Python 3.9+ with os.pidfd_open and signal.pidfd_send_signal for safe Bridge lifecycle management. " +
        "Install a suitable Python runtime or set C2C_PYTHON to its executable."
    );
  }
}

const LINUX_PIDFD_SIGNAL_SCRIPT = String.raw`
import os, signal, sys
pid = int(sys.argv[1])
expected = sys.argv[2]
sig_name = sys.argv[3]
fd = None
try:
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        sys.exit(20)
    fd = os.pidfd_open(pid, 0)
    proc_dir = os.stat(f"/proc/{pid}")
    with open(f"/proc/{pid}/stat", "r", encoding="utf-8") as handle:
        stat = handle.read()
    close_paren = stat.rfind(")")
    if close_paren < 0:
        sys.exit(21)
    fields = stat[close_paren + 1:].strip().split()
    if len(fields) <= 19:
        sys.exit(21)
    start_ticks = fields[19]
    with open("/proc/sys/kernel/random/boot_id", "r", encoding="utf-8") as handle:
        boot_id = handle.read().strip()
    actual = f"linux:{boot_id}:{proc_dir.st_ino}:{start_ticks}"
    if actual != expected:
        sys.exit(22)
    sig = getattr(signal, sig_name)
    signal.pidfd_send_signal(fd, sig, None, 0)
    sys.exit(0)
except ProcessLookupError:
    sys.exit(23)
except (PermissionError, OSError, ValueError, AttributeError):
    sys.exit(24)
finally:
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass
`;

function signalLinuxPidfd(pid: number, expectedGeneration: string, signalName: NodeJS.Signals): boolean {
  const executable = detectLinuxPidfdPython();
  if (!executable) return false;
  try {
    const result = spawnSync(
      executable,
      ["-c", LINUX_PIDFD_SIGNAL_SCRIPT, String(pid), expectedGeneration, signalName],
      { encoding: "utf8", timeout: 3000, windowsHide: true }
    );
    return result.status === 0;
  } catch {
    return false;
  }
}

function signalWindowsProcessHandle(pid: number, expectedGeneration: string): boolean {
  try {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const escapedExpected = expectedGeneration.replace(/'/g, "''");
    const script = [
      "$ErrorActionPreference='Stop'",
      `$p=Get-Process -Id ${pid}`,
      "$actual='win32:'+$p.StartTime.ToUniversalTime().ToString('o')",
      `if ($actual -ne '${escapedExpected}') { exit 22 }`,
      "$p.Kill()",
      "exit 0",
    ].join("; ");
    const result = spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
      timeout: 3000,
      windowsHide: true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function signalExactProcessGeneration(
  pid: number,
  expectedGeneration: string,
  signalName: NodeJS.Signals
): boolean {
  if (!validPid(pid) || !expectedGeneration) return false;
  if (process.platform === "linux") return signalLinuxPidfd(pid, expectedGeneration, signalName);
  if (process.platform === "win32") return signalWindowsProcessHandle(pid, expectedGeneration);
  return false;
}
