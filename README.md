# Codex with ChatGPT — Hardened Fork

[简体中文](README.zh-CN.md)

> ChatGPT plans and reviews. Codex edits, runs commands, tests, and fixes.

This fork keeps the ChatGPT-web planning workflow while hardening the local
Bridge, credential lifecycle, process shutdown, dependency policy, and upstream
update path. The ChatGPT-facing MCP surface is read-only.

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
   `tunnel-client runtimes status <runtimeAlias> --json` first. A runtime is
   already configured when process_running, healthy, and ready are true and
   stale is false. Only when starting or reconnecting it, check that
   CONTROL_PLANE_TUNNEL_ID and CONTROL_PLANE_API_KEY are present in that launch
   environment without printing their values. Follow the installed client's
   current help output rather than guessing flags.
7. If this account or environment is missing OpenAI Secure MCP Tunnel access,
   stop and explain the exact blocker. Do not enable Cloudflare unless I give
   explicit approval.
8. Use only the built-in ChatGPT browser surface for ChatGPT setup. Never paste
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
path, and the runtime alias expected by the official OpenAI tunnel client. The
OpenAI control-plane credentials stay in environment variables and must never
be printed, committed, or pasted into ChatGPT.

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
