# Installation Trial Readiness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the hardened fork safe and internally consistent enough for a first Windows/Linux installation trial from `main`.

**Architecture:** Preserve the existing lifecycle-fenced Bridge design. Make transport changes transactional, make failed-start cleanup fail closed, remove temporary write-enabled automation, then align installation documentation and add an install smoke test that exercises the real package/CLI entrypoint from a clean checkout.

**Tech Stack:** TypeScript, Node.js >=20, pnpm 11.24.0, Vitest, GitHub Actions.

**Spec:** `HARDENING.md` plus the unresolved automated-review findings on PR #3.

## Global Constraints

- Default transport remains OpenAI Secure MCP Tunnel.
- Cloudflare remains explicit fallback only.
- ChatGPT-facing MCP surface remains read-only.
- No runtime self-update.
- Direct dependencies and GitHub Actions remain pinned.
- Hardened runtime support is Windows and compatible Linux only.
- Every production fix is preceded by a failing regression test.
- PR is not merged until CI, Code Review, and Security Review are clean on the latest head.

---

### Task 1: Transactional transport switching

**Files:**
- Modify: `tests/latest-review-findings.test.ts`
- Modify: `src/cli/index.ts`

**Interfaces:**
- Consumes: `readTransportMode`, `writeTransportMode`, `stopBridge`, `ensureOpenAITunnelToken`.
- Produces: transport command behavior that restores the previous persisted mode whenever lifecycle-fenced shutdown fails.

- [ ] **Step 1: Write failing regressions**

Add tests proving:

```typescript
it("restores the previous transport mode when bridge shutdown throws", async () => {
  // Seed cloudflare, request openai, force stopBridge to throw.
  // Expect command failure and persisted mode to remain cloudflare.
});

it("does not create an OpenAI tunnel token when switching from Cloudflare fails", async () => {
  // Force shutdown failure before token provisioning.
  // Expect no token file to exist.
});
```

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `pnpm vitest run tests/latest-review-findings.test.ts`

Expected: the new transport rollback tests fail against the current write-before-stop implementation.

- [ ] **Step 3: Implement the minimal transactional fix**

In the `transport` command:

```typescript
const previous = readTransportMode(workspace.id);
if (previous !== next) {
  writeTransportMode(workspace.id, next);
  try {
    await stopBridge(root);
  } catch (error) {
    writeTransportMode(workspace.id, previous);
    throw error;
  }
}
```

Provision the OpenAI token only after successful shutdown and after re-reading the committed mode.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run tests/latest-review-findings.test.ts`

Expected: PASS.

### Task 2: Fail-closed startup cleanup

**Files:**
- Modify: `tests/latest-review-findings.test.ts`
- Modify: `src/process/daemon.ts`

**Interfaces:**
- Consumes: `waitForBridgeStartup`, `stopBridge`.
- Produces: an aggregate startup/cleanup error whenever cleanup returns `false` or throws.

- [ ] **Step 1: Write failing regression**

```typescript
it("surfaces cleanup failure when failed startup leaves no confirmed stop", async () => {
  // Force startup timeout and make stopBridge resolve false.
  // Expect AggregateError mentioning incomplete workspace fencing.
});
```

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run tests/latest-review-findings.test.ts`

Expected: current code rethrows only the startup error, so the new assertion fails.

- [ ] **Step 3: Implement minimal cleanup verification**

In `waitForBridgeStartup`, treat `await stopBridge(...) === false` as cleanup failure and throw an `AggregateError` containing the startup error plus an explicit incomplete-cleanup error.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `pnpm vitest run tests/latest-review-findings.test.ts`

Expected: PASS.

### Task 3: Remove temporary write-enabled workflow

**Files:**
- Delete: `.github/workflows/update-stop-tests.yml`

- [ ] **Step 1: Delete the consumed workflow**

Remove the workflow entirely. It must not remain on the release branch.

- [ ] **Step 2: Verify workflow inventory**

Confirm `.github/workflows/` contains only persistent CI/upstream-maintenance workflows and no one-shot patch workflow.

### Task 4: Align installation documentation and Skill

**Files:**
- Modify: `README.md`
- Modify: `README.zh-CN.md`
- Modify: `skill/SKILL.md` only if required for exact command consistency.

**Interfaces:**
- Produces: one deterministic Windows/Linux installation prompt targeting `https://github.com/wxst/codex-with-chatgpt`, with no automatic pull/update and a reliable CLI invocation.

- [ ] **Step 1: Add documentation contract tests**

Add tests that require:

```typescript
expect(readme).toContain("https://github.com/wxst/codex-with-chatgpt");
expect(readme).not.toContain("XiaoDuoYa/codex-with-chatgpt");
expect(readme).not.toContain("每天自动检查");
expect(readme).not.toContain("git pull 更新");
expect(readme).toContain("corepack pnpm exec c2c");
expect(readme).toContain("Windows");
expect(readme).toContain("Linux");
expect(readme).toContain("macOS"); // only in an explicit unsupported-platform statement
```

- [ ] **Step 2: Run documentation tests and verify RED**

Run the focused test file containing the documentation contract.

- [ ] **Step 3: Rewrite installation instructions**

Requirements:

- clone `wxst/codex-with-chatgpt`;
- pin checkout to `main`;
- use `corepack pnpm install --frozen-lockfile` and `corepack pnpm build`;
- use `corepack pnpm exec c2c ...` or `node bin/c2c.js ...`, never assume a global `c2c` command;
- copy `skill/SKILL.md` without referring to a nonexistent path marker;
- default to OpenAI Secure MCP Tunnel;
- explicitly require the OpenAI tunnel runtime credentials/client, or stop with a clear blocker;
- Cloudflare only after explicit user choice;
- no runtime `git pull`, automatic update, or implicit Cloudflare setup;
- state Windows and compatible Linux support; state macOS/BSD are not supported by the hardened runtime.

- [ ] **Step 4: Run documentation tests and verify GREEN**

### Task 5: Installation smoke test

**Files:**
- Create: `scripts/install-smoke.mjs`
- Modify: `package.json`
- Modify: `.github/workflows/ci.yml`
- Test: `tests/install-readiness.test.ts`

**Interfaces:**
- Produces: `pnpm smoke:install`, verifying package build and CLI execution from a clean temporary copy without writing user credentials.

- [ ] **Step 1: Write failing contract test**

Require package script `smoke:install` and CI step `Install smoke test`.

- [ ] **Step 2: Run focused test and verify RED**

- [ ] **Step 3: Implement smoke script**

The script must:

1. create a temporary directory;
2. copy only package sources and lockfiles needed for a clean build;
3. run `corepack pnpm install --frozen-lockfile`;
4. run `corepack pnpm build`;
5. execute `node bin/c2c.js --help`;
6. execute read-only/local commands that do not create Tunnel credentials, such as `node bin/c2c.js doctor --json` where safe;
7. fail on any nonzero exit;
8. delete the temporary directory in `finally`.

- [ ] **Step 4: Run smoke test and verify GREEN**

Run: `pnpm smoke:install`

- [ ] **Step 5: Add smoke test to CI**

Run after build.

### Task 6: Full release gate

**Files:**
- Modify: PR #3 metadata/comments only.

- [ ] **Step 1: Run full verification**

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:install
```

- [ ] **Step 2: Request full Codex Code Review on the exact latest head**

Resolve every finding with tests and rerun the full gate.

- [ ] **Step 3: Request Codex Security Review on the exact latest head**

Resolve every finding with tests and rerun the full gate.

- [ ] **Step 4: Merge only after both reviews are clean**

Squash merge PR #3 into `main`.

- [ ] **Step 5: Verify `main` freshly**

Require a successful `main` CI run containing install, typecheck, tests, build, and install smoke test before declaring the version trial-ready.
