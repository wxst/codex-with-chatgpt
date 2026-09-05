import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const read = (file: string): string => fs.readFileSync(path.join(root, file), "utf8");

describe("delayed direct ChatGPT delivery protocol", () => {
  it("records host acceptance and a late readback without degrading the task", () => {
    const cli = read("src/cli/index.ts");
    const skill = read("skill/SKILL.md");
    const protocol = read("docs/protocol.md");

    expect(cli).toContain('session.command("confirm-send-accepted")');
    expect(cli).toContain('session.command("record-delivery-pending")');
    expect(cli).toContain('.requiredOption("--kind <kind>"');
    expect(skill).toContain("confirm-send-accepted");
    expect(skill).toContain("record-delivery-pending");
    expect(skill).toContain("every 5 seconds for the first 60 seconds");
    expect(skill).toContain("keep the task in `sending`");
    expect(skill).toContain("WORKSPACE_NAME");
    expect(skill).toContain("BRANCH");
    expect(skill).toContain("CONNECTOR");
    expect(skill).not.toContain("If delivery is absent after the polling window, use");
    expect(protocol).toContain("late delivery");
    expect(protocol).toContain("first 60 seconds");
    expect(protocol).toContain("sending → awaiting_reply → ready");
  });
});
