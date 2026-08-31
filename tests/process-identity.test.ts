import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  getProcessGeneration,
  processGenerationMatches,
  requireCurrentProcessGeneration,
} from "../src/process/process-identity.js";

const children: Array<ReturnType<typeof spawn>> = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill("SIGTERM");
  }
});

describe("process generation identity", () => {
  it("returns a stable generation for the current process", () => {
    const first = requireCurrentProcessGeneration();
    const second = getProcessGeneration(process.pid);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
    expect(processGenerationMatches(process.pid, first)).toBe(true);
  });

  it("distinguishes another live process generation", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    const deadline = Date.now() + 2000;
    let generation: string | null = null;
    while (Date.now() < deadline && !generation) {
      generation = getProcessGeneration(child.pid);
      if (!generation) await new Promise((resolve) => setTimeout(resolve, 20));
    }

    expect(generation).toBeTruthy();
    expect(generation).not.toBe(requireCurrentProcessGeneration());
    expect(processGenerationMatches(child.pid, generation!)).toBe(true);
  });

  it("no longer matches after that process exits", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
    });
    children.push(child);
    if (!child.pid) throw new Error("child pid unavailable");

    const deadline = Date.now() + 2000;
    let generation: string | null = null;
    while (Date.now() < deadline && !generation) {
      generation = getProcessGeneration(child.pid);
      if (!generation) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(generation).toBeTruthy();

    child.kill("SIGTERM");
    await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    expect(processGenerationMatches(child.pid, generation!)).toBe(false);
  });
});
