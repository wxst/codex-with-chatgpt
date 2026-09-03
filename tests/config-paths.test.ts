import { afterEach, describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import { getStateDir } from "../src/config/paths.js";

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
});
