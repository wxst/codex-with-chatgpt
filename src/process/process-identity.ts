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

function numericPidExists(pid: number): boolean {
  if (!validPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export type ProcessGenerationStatus = "match" | "mismatch" | "unknown";

export function classifyProcessGeneration(
  observedGeneration: string | null,
  pidExists: boolean,
  expectedGeneration: string
): ProcessGenerationStatus {
  if (!expectedGeneration) return "mismatch";
  if (observedGeneration) return observedGeneration === expectedGeneration ? "match" : "mismatch";
  return pidExists ? "unknown" : "mismatch";
}

export function processGenerationStatus(pid: number, expectedGeneration: string): ProcessGenerationStatus {
  if (!validPid(pid) || !expectedGeneration) return "mismatch";
  const observed = getProcessGeneration(pid);
  return classifyProcessGeneration(observed, observed === null && numericPidExists(pid), expectedGeneration);
}

export function processGenerationMatches(pid: number, expectedGeneration: string): boolean {
  return processGenerationStatus(pid, expectedGeneration) === "match";
}

export function requireCurrentProcessGeneration(): string {
  const generation = getProcessGeneration(process.pid);
  if (!generation) {
    throw new Error(`Unable to determine process generation on ${process.platform}`);
  }
  return generation;
}

export function supportsExactProcessTermination(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "linux" || platform === "win32";
}

const LINUX_PIDFD_CAPABILITY_SCRIPT = String.raw`
import os, signal, sys
fd = None
try:
    if sys.version_info < (3, 9):
        sys.exit(20)
    if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
        sys.exit(20)
    fd = os.pidfd_open(os.getpid(), 0)
    signal.pidfd_send_signal(fd, 0, None, 0)
    sys.exit(0)
except (PermissionError, ProcessLookupError, OSError, ValueError, AttributeError):
    sys.exit(21)
finally:
    if fd is not None:
        try:
            os.close(fd)
        except OSError:
            pass
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

export function requireProcessSafetyRuntime(): void {
  if (!supportsExactProcessTermination(process.platform)) {
    throw new Error(
      `Hardened Bridge startup is not supported on ${process.platform}: no generation-bound exact process termination handle is implemented. ` +
        "Refusing to load OAuth or tunnel credentials because a wedged Bridge could not be safely revoked."
    );
  }

  if (process.platform === "linux") {
    if (!detectLinuxPidfdPython()) {
      throw new Error(
        "Linux requires Python 3.9+ with working os.pidfd_open and signal.pidfd_send_signal syscalls for safe Bridge lifecycle management. " +
          "Install a suitable Python runtime, set C2C_PYTHON to it, and ensure the kernel/container seccomp policy allows pidfd operations."
      );
    }
    return;
  }

  if (process.platform === "win32" && !windowsGeneration(process.pid)) {
    throw new Error("Windows cannot establish a generation-bound process handle for safe Bridge lifecycle management.");
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

const WINDOWS_HANDLE_SIGNAL_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
$source=@'
using System;
using System.Runtime.InteropServices;
public static class C2CProcessNative {
  [StructLayout(LayoutKind.Sequential)]
  public struct FILETIME { public uint dwLowDateTime; public uint dwHighDateTime; }
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool GetProcessTimes(IntPtr hProcess, out FILETIME creation, out FILETIME exit, out FILETIME kernel, out FILETIME user);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool TerminateProcess(IntPtr hProcess, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern bool CloseHandle(IntPtr hObject);
}
'@
Add-Type -TypeDefinition $source -Language CSharp
$pidValue=[uint32]$args[0]
$expected=$args[1]
$PROCESS_TERMINATE=0x0001
$PROCESS_QUERY_LIMITED_INFORMATION=0x1000
$handle=[C2CProcessNative]::OpenProcess($PROCESS_TERMINATE -bor $PROCESS_QUERY_LIMITED_INFORMATION,$false,$pidValue)
if ($handle -eq [IntPtr]::Zero) { exit 21 }
try {
  $creation=New-Object C2CProcessNative+FILETIME
  $exitTime=New-Object C2CProcessNative+FILETIME
  $kernel=New-Object C2CProcessNative+FILETIME
  $user=New-Object C2CProcessNative+FILETIME
  if (-not [C2CProcessNative]::GetProcessTimes($handle,[ref]$creation,[ref]$exitTime,[ref]$kernel,[ref]$user)) { exit 23 }
  $creationTicks=([int64]$creation.dwHighDateTime * 4294967296L) + [int64]$creation.dwLowDateTime
  $actual='win32:'+[DateTime]::FromFileTimeUtc($creationTicks).ToString('o')
  if ($actual -ne $expected) { exit 22 }
  if (-not [C2CProcessNative]::TerminateProcess($handle,1)) { exit 24 }
  exit 0
} finally {
  [void][C2CProcessNative]::CloseHandle($handle)
}
`;

function signalWindowsProcessHandle(pid: number, expectedGeneration: string): boolean {
  try {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    const powershell = path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const result = spawnSync(
      powershell,
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_HANDLE_SIGNAL_SCRIPT, String(pid), expectedGeneration],
      { encoding: "utf8", timeout: 5000, windowsHide: true }
    );
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
