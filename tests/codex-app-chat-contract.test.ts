import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

describe("Codex App direct Chat host contract", () => {
  it("uses existing thread listing, readback, and direct send tools", () => {
    const verifier = read("scripts/verify-codex-app-host.mjs");
    const skill = read("skill/SKILL.md");
    expect(verifier).toContain('"list_threads"');
    expect(verifier).toContain('"read_thread"');
    expect(verifier).toContain('"send_message_to_thread"');
    expect(verifier).not.toContain("create_chatgpt_conversation");
    expect(skill).toContain("list_threads");
    expect(skill).toContain("read_thread");
    expect(skill).toContain("send_message_to_thread");
  });
});
