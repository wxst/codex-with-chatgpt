# Hardened fork architecture

This fork keeps the upstream `codex-with-chatgpt` workflow while changing the trust boundaries and update model for long-term use.

## Branch model

- `main` — hardened branch used for normal installations.
- `upstream-main` — mirror of `XiaoDuoYa/codex-with-chatgpt:main`; never hand-edit it.
- Upstream changes are presented to `main` as a pull request and are never auto-merged.

The scheduled upstream workflow runs a test merge in a read-only GitHub Actions job. A separate write-capable job only updates the mirror branch and PR metadata; it does not execute upstream project code.

## Supported hardened runtime platforms

The hardened Bridge currently starts only where it can prove that a wedged daemon can be terminated through a generation-bound OS process handle before any OAuth or tunnel credential is loaded:

- **Linux** — supported when Python 3.9+ is available and the running kernel/container policy permits `os.pidfd_open` and `signal.pidfd_send_signal`. C2C executes both pidfd syscalls safely during startup to verify the capability. `C2C_PYTHON` can select a specific interpreter.
- **Windows** — supported using a generation-validated Windows `Process` object/handle.
- **macOS / BSD** — intentionally fail-closed for now. C2C can derive a process start identity there, but this hardened fork does not yet have an atomic generation-bound termination handle suitable for killing a wedged detached Bridge without a PID-reuse race. Startup is rejected before credentials are read or created.

This restriction is a hardening choice, not a claim that Node.js or the upstream project cannot otherwise run on macOS.

## Transport model

### Default: OpenAI Secure MCP Tunnel

The C2C bridge stays bound to loopback. The ChatGPT-facing `/mcp` route requires a random per-workspace `X-C2C-Tunnel-Token` stored in the local C2C state directory with owner-only permissions.

The official OpenAI `tunnel-client` is expected to make the outbound connection and forward that token only to the local MCP origin. Running the official tunnel client also requires the OpenAI control-plane tunnel ID/runtime API credential required by that client. This credential is separate from model inference billing and must remain in the local environment; it is not stored in the repository or pasted into ChatGPT.

C2C does not create a public Cloudflare MCP endpoint in this mode.

OpenAI mode also rejects proxy-marker headers such as `X-Forwarded-For`, `Forwarded`, `CF-Connecting-IP`, and `X-Real-IP`. This prevents accidentally putting the local MCP endpoint behind an unrelated public reverse proxy.

### Explicit fallback: Cloudflare

The upstream OAuth + Cloudflare Quick/Named Tunnel path remains available for compatibility, but a workspace must be explicitly switched to it:

```text
c2c transport -w <workspace> --mode cloudflare --json
```

Return to the hardened default with:

```text
c2c transport -w <workspace> --mode openai --json
```

The bridge refuses `/admin/tunnel/start` while OpenAI mode is active.

## Read-only MCP invariant

The ChatGPT-facing MCP surface remains limited to:

- `workspace_info`
- `list_directory`
- `read_file`
- `search_workspace`
- `git_status`
- `git_diff`
- `test_status`
- `execution_summary`

No write-file, delete-file, shell execution, package installation, or git commit tool is exposed.

## Sensitive-file policy

In addition to upstream exclusions, the hardened fork blocks common developer and infrastructure credentials, including:

- `.envrc`, `.dev.vars`, `.pypirc`
- Kubernetes and Docker credentials
- Google Cloud and GitHub CLI credentials
- Cargo credentials
- Terraform state and variable files
- VPN profiles and KeePass databases

Project-specific exclusions should still be added with `.c2cignore`. The built-in list cannot know every filename that contains a secret in a particular repository.

## Dependency policy

Direct npm dependencies and dev dependencies are pinned to the exact versions recorded in `pnpm-lock.yaml`.

GitHub Actions are pinned to exact commit SHAs rather than floating major-version tags.

Dependency upgrades are reviewed changes, not runtime behavior.

## Update policy

The Codex skill must not perform `git pull`, `pnpm install`, or `pnpm build` automatically because an update is available.

Upstream flow:

1. The scheduled workflow fetches the original upstream `main`.
2. `upstream-main` is updated to the exact upstream commit.
3. A review PR into hardened `main` is opened or refreshed.
4. A read-only validation job test-merges upstream into hardened `main` and runs install, typecheck, tests, build, and `git diff --check`.
5. A human/agent reviews the diff and resolves any hardening conflicts.
6. Only then is the PR merged manually.

## Regression requirements

Before merging hardening or upstream changes, CI must pass:

```text
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

Security regressions covered by tests include path traversal/symlink boundaries, sensitive file leakage, sensitive git-diff renames, transport state, OpenAI tunnel token handling, proxy-header rejection, read-only tool exposure, prevention of Cloudflare tunnel startup in OpenAI mode, workspace lifecycle serialization, pending-start fencing, multi-generation runtime discovery, legacy revocation behavior, and generation-bound process termination.
