# C2C Agent Protocol

Control plane: Codex App background tools `list_threads → read_thread →
send_message_to_thread`.

Data plane: the C2C Router MCP endpoint. It has eight read-only tools.

Browser automation, UIA, ChatGPT Classic, ChatGPT Work, drafts, and clipboard
flows are not protocol surfaces.

## Global Router

One Router is anchored to the existing OpenAI Secure MCP Tunnel and its existing
ChatGPT connector. `c2c router ensure -w <workspace>` registers each new local
workspace. The gateway keeps one transport runtime; requests are stateless and
resolve a new `Workspace` instance from a task capability on every call.

A route capability binds:

```text
workspaceId + taskId + conversationId → SHA-256(route_token)
```

The raw `route_token` appears only in the one task Chat Boot Prompt. It is not
saved in the session registry, Router state, logs, or task outputs. All eight
MCP tool schemas require `route_token`. An invalid, revoked, expired, or
cross-task token returns `ROUTE_ACCESS_DENIED` before workspace access.

## Standby Chat pool

The single **Codex-with-ChatGPT** Project holds manually prepared ordinary
Chats. A candidate is accepted only when `list_threads` and `read_thread` prove:

- `kind: chatgpt`;
- exact Project id;
- an exact marker in a **user** turn;
- no prior task ownership.

`C2C_STANDBY_READY` and the literal UI-escaped
`C2C\_STANDBY\_READY` mean user-confirmed non-Pro xhigh. Explicit Pro tasks use
only `C2C_STANDBY_READY_PRO` or `C2C\_STANDBY\_READY\_PRO`. A marker must be the
whole raw user-turn text; assistant echoes and extra text do not qualify. Model
names stay unknown because the host does not return verified model fields.

`session pool claim` holds the global session lock, uses FIFO `createdAt`, and
atomically saves a permanent `workspaceId + taskId → conversationId` binding.
A claimed Chat is never returned to stock. If it is deleted, it becomes retired
and the same task may claim a next generation. A temporary direct-tool failure
only sets `degraded`; it does not replace the Chat. Empty compatible stock yields
`POOL_EXHAUSTED` and blocks task content.

## Runtime configuration health

`c2c runtime diagnose` probes the anchor through exactly one source: the
CurrentUser DPAPI Runtime Key and Tunnel-ID files in
`%USERPROFILE%/.config/codex-with-chatgpt`. Its child clears inherited
control-plane variables before decrypting that source. The result exposes only
`credentialSource: managed_dpapi`, `credentialState`, health flags, and a
sanitized `401 invalid_api_key` code when relevant. `verified` means the
managed Key read the exact Tunnel, `invalid` means that same Key received 401,
and `missing` means its DPAPI source needs restoration. Header-path repair
remains a separate local-token routing concern.

On Windows, `scripts/start-managed-openai-tunnel.ps1` is the only managed
Runtime start, reconnect, watchdog, and stop path. It clears inherited
control-plane values and injects the DPAPI credential only for the scoped
`tunnel-client` child. Runtime health checks call `c2c runtime diagnose`, not a
raw `tunnel-client runtimes status` command under the Codex/user environment.

## Boot and direct delivery

Every control message has:

```text
TASK_ID
WORKSPACE_ID
ITERATION
MESSAGE_ID: c2c_msg_<uuid>
```

The new Chat's Boot Prompt additionally contains `C2C_ROUTE_TOKEN` and tells
ChatGPT to call `workspace_info` first with `route_token`. The task becomes
`ready` only after delivery and reply readback plus matching workspace id, name,
branch, connector, and all four identity fields.

`send_message_to_thread` means accepted only. The coordinator records that
acceptance, then polls `read_thread` on the exact conversation. It confirms
delivery after the matching user message appears, and confirms reply only after
the matching ChatGPT reply appears. `wait_threads` is not used for ordinary
ChatGPT conversations.

The first 30 seconds are a fast check. A missing user turn in that period is a
late delivery, not a terminal failure: the task remains `sending`, retains its
same message id and write lock, and records `deliveryPendingSince`. Active work
may continue reading for five minutes. If it is still absent, the next task
operation reads that exact in-flight message before any new send. There is no
automatic resend or Chat replacement.

`fail-delivery` requires terminal evidence: `host_rejected`,
`conversation_gone`, or `identity_mismatch`. The last two retire the exact
binding; a host rejection quarantines the channel while retaining it.

Channel states:

```text
ready → sending → awaiting_reply → ready
degraded (only an explicit recovery probe may continue)
```

No automatic resend occurs after a missed readback. No title guess, recency
selection, or cross-task substitution is allowed.

## Single writer

Only the primary coordinating Codex agent claims pool items, sends control
messages, and advances receipt state. Subagents return findings to it. A task
Chat has at most one in-flight request. Separate tasks claim separate Chats and
separate route capabilities.

## Read-source priority

- GitHub connector: committed code, Issues, PRs, history.
- mem/OpenDeepWiki: Gitea Wiki, architecture, project structure.
- C2C MCP: current local files, status, diff, tests, unpushed changes.

Current local C2C data wins on conflicts.
