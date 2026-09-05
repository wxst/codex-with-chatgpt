import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getStateDir, writeSecureJson } from "../src/config/paths.js";

const originalStateDir = process.env.C2C_STATE_DIR;

afterEach(() => {
  if (originalStateDir === undefined) delete process.env.C2C_STATE_DIR;
  else process.env.C2C_STATE_DIR = originalStateDir;
});

describe("state directory resolution", () => {
  it("uses a non-virtualized home directory for packaged Windows callers", () => {
    if (process.platform !== "win32") return;
    delete process.env.C2C_STATE_DIR;

    expect(getStateDir()).toBe(
      path.join(os.homedir(), ".config", "codex-with-chatgpt", "c2c-state")
    );
  });

  it("keeps an explicit state directory override", () => {
    const override = path.join(os.tmpdir(), "c2c-explicit-state");
    process.env.C2C_STATE_DIR = override;

    expect(getStateDir()).toBe(path.resolve(override));
  });

  it("pins production callers to the canonical state root despite an inherited override", () => {
    const override = path.join(os.tmpdir(), "c2c-inherited-state");
    const moduleUrl = pathToFileURL(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "config", "paths.ts")).href;
    const environment = { ...process.env, C2C_STATE_DIR: override, NODE_ENV: "production" };
    delete environment.VITEST;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx/esm", "--input-type=module", "--eval", `import { getStateDir } from ${JSON.stringify(moduleUrl)}; process.stdout.write(getStateDir());`],
      { encoding: "utf8", env: environment }
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toBe(path.resolve(override));
    if (process.platform === "win32") {
      expect(result.stdout).toBe(path.join(os.homedir(), ".config", "codex-with-chatgpt", "c2c-state"));
    }
  });

  it("keeps the prior JSON document intact when atomic replacement fails", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-atomic-json-"));
    const file = path.join(directory, "state.json");
    fs.writeFileSync(file, '{"stable":true}');
    const originalRename = fs.renameSync;
    fs.renameSync = (() => {
      const error = new Error("simulated storage fault") as NodeJS.ErrnoException;
      error.code = "EIO";
      throw error;
    }) as typeof fs.renameSync;
    try {
      expect(() => writeSecureJson(file, { replacement: true })).toThrow(/simulated storage fault/);
      expect(fs.readFileSync(file, "utf8")).toBe('{"stable":true}');
    } finally {
      fs.renameSync = originalRename;
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
