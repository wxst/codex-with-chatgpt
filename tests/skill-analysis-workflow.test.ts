import fs from "node:fs";
import { describe, expect, it } from "vitest";
const read = (p: string) => fs.readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const skill = read("skill/SKILL.md"), protocol = read("docs/protocol.md"), host = read("docs/host-control.md"), agents = read("AGENTS.md");
const recoveryMatrix = read("docs/lease-recovery-matrix.md");
// Instruction checks supplement real CLI/state tests; they do not prove model behavior.
describe("unified ChatGPT-first Skill contract", () => {
  it("puts reasoning before recovery and keeps execution separate", () => {
    const start = skill.indexOf("## Daily reasoning workflow");
    expect(start).toBeGreaterThan(0);
    expect(start).toBeLessThan(skill.indexOf("## Shared recovery decision"));
    for (const text of ["Do not complete the same deep analysis locally before INIT", "ready → INIT → PLAN → execution → EXECUTED", "SOURCE_EVIDENCE, ACTIONS, TESTS, and SUCCESS_CRITERIA", "no fixed iteration limit"]) expect(skill).toContain(text);
  });
  it.each([
    ["unfamiliar code", "repository exploration"],
    ["complete user plan", "Do not force replanning"],
    ["deterministic change", "Simple deterministic work"],
    ["review only", "Review-only stays review-only"],
    ["own continuation", "resume --recover-own"],
    ["unavailable channel", "does not permit all reasoning to silently move to Codex"],
  ])("retains instruction routing for %s", (_scenario, rule) => expect(skill).toContain(rule));
  it("recovers this host task's lease from the authoritative binding", () => {
    for (const document of [skill, protocol, host]) for (const field of ["leaseStatus", "recoverable_own", "ownership_unproven", "conflict", "nextAction"]) expect(document).toContain(field);
    for (const document of [skill, protocol]) for (const field of ["coordinatorAction", "businessGate"]) expect(document).toContain(field);
    for (const document of [skill, protocol, host]) {
      const normalized = document.replace(/\s+/g, " ");
      expect(normalized).toContain("CODEX_THREAD_ID");
      expect(normalized).toMatch(/unique (?:authoritative )?(?:ledger\/pool )?owner|unique authoritative (?:task|binding)/);
      expect(normalized).toMatch(/cache[^.]*rebuild|rebuild[^.]*cache/i);
    }
    expect(agents).toContain("唯一权威绑定 owner");
    expect(agents).toContain("可重建缓存");
    for (const text of ["Never retrieve activeUse.useId from the ledger", "Read-only local, mem, and Gitea research is still reasoning", "without acquiring a lease for pending readback or host preflight"]) expect(skill).toContain(text);
    for (const document of [skill, protocol, host, agents, read("README.md"), read("README.zh-CN.md")]) {
      expect(document).not.toContain("active ledger lease has no matching private proof");
      expect(document).not.toContain("requires the matching private proof");
    }
    expect(skill).toContain("When it returns prepare_boot_required, use session resume --recover-own to acquire this task's lease");
    expect(skill).not.toContain("Use --recover-own only when");
  });
  it("documents terminal conversation-limit recovery without weakening pending protection", () => {
    for (const document of [skill, protocol, host]) {
      for (const field of ["conversation_limit_reached", "terminalText", "chatReadAt", "observedAt", "sourceUrl", "60 seconds"]) expect(document).toContain(field);
      expect(document).toContain("no pending");
    }
    expect(skill).toContain("Do not first send a message that is expected to fail");
    expect(host).toContain("Do not intentionally send a message to provoke rejection");
  });
  it("keeps exact source receipts and read-only browser fallback", () => {
    for (const document of [skill, protocol]) for (const field of ["read_exact_chat_in_browser", "--bound-workspace", "--observed-reply-file"]) expect(document).toContain(field);
    for (const text of ["Browser is read-only", "source=browser", "omit host turn fields", "Never resend, rotate Chat, or default to local full analysis"]) expect(skill).toContain(text);
  });
  it("keeps per-task mem initialization and read-only source authority", () => {
    for (const document of [skill, protocol, agents, read("README.md"), read("README.zh-CN.md")]) for (const field of ["memory_start_task", "memory_search", "prepare-init"]) expect(document).toContain(field);
    for (const field of ["memoryProject", "includeProjectContext=true", "MEMORY_PROJECT", "MEMORY_STATUS", "MEMORY_SOURCES", "MEMORY_REASON", "DEGRADED", "memory_write_summary", "codewiki_*", "gitea_*"]) expect(skill).toContain(field);
    expect(skill).toContain("Older Chat context never counts as current-generation mem initialization");
    expect(skill).toContain("C2C wins on conflict");
  });
  it("provides a bounded EXECUTED template distinct from generated INIT", () => {
    const templates = [...skill.matchAll(/\$\w+Body = @"\n(\[C2C\][\s\S]*?)\n"@/g)].map(m => m[1]);
    const executed = templates.find(t => /^STATE: EXECUTED$/m.test(t));
    expect(executed).toBeDefined();
    for (const field of ["TASK_ID:", "WORKSPACE_ID:", "ITERATION:", "MESSAGE_ID:", "RESULTS:", "EVIDENCE:"]) expect(executed).toContain(field);
    expect(Buffer.byteLength(executed!, "utf8")).toBeLessThan(1024);
    for (const text of ["Do not handwrite INIT", "--memory-status $memoryStatus", "BOOT DONE verifies connection only"]) expect(skill).toContain(text);
  });
  it("retains fixed-pool eligibility and never forces a takeover", () => {
    expect(agents).toContain("固定复用现有 10 个 Chat");
    expect(skill).toContain("If this task has no binding, or evidence confirms its exact binding is unusable");
    for (const field of ["lastUsedAt", "--reclaim-observations-file", "notLoaded", "inactiveStatus", "recheckReadAt", "receiptMessageId", "assignmentEpoch"]) expect(skill).toContain(field);
    for (const text of ["Never age out a long-lived lease", "Every individual read is within 60 seconds", "no rollout found", "Never clear another task's pending state or lease"]) expect(skill).toContain(text);
  });
  it("retains authorized internal recovery and message-kind HEAD rules", () => {
    expect(skill).toContain("authorizes recovery of C2C state for this task");
    expect(skill).toMatch(/\| BOOT request\/reply \| Forbidden\./);
    expect(skill).toContain("Positive/continuing reply to review-bearing EXECUTED | Must match the requested head.");
    expect(protocol).toContain("BOOT_REVIEW_HEAD_FORBIDDEN");
    expect(host).toContain("legacy malformed BOOT");
    for (const document of [skill, protocol, host]) expect(document).toContain("review_head_clarification_required");
    expect(skill).toContain("A wrong nonempty HEAD is always an identity mismatch");
    expect(skill).toContain("Positive/continuing reply to review-bearing EXECUTED");
  });
  it("separates negative transport receipts from review approval", () => {
    const docs = [skill, agents, protocol, host, read("README.md"), read("README.zh-CN.md")];
    for (const document of docs) {
      expect(document).toMatch(/BLOCKED[\s\S]{0,120}(?:ERROR|ERROR[\s\S]{0,120}BLOCKED)/i);
      expect(document).toContain("assess_reply");
      expect(document).toContain("lastReviewHead");
    }
    expect(skill).toContain("binding `verificationState=ready`");
    for (const phrase of ["including legacy pending messages", "If the head is omitted, clear prior `lastReviewHead`", "Do not request a head clarification", "automatically re-PLAN", "same Chat remains reusable"]) expect(skill).toContain(phrase);
    expect(skill).toContain("A wrong nonempty HEAD is always an identity mismatch");
    expect(skill).toContain("INIT mem fields remain required");
    expect(protocol).toContain("even if `REVIEW_HEAD` is omitted");
    expect(protocol).toContain("`nextAction=resume_bound_chat`");
    expect(protocol).toContain("`businessGate=assess_reply`");
    expect(protocol).toContain("after ordinary lease/preflight requirements");
    expect(host).toContain("without REVIEW_HEAD for every kind, including legacy pending");
    expect(host).toContain("verificationState=ready");
  });
  it("uses private repeatable BOOT material and workspace confirmation", () => {
    for (const field of ["messageFile", "bodySha256", "sendAllowed", "not-invoked", "0700", "0600", "migration_workspace_confirmation_required", "workspace_info", "confirm-workspace"]) expect(skill).toContain(field);
    expect(skill).toContain("Repeated prepare-boot resumes the same preparation");
    expect(skill).toContain("Do not reread the source receipt");
    expect(skill).not.toContain("--observed-iteration 0");
    expect(skill).not.toMatch(/(?:claim|switch-workspace) returns? (?:a |the )?(?:route )?token/i);
    expect(skill).toContain("only the unchanged body string");
  });
  it("starts migration preflight unleased and acquires a fresh destination lease before BOOT", () => {
    const section = skill.split("## Workspace migration handshake")[1].split("## ")[0];
    expect(section).toContain("clear `$ownUseId`");
    expect(section).toContain("acquire fresh destination lease after migration preflight");
    for (const line of section.split("\n").filter(l => l.trimStart().startsWith("node ") && l.includes("session host-control"))) {
      expect(line).not.toContain("--use-id");
    }
    expect(section).toContain("--use-id <new-destination-use-id>");
  });
  it("labels acceptance-matrix real evidence as historical for this implementation", () => {
    expect(recoveryMatrix).toContain("本轮按用户要求不做真实 Chat 往返验收");
    expect(recoveryMatrix).toContain("不是本轮验收");
  });
});
