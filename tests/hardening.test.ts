import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Logger, redact } from "../src/logger/index.js";
import { Workspace } from "../src/workspace/manager.js";

const roots: string[] = [];

function workspace(): Workspace {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-hardening-"));
  roots.push(root);
  return new Workspace(root);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("hardened sensitive-file policy", () => {
  it("redacts a tunnel token even outside a structured token field", () => {
    const secret = `c2c_tunnel_${"A".repeat(43)}`;
    const output = redact(`leaked ${secret}`);

    expect(output).toBe("leaked [REDACTED]");
    expect(output).not.toContain(secret);
  });

  it("redacts a tunnel token from message and structured file-log fields", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "c2c-hardened-log-"));
    roots.push(root);
    const logFile = path.join(root, "audit.log");
    const first = `c2c_tunnel_${"A".repeat(43)}`;
    const second = `c2c_tunnel_${"B".repeat(43)}`;
    const logger = new Logger({ name: "hardening-test", file: logFile });

    logger.warn(`rejected ${first}`, { supplied: second });
    const output = fs.readFileSync(logFile, "utf8");

    expect(output).not.toContain(first);
    expect(output).not.toContain(second);
    expect(output.match(/\[REDACTED\]/g)).toHaveLength(2);
  });

  it.each([
    ".envrc",
    ".dev.vars",
    ".pypirc",
    ".kube/config",
    ".docker/config.json",
    ".config/gcloud/application_default_credentials.json",
    ".config/gh/hosts.yml",
    ".cargo/credentials.toml",
    "terraform.tfstate",
    "terraform.tfstate.backup",
    "production.tfvars",
    "client.ovpn",
    "vault.kdbx",
  ])("denies %s", (secretPath) => {
    const ws = workspace();
    expect(() => ws.resolve(secretPath)).toThrow(/ACCESS_DENIED_SENSITIVE_FILE/);
  });

  it("still allows documented placeholder files", () => {
    const ws = workspace();
    expect(ws.resolve(".env.example").rel).toBe(".env.example");
  });
});
