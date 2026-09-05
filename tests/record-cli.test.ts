import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import * as recordModule from "../src/execution/records.js";
import {
  appendExecutionRecord,
  latestExecutionRecord,
  readExecutionRecords,
  type ExecutionRecord,
} from "../src/execution/records.js";
import { Workspace } from "../src/workspace/manager.js";
import { cleanup, makeTmpDir } from "./helpers.js";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = path.join(projectRoot, "src", "cli", "index.ts");

type RecordSchema = {
  safeParse(value: unknown): { success: boolean };
};

function runRecord(root: string, stateDir: string, args: string[]) {
  return spawnSync(
    process.execPath,
    ["--import", "tsx", cliEntry, "record", "--workspace", root, "--task", "c2c_test", ...args],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        C2C_STATE_DIR: stateDir,
        NODE_ENV: "test",
        VITEST: "true",
      },
    }
  );
}

function withRecordEnvironment(run: (root: string, stateDir: string, workspace: Workspace) => void): void {
  const root = makeTmpDir("record-cli-workspace");
  const stateDir = makeTmpDir("record-cli-state");
  const previousStateDir = process.env.C2C_STATE_DIR;
  const previousNodeEnv = process.env.NODE_ENV;
  const previousVitest = process.env.VITEST;
  process.env.C2C_STATE_DIR = stateDir;
  process.env.NODE_ENV = "test";
  process.env.VITEST = "true";

  try {
    run(root, stateDir, new Workspace(root));
  } finally {
    if (previousStateDir === undefined) delete process.env.C2C_STATE_DIR;
    else process.env.C2C_STATE_DIR = previousStateDir;
    if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previousNodeEnv;
    if (previousVitest === undefined) delete process.env.VITEST;
    else process.env.VITEST = previousVitest;
    cleanup(root);
    cleanup(stateDir);
  }
}

function recordFile(stateDir: string, workspace: Workspace): string {
  return path.join(stateDir, "executions", `${workspace.id}.jsonl`);
}

function makeRecord(iteration: number): ExecutionRecord {
  return {
    taskId: `c2c_test_${iteration}`,
    iteration,
    changedFiles: ["src/index.ts"],
    tests: "27 passed",
    exitStatus: "ok",
    timestamp: new Date().toISOString(),
  };
}

describe("c2c record", () => {
  it("records a safe non-negative iteration and numeric changed-file count", () => {
    withRecordEnvironment((root, stateDir, workspace) => {
      const result = runRecord(root, stateDir, ["--iteration", "2", "--changed-files", "3"]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)).toEqual([
        expect.objectContaining({ taskId: "c2c_test", iteration: 2, changedFiles: 3 }),
      ]);
    });
  });

  it("preserves comma-separated changed-file lists", () => {
    withRecordEnvironment((root, _stateDir, workspace) => {
      const result = runRecord(root, _stateDir, [
        "--iteration",
        "1",
        "--changed-files",
        "src/a.ts, src/b.ts",
      ]);

      expect(result.status).toBe(0);
      expect(readExecutionRecords(workspace.id)[0]?.changedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    });
  });

  it.each([
    ["non-integer", "1.5", /must be an integer/i],
    ["negative", "-1", /must be a non-negative integer/i],
    ["unsafe", "9007199254740992", /must be a safe integer/i],
  ])("rejects a %s iteration before creating execution state", (_kind, value, message) => {
    withRecordEnvironment((root, stateDir, workspace) => {
      const result = runRecord(root, stateDir, [`--iteration=${value}`]);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(message);
      expect(fs.existsSync(recordFile(stateDir, workspace))).toBe(false);
      expect(fs.existsSync(path.dirname(recordFile(stateDir, workspace)))).toBe(false);
    });
  });

  it.each([
    ["negative", "-1", /changed-files count must be a non-negative safe integer/i],
    ["unsafe", "9".repeat(400), /must be a safe integer/i],
  ])("rejects a %s numeric changed-file count before recording", (_kind, value, message) => {
    withRecordEnvironment((root, stateDir, workspace) => {
      const result = runRecord(root, stateDir, ["--iteration", "1", `--changed-files=${value}`]);

      expect(result.status).toBe(1);
      expect(`${result.stdout}\n${result.stderr}`).toMatch(message);
      expect(fs.existsSync(recordFile(stateDir, workspace))).toBe(false);
      expect(fs.existsSync(path.dirname(recordFile(stateDir, workspace)))).toBe(false);
    });
  });
});

describe("execution record persistence", () => {
  it("exports a schema that rejects unsafe persisted numeric values", () => {
    const exported = recordModule as unknown as {
      executionRecordSchema?: RecordSchema;
    };
    const schema = exported.executionRecordSchema;
    const valid = makeRecord(1);

    expect(schema).toBeDefined();
    expect(schema?.safeParse(valid).success).toBe(true);
    expect(schema?.safeParse({ ...valid, iteration: -1 }).success).toBe(false);
    expect(schema?.safeParse({ ...valid, changedFiles: Number.POSITIVE_INFINITY }).success).toBe(false);
    for (const value of [Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
      expect(schema?.safeParse({ ...valid, iteration: value }).success).toBe(false);
      expect(schema?.safeParse({ ...valid, changedFiles: value }).success).toBe(false);
    }
  });

  it("rejects invalid records before creating the executions directory", () => {
    withRecordEnvironment((_root, stateDir, workspace) => {
      const executionsDir = path.dirname(recordFile(stateDir, workspace));
      for (const value of [Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.MAX_VALUE]) {
        expect(() => appendExecutionRecord(workspace.id, { ...makeRecord(1), iteration: value })).toThrow();
        expect(() => appendExecutionRecord(workspace.id, { ...makeRecord(1), changedFiles: value })).toThrow();
      }
      expect(fs.existsSync(executionsDir)).toBe(false);
    });
  });

  it("counts valid records from the end past corrupt history without rewriting it", () => {
    withRecordEnvironment((_root, stateDir, workspace) => {
      appendExecutionRecord(workspace.id, makeRecord(1));
      appendExecutionRecord(workspace.id, makeRecord(2));
      appendExecutionRecord(workspace.id, makeRecord(3));
      const file = recordFile(stateDir, workspace);
      fs.appendFileSync(file, "not-json\nnull\n[]\n{\"iteration\":null}\n");
      fs.appendFileSync(file, JSON.stringify({ ...makeRecord(1), iteration: Number.MAX_SAFE_INTEGER + 1 }) + "\n");
      fs.appendFileSync(file, JSON.stringify({ ...makeRecord(1), changedFiles: Number.MAX_VALUE }) + "\n");
      const before = fs.readFileSync(file, "utf8");

      expect(readExecutionRecords(workspace.id, 2).map((record) => record.iteration)).toEqual([2, 3]);
      expect(latestExecutionRecord(workspace.id)?.iteration).toBe(3);
      expect(fs.readFileSync(file, "utf8")).toBe(before);
    });
  });
});
