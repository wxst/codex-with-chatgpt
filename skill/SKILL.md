---
name: codex-with-chatgpt
description: >
  Use when a coding task should offload repository exploration, analysis, planning, debugging, and review to ChatGPT while Codex edits, tests, and uses Git.
---

# Codex with ChatGPT — Global Router + Standby Pool

Installed checkout: `__C2C_CHECKOUT__`

Codex executes. ChatGPT explores, plans, diagnoses, and reviews. ChatGPT reads
source through the read-only C2C MCP tools; control messages carry only short
state and identity fields.

## Always use this routing model

- One global Router uses the existing OpenAI Secure MCP Tunnel and existing
  ChatGPT connector.
- Every local workspace is registered automatically when its task starts.
- Every Codex task owns exactly one ordinary ChatGPT conversation from the global
  **Codex-with-ChatGPT** standby pool. Never select a Chat by title, recency, or
  another task's binding.
- Only the main coordinating agent calls `session pool claim`, sends ChatGPT
  control messages, and confirms receipts. Subagents return findings only to the
  coordinator.
- A claimed Chat stays with its task through normal work, completion, and
  `degraded` status. Mark it retired only after the exact conversation is gone
  or its identity is proven wrong.
- ChatGPT Work, browser control, UIA, ChatGPT Classic, drafts, and clipboard
  workflows are outside this Skill.

## Standby pool contract

Users prepare standby ordinary Chats in the single **Codex-with-ChatGPT**
ChatGPT Project before use:

1. Select the strongest available **non-Pro** model and set thinking to
   **xhigh / 极高**.
2. Send one user message containing exactly `C2C_STANDBY_READY`. ChatGPT can
   preserve it as the literal `C2C\_STANDBY\_READY`; both complete spellings
   mean the same non-Pro inventory marker.
3. For a task whose current user request explicitly asks for Pro, use a separate
   Chat with exactly `C2C_STANDBY_READY_PRO`.

The marker must be a user turn in that exact Project. The pool stores
`user_confirmed` xhigh/non-Pro metadata, not invented backend model data.

## Setup and Router gate

Use the installed checkout directly:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" router ensure -w <workspace> --json
node "__C2C_CHECKOUT__/bin/c2c.js" transport -w <workspace> --json
node "__C2C_CHECKOUT__/bin/c2c.js" status -w <workspace> --json
```

On the first upgrade from the old per-workspace Bridge, run once against the
current connected workspace:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" router migrate -w <anchor-workspace> --json
```

`router ensure` registers a new workspace without creating a new connector or
Tunnel. The Router anchor retains the current Tunnel alias, port, credentials,
and connector.

## Tunnel runtime health

Before reconnecting an existing Router anchor, inspect it with
`tunnel-client runtimes status <runtimeAlias> --json`. Treat
`process_running, healthy, ready, and stale` together. Missing control-plane variables in the current Codex process are not a failure when that managed runtime is already healthy. When a start or reconnect is required, place
`CONTROL_PLANE_TUNNEL_ID` and `CONTROL_PLANE_API_KEY` only in that runtime
launch environment; never print them.

Use the C2C diagnosis before changing a runtime profile:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" runtime diagnose -w <workspace> --json
```

Interpret the result exactly:

- `POOL_EXHAUSTED`: standby inventory is empty; synchronize it before a claim.
- `processRunning: false`, `healthy: false`, or `ready: false`: the managed
  Tunnel is stopped; restart its existing runtime launcher and recheck.
- `credentialState: invalid_runtime_api_key`: the official Runtime API key is
  invalid; obtain an explicit user confirmation immediately before creating or
  rotating it in the official runtime settings. Keep the new value only in the
  local runtime launcher secret store.
- `header.state: legacy_path` with `header.source: profile`: run
  `runtime repair-profile` for that same workspace, then reconnect the original
  alias. It atomically updates only the stale token-file path.
- `header.state: legacy_path` with `header.source: environment`: the stale path
  belongs to the current app process. Run `runtime repair-user-environment` to
  atomically update the future Windows user-environment launch value, then
  restart Codex. Do not copy a token into a profile; the managed launcher still
  obtains the canonical path from `c2c setup` when it starts the runtime.

Neither diagnostic nor normal control traffic uses browser, UIA, ChatGPT
Classic, or ChatGPT Work.

## Acquire the task Chat

Resolve the task id in this order: `CODEX_THREAD_ID`, explicit `--task-id`, then
one generated `c2c_task_<uuid>` retained for the current task.

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session get -w <workspace> --task-id <task-id> --json
```

If the task has a bound Chat, keep that exact id. If it is absent or explicitly
retired, synchronize inventory before every pool claim. Use Codex App
background tools only:

1. Call `list_threads`.
2. Keep only `kind: "chatgpt"` entries in the configured
   **Codex-with-ChatGPT** Project.
3. Call `read_thread` for each possible entry. Import only a unique **user**
   turn whose complete raw text is one of `C2C_STANDBY_READY`,
   `C2C\_STANDBY\_READY`, `C2C_STANDBY_READY_PRO`, or
   `C2C\_STANDBY\_READY\_PRO`. Do not import a marker in an assistant reply,
   another Project, a turn with extra text, or an already claimed conversation.
4. For every verified unowned Chat, run `pool import` with the exact raw text
   returned by `read_thread`, then claim one Chat:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session pool import \
  --conversation-id <id> --project-id <project-id> \
  --marker-message-id <user-message-id> \
  --marker-text <raw-user-marker-text> --json
node "__C2C_CHECKOUT__/bin/c2c.js" session pool claim \
  -w <workspace> --task-id <task-id> --json
```

For an explicitly Pro task, pass `--pro` to `pool claim` only. The user marker
selects the inventory class. Never pass `--pro` from an inferred preference.
`pool claim` is globally locked,
uses FIFO order, permanently binds `workspaceId + taskId`, and returns a raw
`routeToken` once. The token is shown only in this result and must be placed in
the task Chat's Boot Prompt; do not save, log, or paste it elsewhere.

`POOL_EXHAUSTED` means stop before task content. Ask the user to prepare more
standby Chats. A removed exact Chat is retired and the same task claims the next
compatible standby Chat; a temporary tool timeout only makes the channel
`degraded` and keeps the original binding.

## Boot Prompt and Router capability

For a newly claimed Chat, generate a receipt id and reserve the outbound Boot
Prompt:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session new-message-id --json
node "__C2C_CHECKOUT__/bin/c2c.js" session begin-send \
  -w <workspace> --task-id <task-id> --message-id <message-id> \
  --iteration 0 --bootstrap --json
```

Send this compact message with `send_message_to_thread` to the exact claimed
conversation id:

```text
[C2C]
STATE: BOOT
TASK_ID: <task-id>
WORKSPACE_ID: <workspace-id>
ITERATION: 0
MESSAGE_ID: <message-id>
C2C_ROUTE_TOKEN: <route-token>
CONNECTOR: <connector-name>

Use only the C2C MCP connector. Every MCP call must include
route_token: <route-token>. First call workspace_info. Echo all four identity
fields and reply STATE: DONE.
```

The Router resolves the capability to exactly one fresh workspace instance.
Every one of the eight C2C read-only tools requires `route_token`; a missing,
wrong, revoked, or cross-task token returns `ROUTE_ACCESS_DENIED`. The token
never grants write, shell, Git mutation, or access to another workspace.

Immediately after `send_message_to_thread` accepts the request, record that
fact. A returned conversation id does not prove that ChatGPT has displayed the
message:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session confirm-send-accepted \
  -w <workspace> --task-id <task-id> --message-id <message-id> --json
```

Poll `read_thread` on the same id. Do not use `wait_threads` for ChatGPT Chats.
Confirm delivery only after the exact user message is visible:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session confirm-delivery \
  -w <workspace> --task-id <task-id> --message-id <message-id> \
  --observed-task-id <task-id> --observed-workspace-id <workspace-id> \
  --observed-iteration 0 --json
```

Use short polling for 30 seconds. If the original message has not appeared,
Keep the task in `sending` and record the late-delivery wait:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session record-delivery-pending \
  -w <workspace> --task-id <task-id> --message-id <message-id> --json
```

Continue reading for up to five minutes while the task is active. After that,
leave the same message in flight and read it again before any later task
message. Do not resend, change Chats, or call `fail-delivery` because a short
readback window is empty. `fail-delivery` is only for an explicit
`host_rejected`, `conversation_gone`, or `identity_mismatch` result.

Then wait for the matching ChatGPT reply and run `session confirm-reply` with
the same observed identity fields. After `workspace_info` reports the expected
workspace id, name, branch, and connector, run `session confirm-workspace`.
Only a `ready` task may receive task content.

## Normal control loop

Every message includes `TASK_ID`, `WORKSPACE_ID`, `ITERATION`, and a fresh
`MESSAGE_ID`. Always generate it with `session new-message-id`; never write a
handmade `c2c_msg_*` value. Call `session begin-send`, then
`send_message_to_thread`, then `confirm-send-accepted`, then poll `read_thread`
and use `confirm-delivery` / `confirm-reply`.

A send-tool result means only accepted. It is delivered only after the original
user turn is read back. It is complete only after an identity-matching reply is
read back. A late readback keeps the same message in `sending`; it does not
advance the iteration or create a second send. A later recovery after an
explicit terminal host result uses a fresh message id and `begin-send --probe`.

Keep control messages under 1 KB. ChatGPT must retrieve code itself.

```text
[C2C]
STATE: INIT | EXECUTED
TASK_ID: <task-id>
WORKSPACE_ID: <workspace-id>
ITERATION: <n>
MESSAGE_ID: <message-id>

GOAL: <one short task statement>
REPOSITORY: <github|gitea|other> <owner/repo> <branch>
LOCAL_STATE: <clean|local changes|unpushed commits>

Use C2C MCP for current local code, status, diff, and test records. Echo the
four identity fields. Reply with STATE: PLAN, DONE, BLOCKED, or ERROR.
```

## ChatGPT read-source order

- **GitHub:** GitHub connector for committed code, history, PRs, and issues;
  C2C MCP for local files, diff, tests, and unpushed work.
- **Gitea:** mem / OpenDeepWiki for Wiki, architecture, repository structure,
  and durable project context; C2C MCP for current local source and changes.
- **Other repositories:** C2C MCP.

The current C2C workspace is final authority. Connector content and Wiki data
can be stale.

## Safety invariants

1. C2C MCP remains eight read-only tools. Never add write, shell, package,
   Git-mutation, delete, or secret-reading tools.
2. Never paste repository files, diffs, long logs, credentials, cookies,
   Tunnel tokens, or route tokens outside the exact Boot Prompt.
3. Only one in-flight request exists per task Chat. Parallel subagents do not
   write to it. ChatGPT reviews only after their results are merged into a
   stable workspace checkpoint.
4. Use a second standby Chat only when the exact bound id is deleted or has a
   proven identity mismatch. Do not replace a healthy or degraded Chat.
5. Do not auto-switch transport. OpenAI Secure MCP Tunnel is the default;
   Cloudflare remains an explicit user-chosen fallback.
