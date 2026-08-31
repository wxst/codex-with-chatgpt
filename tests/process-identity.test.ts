import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import {
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
  const deadline = Date.now() + 2000;
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
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("child did not exit")), 3000)),
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

  it("validates the declared Linux pidfd helper runtime", () => {
    if (process.platform !== "linux") return;
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
    if (process.platform !== "linux") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    await waitForGeneration(child.pid);
    expect(signalExactProcessGeneration(child.pid, "linux:wrong-generation", "SIGKILL")).toBe(false);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  it("uses a generation-bound handle to signal the exact Linux process", async () => {
    if (process.platform !== "linux") return;
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    const generation = await waitForGeneration(child.pid);
    expect(signalExactProcessGeneration(child.pid, generation, "SIGKILL")).toBe(true);
    await waitForExit(child);
    expect(processGenerationMatches(child.pid, generation)).toBe(false);
  });
});
