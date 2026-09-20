# Codex with ChatGPT — Hardened Fork

[简体中文](README.zh-CN.md)

> ChatGPT explores, plans, diagnoses, and reviews. Codex executes and verifies.

This fork keeps ChatGPT planning inside the unified Codex App while hardening the local
Bridge, credential lifecycle, process shutdown, dependency policy, and upstream
update path. The ChatGPT-facing MCP surface is read-only.

## Daily use: delegate reasoning first

Use ChatGPT subscription capacity for repository exploration, planning, root-cause
analysis, test design, and review. Codex checks scope and connection, then follows
`ready → INIT → PLAN → execution → EXECUTED → PLAN / DONE / BLOCKED`. BOOT DONE
proves connection only. A useful PLAN cites source evidence and gives actions,
tests, and success criteria; Codex executes it and returns results without repeating
the full exploration. See the [Skill](skill/SKILL.md#daily-reasoning-workflow).

Every new business task, pool rotation, or workspace migration requires a generated
`prepare-init` request. ChatGPT first calls `memory_start_task`, uses
`memory_search` for specific missing history, then read-only `codewiki_*` and
`gitea_*` for Gitea facts when relevant. The eight read-only C2C tools are final
authority for the current workspace, diff, and execution records. READY requires
actual mem initialization; DEGRADED needs a concrete reason and does not claim
unavailable analysis occurred.

At each continuation, run `session get` first. `get` never returns a lease id.
Follow `nextAction`. If the real `CODEX_THREAD_ID` owns this task's unique
authoritative binding, `session resume --recover-own` restores the same active
lease; a missing or stale private continuation cache is rebuilt from that verified
ledger state. With no active lease, follow `nextAction` and acquire only when the
next operation requires it. A missing cache does not mean another coordinator
owns the task. If this task has no binding or evidence proves the binding unusable,
choose the oldest safe candidate from the fixed pool.

Pending messages stay with the coordinator. If read_thread is available, read and
reconcile existing pending work even when sending is unavailable; do not resend,
rotate the Chat, or let local read-only research replace required ChatGPT analysis.
Follow `coordinatorAction` and `businessGate`. The CLI does not poll in the
background. A matching but weak PLAN is confirmed as a receipt, then supplemented
with `--kind analysis`. Once binding verification is ready, a matching
`BLOCKED`/`ERROR` may confirm transport without `REVIEW_HEAD` for any business
kind, including legacy pending; INIT mem and identity checks remain. It is not
approval: an omitted head clears stale `lastReviewHead` and goes to
`assess_reply` without automatic re-PLAN or Chat rotation. A wrong nonempty head
is rejected. Other positive review replies follow the normal exact-head or
clarification rules in the Skill. For an existing pending negative reply, reread
the exact original response and confirm the same message id/iteration; missing
heads are omitted, never synthesized. This receipt repair needs no user approval,
BOOT, resend, or Chat replacement.

Simple deterministic work may run directly only when no exploration, design, or
diagnosis is needed. With a complete user plan, request only code mapping or gap
analysis; review-only stays review-only. A blocked channel preserves pending and
binding state; it is not permission to move all reasoning to Codex. Only
independent, fully specified, user-authorized work may overlap without delaying a
due read. Keyword tests do not prove actual reasoning delegation or quota savings.

## Installation-trial scope

This branch is prepared for a first controlled installation trial on:

- Windows with Node.js 20 or newer;
- compatible Linux systems with Node.js 20 or newer and Python 3.9+ providing
  `os.pidfd_open` and `signal.pidfd_send_signal`.

The Linux capability is executed and verified before the Bridge reads or creates
credentials. Unsupported environments fail closed instead of weakening the
process-safety boundary.

The hardened default is **OpenAI Secure MCP Tunnel**. Cloudflare remains an
**explicit** compatibility fallback and is never enabled automatically.

## Give this prompt to Codex

Copy the following request into Codex. It is deliberately strict: it targets
this fork, builds a pinned checkout, verifies the real CLI entrypoint, and does
not perform runtime self-updates.

```text
Install and prepare the hardened Codex with ChatGPT fork for a controlled trial.
Do the technical work yourself and interrupt me only for an account login,
CAPTCHA, two-factor authentication, or a required OpenAI Tunnel credential.

1. Verify that this machine is Windows or a compatible Linux system. Require
   git and Node.js >= 20. On Linux also require Python >= 3.9 with
   os.pidfd_open and signal.pidfd_send_signal; set C2C_PYTHON when a specific
   interpreter is needed. Stop if the hardened process-safety prerequisite
   cannot be verified.
2. Clone only https://github.com/wxst/codex-with-chatgpt at branch main into a
   dedicated local folder. If that folder already exists, verify its remote,
   branch, and working-tree state; do not run git pull or overwrite local work.
3. In the checkout run:
   corepack enable
   corepack pnpm install --frozen-lockfile
   corepack pnpm typecheck
   corepack pnpm test
   corepack pnpm build
   corepack pnpm smoke:install
4. Verify the actual checkout CLI with:
   node bin/c2c.js --version
   node bin/c2c.js --help
   Never assume a globally installed c2c command.
5. Copy skill/SKILL.md to the Codex skills directory as
   codex-with-chatgpt/SKILL.md. In the installed copy only, replace every
   __C2C_CHECKOUT__ placeholder with the absolute checkout path. Do not modify
   the repository copy for a machine-specific path.
6. For the target workspace run the installed Skill's first-time checks using
   node bin/c2c.js. Keep transport mode openai. Verify the official OpenAI
   tunnel client, read `runtimeAlias` from setup, and run
   `node bin/c2c.js runtime diagnose -w <workspace> --json` first. C2C probes
   the runtime only through the canonical CurrentUser DPAPI Key and Tunnel-ID
   files under `.config/codex-with-chatgpt`; inherited user and parent-process
   Keys stay outside that call path. A runtime is healthy when process_running,
   healthy, and ready are true and stale is false. Follow the installed
   client's current help output rather than guessing flags.
7. If this account or environment is missing OpenAI Secure MCP Tunnel access,
   stop and explain the exact blocker. Do not enable Cloudflare unless I give
   explicit approval.
8. Before first use, prepare ordinary standby Chats in the **Codex-with-ChatGPT**
   Project: choose non-Pro xhigh and send one user message containing exactly
   `C2C_STANDBY_READY`. Later tasks claim their exact Chat in the background. Never paste
   repository files, diffs, secrets, tokens, cookies, or long logs into ChatGPT;
   ChatGPT must read workspace context through the read-only MCP tools.
9. Do not run git pull, dependency upgrades, automatic updater commands, or
   upstream synchronization during installation or normal use.
10. Finish with an evidence checklist showing the exact checkout commit,
    dependency install, typecheck, tests, build, install smoke test, CLI version,
    selected transport, Bridge status, and MCP file-read verification.
```

## Manual checkout and verification

```bash
git clone --branch main --single-branch https://github.com/wxst/codex-with-chatgpt
cd codex-with-chatgpt
corepack enable
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:install
node bin/c2c.js --version
node bin/c2c.js --help
```

Do not treat the checkout as a global package. All documented commands use the
repository entrypoint:

```bash
node bin/c2c.js <command>
```

## Install the Codex Skill

Copy `skill/SKILL.md` into:

```text
~/.codex/skills/codex-with-chatgpt/SKILL.md
```

In the installed copy, replace `__C2C_CHECKOUT__` with the absolute path to this
checkout. Keep the repository template unchanged so it remains portable and
reviewable.

## First-time workspace setup

From the C2C checkout, substitute the real target workspace path:

```bash
node bin/c2c.js sandbox-allow --json
node bin/c2c.js transport -w <workspace> --mode openai --json
node bin/c2c.js setup -w <workspace> --json
```

The setup result provides the loopback MCP URL, the owner-only local token-file
path, and the managed runtime alias. C2C Runtime reads its sole control-plane
credential from the CurrentUser DPAPI files under
`%USERPROFILE%/.config/codex-with-chatgpt`; it bypasses inherited user and
parent-process Keys. The Key is never printed, committed, or pasted into
ChatGPT.

If the official Tunnel connection is unavailable, the safe result is a clear
blocker. Cloudflare may be selected only after explicit approval:

```bash
node bin/c2c.js transport -w <workspace> --mode cloudflare --json
```

Return to the hardened default with:

```bash
node bin/c2c.js transport -w <workspace> --mode openai --json
```

Transport changes are lifecycle-fenced. A failed transition restores the
previous persisted mode and does not provision credentials for the uncommitted
mode.

## Global Router and standby Chats

Run `node bin/c2c.js router migrate -w <anchor-workspace> --json` once when
upgrading an existing connection. Later projects use `router ensure`; they share
the original OpenAI Secure MCP Tunnel and ChatGPT connector.
Then run `node bin/c2c.js session migrate --json`; it backs up legacy records
under the global lock and writes the unified ownership ledger.
For an old `unavailable` record from the former repeated-read-miss rule, first
verify the exact Chat through background `read_thread`, then use `session
restore --confirm` to retain that original conversation.

Each task has one current Chat binding from the fixed ten-Chat pool. Reuse a healthy
binding automatically. Only a task with no binding or fresh evidence that its Chat
is terminally unusable may rotate. Inspect candidates by oldest `lastUsedAt` and
take the first proven-safe Chat; a missing continuation cache is not failure proof.
Do not ask for additional standby Chats. Standby markers come from exact user
turns, and an old owner by itself is not a busy state. Pool assignment and safe
rotation are locked and retain ownership history.

Before every pool claim, run the binding check. For a candidate owner in `notLoaded`
state, require same-host immediate inactive snapshots before and after exact Chat
readback, the same completed latest turn, a clean matching receipt, and fresh
timestamps for every read. A bare `notLoaded` is not proof of inactivity.
Pending, uncertain, leased, active, or unreadable Chats are never reclaimed.
Report every actual candidate reason before saying the pool is blocked.

Claim and workspace migration only establish the binding. After host preflight,
`session prepare-boot --expected-generation <n>` creates or resumes one private
BOOT transaction. Its ordinary JSON contains no token or body. The private
messageFile is a JSON object; read it only in memory, validate its identity and
digest, and send only its `body` property to the exact bound Chat. Windows files
permit only the current user and SYSTEM; Unix uses `0700`/`0600`. Repeated calls
preserve the same preparation and message identity. Pending or uncertain sends
are read back, never resent. The eight MCP calls require `route_token` resolved
only to the bound workspace.

If host readback omits a reply already visible on the web, shared guidance returns
`read_exact_chat_in_browser`. Codex reads only the exact `chatUrl`, records browser
provenance, and uses normal `confirm-reply --observed-reply-file` validation.
No browser sending or private Chat API is allowed. A pending source-workspace
receipt is reconciled with `--bound-workspace` before ordinary same-Chat migration;
it is never discarded merely because the host transcript is incomplete.

When both `CODEX_THREAD_ID` and `--task-id` are supplied, they must be identical;
`TASK_ID_IDENTITY_MISMATCH` occurs before a ledger write when they differ. The
Boot reply also reports `routeTaskId`, `workspaceName`, and `git.branch`
observed from `workspace_info`; the connector label is not a tool result or an
identity proof. Receipt fields alone leave verification pending.

Run `node bin/c2c.js runtime diagnose -w <workspace> --json` before changing a
managed runtime. The Runtime Key source is always the canonical CurrentUser
DPAPI file `%USERPROFILE%/.config/codex-with-chatgpt/tunnel-runtime-key.dpapi`.
The child probe clears inherited control-plane Key values, reads that DPAPI Key,
and performs a read of the exact Tunnel. `credentialSource: managed_dpapi` with
`credentialState: verified` confirms it. `credentialState: invalid` means that
same managed Key received `401 invalid_api_key` and needs a confirmed rotation;
`missing` means the managed DPAPI files need restoration. Header-path repairs
remain separate from Runtime Key health.

On Windows, `scripts/start-managed-openai-tunnel.ps1` is the managed start,
reconnect, watchdog, and stop path. It gives `tunnel-client` only a freshly
decrypted DPAPI Key in a short-lived child and uses `c2c runtime diagnose` for
each status check. Do not invoke raw Runtime status or stop commands from an
inherited Codex/user environment.
## Normal use

After the Skill is installed and the workspace connection is verified, ask
Codex:

```text
Use Codex with ChatGPT to implement <task>.
```

Codex owns all execution. ChatGPT plans and reviews through these eight
read-only MCP tools:

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`

There is no ChatGPT-facing file-write, delete, shell, package-install, or git
commit tool.

## Security and maintenance model

- The Bridge binds to loopback in OpenAI mode and requires a random
  per-workspace local tunnel token.
- Sensitive paths and common credential files are blocked; add project-specific
  exclusions with `.c2cignore`.
- `unpair`, `stop`, restart, failed-start cleanup, and transport switching share
  lifecycle fencing and track every pending/runtime generation.
- Dependencies and GitHub Actions are pinned.
- Runtime self-update is disabled.
- `main` is the runnable hardened branch.
- `upstream-main` mirrors the original upstream snapshot.
- Upstream changes arrive as review PRs, run in a read-only validation job, and
  are never auto-merged.

See [HARDENING.md](HARDENING.md), [security](docs/security.md), and
[troubleshooting](docs/troubleshooting.md).

## Developer verification

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
corepack pnpm smoke:install
```

## Status

Hardened installation-trial candidate. The project is an unofficial community
fork and is not affiliated with or endorsed by OpenAI.

## License

[MIT](LICENSE)
