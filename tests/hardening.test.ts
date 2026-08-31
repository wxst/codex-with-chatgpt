import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
