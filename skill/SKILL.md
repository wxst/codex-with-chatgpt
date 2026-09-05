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
node "__C2C_CHECKOUT__/bin/c2c.js" session migrate --json
```

`router ensure` registers a new workspace without creating a new connector or
Tunnel. The Router anchor retains the current Tunnel alias, port, credentials,
and connector.

## Tunnel runtime health

Use the C2C diagnosis before inspecting or reconnecting a Router anchor:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" runtime diagnose -w <workspace> --json
```

Runtime checks use only the canonical CurrentUser DPAPI files:

```text
%USERPROFILE%\.config\codex-with-chatgpt\tunnel-runtime-key.dpapi
%USERPROFILE%\.config\codex-with-chatgpt\tunnel-runtime-id.dpapi
```

The probe clears inherited `CONTROL_PLANE_API_KEY` and
`CONTROL_PLANE_TUNNEL_ID`, then decrypts those files inside its short-lived
PowerShell child. User-environment and Codex-parent Keys stay outside the C2C
Runtime call path.

On Windows, the bundled `scripts/start-managed-openai-tunnel.ps1` owns managed
Runtime start, reconnect, watchdog, and stop. It clears inherited control-plane
variables, injects the DPAPI Key only into its short-lived `tunnel-client`
child, and asks `c2c runtime diagnose` for every status check. Do not run raw
`tunnel-client runtimes status` or `stop` from the Codex parent environment.

Interpret the result exactly:

- `POOL_EXHAUSTED`: standby inventory is empty; synchronize it before a claim.
- `processRunning: false`, `healthy: false`, or `ready: false`: the managed
  Tunnel is stopped; restart its existing runtime launcher and recheck.
- `credentialSource: managed_dpapi` and `credentialState: verified`: the
  managed Key successfully read the exact Tunnel.
- `credentialState: invalid`: the managed DPAPI Key received
  `401 invalid_api_key`; obtain explicit user confirmation immediately before
  rotating it in official runtime settings.
- `credentialState: missing`: the managed DPAPI files need restoration before
  a Runtime reconnect.
- `runtime repair-profile` and `runtime repair-user-environment` repair only
  C2C local token-file paths. They never select or replace the managed Runtime
  Key.

Neither diagnostic nor normal control traffic uses browser, UIA, ChatGPT
Classic, or ChatGPT Work.

## Acquire the task Chat

Resolve the task id in this order: `CODEX_THREAD_ID`, explicit `--task-id`, then
one generated `c2c_task_<uuid>` retained for the current task.

When both `CODEX_THREAD_ID` and `--task-id` are present, they must match
exactly. A mismatch returns `TASK_ID_IDENTITY_MISMATCH` before any registry or
pool operation; it never silently substitutes one task identity for another.

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session get -w <workspace> --task-id <task-id> --json
```

If the task has a bound Chat, keep that exact id. If it is absent or explicitly
retired, synchronize inventory before every pool claim. Use Codex App
background tools only:

For a migrated legacy record marked `unavailable`, first call `read_thread` on
its exact retired conversation id. If the Chat still exists and its readback
matches the task and workspace ids, restore that exact owner before considering
stock:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session restore \
  -w <workspace> --task-id <task-id> --conversation-id <old-conversation-id> \
  --observed-task-id <task-id> --observed-workspace-id <workspace-id> \
  --confirm --json
```

Run the recovery probe and `workspace_info` verification after restoration. A
direct host deletion result proceeds to the usual replacement claim.

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

## Host control preflight and recovery

Before every `begin-send`, and again after a task continuation, inspect the
coordinator's actual callable tool inventory. Resolve deferred tools if the
host provides discovery. Require both `read_thread` and
`send_message_to_thread`; `list_threads` is additionally needed for pool
inventory, not for an existing binding. A proxy tools/list result or Tunnel
health does not prove those tools are exposed to the current coordinator.

Record the exact available names (strip only their verified host namespace):

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session host-control \
  -w <workspace> --task-id <task-id> --result probe \
  --tools read_thread,send_message_to_thread --json
```

Use `--tools none` when both are absent, or the single available name. This
records `tools_missing`, missing names and `channelState: degraded`, preserving
the task/workspace/conversation/generation, pool ownership and any in-flight
receipt. Stop before reserving or sending. The dependency belongs to the Codex
host; C2C cannot inject tools into a running task. Report the Codex version,
task id, timestamp and missing tool names through Codex feedback/support. Check
the host's tool configuration and re-open/resume the same task when available.
Do not rotate credentials, restart a Tunnel, change transport, or claim another
Chat just because control tools are absent.

When both return, the result is `readback_required`, not ready. Call
`read_thread` on the saved conversation id and verify its task/workspace
identity. For a newly claimed Chat before BOOT, verify its exact user standby
marker and the ledger owner instead (no task identity has been sent yet).
Then record those verified ids:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session host-control \
  -w <workspace> --task-id <task-id> --result read-ok \
  --conversation-id <bound-id> --observed-task-id <task-id> \
  --observed-workspace-id <workspace-id> --json
```

The CLI requires this fresh preflight within 60 seconds before `begin-send`.
If a pending message exists, first search the original user turn and matching
reply, including older pages. Confirm only the existing message-id/iteration.
An empty/truncated read is not proof of non-delivery; do not resend.

Record a host call timeout with `host-control --result timeout` or another
temporary call error with `--result call-failed` (same workspace/task options).
Both preserve in-flight messages, including sends whose outcome is unknown.
Re-probe and read the same Chat before continuing. An explicit missing Chat or
identity mismatch uses the existing terminal retirement/quarantine contract;
these are different from tool absence. Tunnel errors use `runtime diagnose`.

If tools disappear after reservation and the send tool was **never called**,
release only that reservation with `host-control --result not-invoked
--message-id <reserved-id> --confirm-not-invoked` and the same workspace/task
options. Never use this for a timeout or uncertain invocation. No accepted,
delivered, iteration advance, or reply is recorded. Recovery uses a new id.

For review requests pass `begin-send --review-head <full SHA>`, include
`REVIEW_HEAD: <full SHA>` in the user turn and require the reply to echo it.
Pass `confirm-reply --observed-review-head <echoed SHA>`; the ledger rejects
missing or mismatching HEAD values. Confirm `DONE` only when that SHA and all four
receipt identity fields match the current request. An older HEAD's DONE is
historical evidence only. Automated fixtures and a real host read/send/readback
review must be reported separately.

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
fields, then echo `WORKSPACE_NAME`, `BRANCH`, and `CONNECTOR` from that tool
result before replying STATE: DONE. A reply missing any of those observed
workspace fields does not promote the task to `ready`.
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

Poll the exact Chat every 5 seconds for the first 60 seconds. If the original
message has not appeared, keep the task in `sending` and record the
late-delivery wait:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session record-delivery-pending \
  -w <workspace> --task-id <task-id> --message-id <message-id> --json
```

Continue reading for up to five minutes while the task is active. After that,
leave the same message in flight and read it again before any later task
message. Keep the same Chat after temporary `missing`, timeout, or delayed
readback results; record each as `degraded` and continue exact readback. Do not
resend, change Chats, or call `fail-delivery` because a short readback window
is empty. `fail-delivery` is only for an explicit
`host_rejected`, `conversation_gone`, or `identity_mismatch` result. An
identity mismatch quarantines the exact Chat; use `session clear --confirm`
only after an operator decides to retire it and claim a next generation.

Then wait for the matching ChatGPT reply and run `session confirm-reply` with
the same observed identity fields. After `workspace_info` reports the expected
workspace id, name, branch, and connector, run `session confirm-workspace`.
Only a `ready` task may receive task content.

## Normal control loop

Every message includes `TASK_ID`, `WORKSPACE_ID`, `ITERATION`, and a fresh
`MESSAGE_ID`. Always generate it with `session new-message-id`; never write a
handmade `c2c_msg_*` value. Complete host preflight above, call `session begin-send`, then
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
4. Use a second standby Chat only after the exact bound id is deleted, or after
   an operator confirms retirement of an identity-mismatched Chat. Do not
   replace a healthy or degraded Chat.
5. Do not auto-switch transport. OpenAI Secure MCP Tunnel is the default;
   Cloudflare remains an explicit user-chosen fallback.
