import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "..");

function readSource(relativePath: string): string {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8");
}

function expectHiddenProcessOption(relativePath: string, callText: string): void {
  const source = readSource(relativePath);
  const start = source.indexOf(callText);
  expect(start, `${relativePath} is missing ${callText}`).toBeGreaterThanOrEqual(0);
  const end = source.indexOf("});", start);
  expect(end, `${relativePath} has an unterminated child-process call`).toBeGreaterThan(start);
  expect(source.slice(start, end + 3), `${relativePath} must hide this child process`).toContain(
    "windowsHide: true"
  );
}

describe("Windows background process contract", () => {
  it("hides every production console child process", () => {
    const calls: Array<[string, string]> = [
      ["bin/c2c.js", "spawnSync(process.execPath"],
      ["src/cli/index.ts", 'spawnSync("git", args'],
      ["src/process/daemon.ts", "child = spawn(entry.cmd"],
      ["src/tunnel/detect.ts", "spawnSync(exe"],
      ["src/tunnel/cloudflared.ts", "const child = spawn("],
      ["src/tunnel/cloudflared-named.ts", "const child = spawn("],
      ["src/tunnel/named-provision.ts", "const child = spawn(bin"],
      ["src/tunnel/named-provision.ts", "const result = spawnSync(this.binary()"],
      ["src/workspace/git.ts", 'spawnSync("git", args'],
      ["src/workspace/search.ts", "spawnSync(candidate"],
      ["src/workspace/search.ts", "const child = spawn(rgBin"],
    ];

    for (const [relativePath, callText] of calls) {
      expectHiddenProcessOption(relativePath, callText);
    }
  });

  it("keeps the Router path free of UI launchers while shipping the hidden task supervisor launcher", () => {
    const launcher = path.join(repoRoot, "scripts/run-hidden-command.vbs");
    expect(fs.existsSync(launcher)).toBe(true);
    expect(readSource("scripts/run-hidden-command.vbs")).toContain("shell.Run command, 0, True");
    expect(fs.existsSync(path.join(repoRoot, "scripts/show-chat-bootstrap-dialog.ps1"))).toBe(false);
  });
});
