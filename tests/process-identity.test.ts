import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  classifyProcessGeneration,
  getProcessGeneration,
  processGenerationMatches,
  requireCurrentProcessGeneration,
  requireProcessSafetyRuntime,
  signalExactProcessGeneration,
} from "../src/process/process-identity.js";

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});

async function waitForGeneration(pid: number): Promise<string> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    const generation = getProcessGeneration(pid);
    if (generation) return generation;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("process generation unavailable");
}

async function waitForExit(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit").then(() => undefined),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not exit")), 5000)),
  ]);
}

describe("process generation identity", () => {
  it("returns a stable generation for the current process", () => {
    const first = requireCurrentProcessGeneration();
    const second = getProcessGeneration(process.pid);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(processGenerationMatches(process.pid, first)).toBe(true);
  });

  it("classifies an unavailable generation on an existing PID as unknown, not mismatch", () => {
    expect(classifyProcessGeneration(null, true, "expected-generation")).toBe("unknown");
    expect(classifyProcessGeneration(null, false, "expected-generation")).toBe("mismatch");
    expect(classifyProcessGeneration("expected-generation", true, "expected-generation")).toBe("match");
    expect(classifyProcessGeneration("different-generation", true, "expected-generation")).toBe("mismatch");
  });

  it("validates the declared exact-termination helper runtime", () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    expect(() => requireProcessSafetyRuntime()).not.toThrow();
  });

  it("distinguishes another live process generation", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    const generation = await waitForGeneration(child.pid);
    expect(generation).not.toBe(requireCurrentProcessGeneration());
    expect(processGenerationMatches(child.pid, generation)).toBe(true);
  });

  it("no longer matches after that process exits", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    const generation = await waitForGeneration(child.pid);
    child.kill("SIGTERM");
    await waitForExit(child);
    expect(processGenerationMatches(child.pid, generation)).toBe(false);
  });

  it("refuses an atomic signal when the expected generation does not match", async () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    await waitForGeneration(child.pid);
    const wrongGeneration = process.platform === "linux" ? "linux:wrong-generation" : "win32:wrong-generation";
    expect(signalExactProcessGeneration(child.pid, wrongGeneration, "SIGKILL")).toBe(false);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it("uses a generation-bound handle to signal the exact supported process", async () => {
    if (process.platform !== "linux" && process.platform !== "win32") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    const generation = await waitForGeneration(child.pid);
    expect(signalExactProcessGeneration(child.pid, generation, "SIGKILL")).toBe(true);
    await waitForExit(child);
    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
    expect(processGenerationMatches(child.pid, generation)).toBe(false);
  });

  it("pins Windows validation and termination to one native process handle", () => {
    const source = fs.readFileSync(path.resolve("src/process/process-identity.ts"), "utf8");
    expect(source).toContain("OpenProcess");
    expect(source).toContain("GetProcessTimes");
    expect(source).toContain("TerminateProcess");
    expect(source).toContain("CloseHandle");
    expect(source).not.toContain("$p.Kill()");
  });

  it("keeps cold Windows helper startup retryable without weakening fail-closed identity checks", () => {
    const source = fs.readFileSync(path.resolve("src/process/process-identity.ts"), "utf8");
    expect(source).toContain("const WINDOWS_GENERATION_TIMEOUT_MS = 15_000");
    expect(source).toContain("const WINDOWS_NATIVE_CAPABILITY_TIMEOUT_MS = 20_000");
    expect(source).toContain("const WINDOWS_NATIVE_SIGNAL_TIMEOUT_MS = 15_000");
    expect(source).toContain("let cachedCurrentProcessGeneration: string | undefined");
    expect(source).toContain("if (pid === process.pid && generation) cachedCurrentProcessGeneration = generation");
    expect(source).not.toContain("cachedCurrentProcessGeneration = null");
    expect(source).toContain(String.raw`if (!/^win32:\d{4}-\d{2}-\d{2}T/.test(generation)) return null;`);
    expect(source).not.toContain(String.raw`if (!/^win32:\\d`);
  });

  it("passes Windows helper inputs through dedicated environment variables", () => {
    const source = fs.readFileSync(path.resolve("src/process/process-identity.ts"), "utf8");
    expect(source).toContain("$env:C2C_PROCESS_PID");
    expect(source).toContain("$env:C2C_EXPECTED_GENERATION");
    expect(source).toContain("C2C_PROCESS_PID: String(pid)");
    expect(source).toContain("C2C_EXPECTED_GENERATION: expectedGeneration");
    expect(source).not.toContain("$pidValue=[uint32]$args[0]");
    expect(source).not.toContain("$expected=$args[1]");
  });
});
