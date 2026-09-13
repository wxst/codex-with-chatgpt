import fs from "node:fs";
import { describe, expect, it } from "vitest";

const skill = fs.readFileSync("skill/SKILL.md", "utf8").replace(/\r\n/g, "\n");
const protocol = fs.readFileSync("docs/protocol.md", "utf8").replace(/\r\n/g, "\n");
const hostControl = fs.readFileSync("docs/host-control.md", "utf8").replace(/\r\n/g, "\n");

// These are instruction contracts, not evidence of model behavior or quota savings.
describe("ChatGPT-first Skill instruction contract", () => {
  it("puts the reasoning workflow before transport setup", () => {
    expect(skill).toContain("reduce Codex quota consumption");
    const workflow = skill.indexOf("## Daily reasoning workflow");
    expect(workflow).toBeGreaterThan(0);
    expect(workflow).toBeLessThan(skill.indexOf("## Setup and Router gate"));
    expect(skill).toContain("Do not complete the same deep analysis locally before INIT");
    const daily = skill.slice(workflow, skill.indexOf("### Routing exceptions"));
    const steps = ["1. Codex checks", "2. Send INIT", "3. Wait for", "4. Codex checks", "5. Send EXECUTED", "6. Continue"];
    const positions = steps.map(step => daily.indexOf(step));
    expect(positions.every(position => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(daily).toContain("do not edit until this PLAN is received");
  });

  it("provides distinct planning and execution messages with useful evidence", () => {
    const templates = [...skill.matchAll(/```text\n(\[C2C\][\s\S]*?)\n```/g)].map(m => m[1]);
    const init = templates.find(t => /^STATE: INIT$/m.test(t));
    const executed = templates.find(t => /^STATE: EXECUTED$/m.test(t));
    expect(init).toBeDefined();
    expect(executed).toBeDefined();
    for (const template of [init!, executed!]) {
      for (const field of ["TASK_ID:", "WORKSPACE_ID:", "ITERATION:", "MESSAGE_ID:"]) {
        expect(template).toContain(field);
      }
      expect(Buffer.byteLength(template, "utf8")).toBeLessThan(1024);
    }
    expect(init).toContain("CONSTRAINTS:");
    expect(init).toContain("SUCCESS_CRITERIA:");
    expect(executed).toContain("RESULTS:");
    expect(executed).toContain("EVIDENCE:");
    expect(skill).toContain("SOURCE_EVIDENCE, ACTIONS, TESTS, and SUCCESS_CRITERIA");
    expect(skill).toContain("BOOT DONE confirms connectivity only");
  });

  it.each([
    ["unfamiliar code", "repository exploration"],
    ["debugging", "root-cause analysis"],
    ["supplied plan", "Do not force replanning"],
    ["trivial edit", "Simple deterministic operations"],
    ["review only", "Review-only requests"],
    ["unavailable channel", "not permission to silently perform all reasoning locally"],
  ])("retains the routing rule for %s", (_scenario, rule) => {
    expect(skill).toContain(rule);
  });

  it("keeps business reasoning separate from delivery and permission contracts", () => {
    expect(skill).toContain("No fixed business-iteration limit");
    expect(skill).toContain("C2C MCP remains eight read-only tools");
    expect(skill).toContain("confirm-delivery");
    expect(skill).toContain("session finish --use-id");
    expect(skill).toContain("reclaim-observations-file");
    expect(skill).toContain("__C2C_CHECKOUT__");
    expect(skill).toContain("These exceptions do not waive host preflight");
    expect(skill).toContain("only when no repository exploration, design, or diagnosis is needed");
    expect(skill).toContain("impact still needs ChatGPT analysis before execution");
  });

  it("documents the corroborated notLoaded reclaim path without treating it as idle", () => {
    for (const document of [skill, protocol, hostControl]) {
      expect(document).toContain("notLoaded");
      expect(document).toContain("inactiveStatus");
    }
    expect(skill).toContain("A bare `notLoaded` result is not idle proof");
    expect(skill).toContain("same completed latest turn id");
    expect(skill).toContain("Every individual read must be no more than 60");
    expect(hostControl).toContain("changed receipt");
  });

  it("makes fixed-pool automatic recovery a project and installed workflow rule", () => {
    const agents = fs.readFileSync("AGENTS.md", "utf8");
    expect(agents).toContain("固定复用现有 10 个 Chat");
    expect(agents).toContain("lastUsedAt");
    expect(agents).toContain("不能以“已有绑定”为由停止");
    expect(skill).toContain("--recover-bound-file");
    expect(skill).toContain("omitting `hostId`");
    expect(skill).toContain("never asks for more Chats");
    expect(protocol).toContain("no unresolved send");
  });

  it("automatically reconciles malformed BOOT without requesting user authorization", () => {
    const agents = fs.readFileSync("AGENTS.md", "utf8");
    expect(skill).toContain("C2C recovery is already authorized");
    expect(skill).toContain("do not ask for authorization or send another BOOT");
    expect(skill).toContain("Never put\nit on BOOT or pass `--review-head` with `begin-send --bootstrap`");
    expect(skill).toContain("does not require another user decision");
    expect(protocol).toContain("BOOT_REVIEW_HEAD_FORBIDDEN");
    expect(protocol).toContain("does not become `lastReviewHead`");
    expect(hostControl).toContain("Do not resend it or ask");
    expect(agents).toContain("错误 BOOT 修复");
    expect(agents).toContain("不再向用户索取单独授权");
  });
});
