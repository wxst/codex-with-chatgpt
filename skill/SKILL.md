---
name: codex-with-chatgpt
description: >
  Use for coding tasks needing repository exploration, planning, root-cause analysis, test design, or review: delegate primary reasoning to ChatGPT to save Codex quota while Codex executes.
---

# Codex with ChatGPT — Global Router + Standby Pool

Installed checkout: `__C2C_CHECKOUT__`

Codex executes. ChatGPT explores, plans, diagnoses, and reviews. ChatGPT reads
source through the read-only C2C MCP tools; control messages carry only short
state and identity fields.

## Daily reasoning workflow

Use ChatGPT subscription capacity to reduce Codex quota consumption. ChatGPT is
the primary reasoning partner throughout the task, including repository exploration,
design alternatives, root-cause analysis, test design, and review. Codex owns edits,
commands, tests, Git, necessary judgment, and verification. Do not complete the same deep analysis locally before INIT
and then use ChatGPT only as a second reviewer.

1. Codex checks the user goal, scope, repository state, applicable instructions,
   and connection readiness. Follow the operational sections below to resume or
   acquire the exact task Chat, resolve pending receipts, and reach `ready`.
   BOOT DONE confirms connectivity only; it does not complete the business task.
2. Send the generated mem-initialized INIT before substantive exploration or
   implementation. Use `session prepare-init`; it is the only business INIT
   entrypoint and its output is sent verbatim. Do not handwrite an INIT, paste
   files, or precompute the entire answer.
3. Wait for a matching substantive PLAN containing
   SOURCE_EVIDENCE, ACTIONS, TESTS, and SUCCESS_CRITERIA. Evidence identifies the
   relevant files/symbols and observations; actions explain what to do and why.
   Identity echoes, generic advice, and an unexamined DONE are not a usable plan.
   For non-exempt tasks, do not edit until this PLAN is received; BLOCKED or ERROR
   does not authorize implementation. Apply only the routing exceptions below.
   After confirming a completed reply, request missing analysis in a fresh message.
4. Codex checks scope, feasibility, and risk, then executes the plan using its
   own tools. Make necessary targeted checks rather than repeating all exploration.
   Do not blindly execute a proposal that conflicts with user constraints or evidence.
5. Send EXECUTED with concise results, failures, and evidence locations. ChatGPT
   reads current changes and returns the next PLAN, evidence-backed DONE, or
   BLOCKED with the missing prerequisite. Return complex failures for diagnosis;
   straightforward mechanical corrections remain with Codex.
6. Continue until the requested outcome is verified or a real blocker remains.
   No fixed business-iteration limit applies. DONE still requires Codex to check
   the agreed success criteria. Complete exact receipts and release the task's
   coordinator lease with `session finish --use-id <id>` when one exists.

The business sequence is `ready → INIT → PLAN → execution → EXECUTED → PLAN / DONE / BLOCKED`.
The generated INIT records a per-generation mem receipt in the ledger; it does
not add C2C MCP tools or permissions. Use the delivery procedure under Normal
control loop for every send, including follow-up analysis. Review requests retain
the exact REVIEW_HEAD contract below.

### Pending follow-through is the coordinator's active job

A pending receipt is unfinished work, not a passive status to mention before
switching to local analysis. At the start of every turn/continuation, run
`session get --brief --json --use-id <own-lease>` (omit use-id when none is held).
Keep the same lease in continuation context. `session resume --use-id <own-lease>`
is idempotent even while pending; a stale/wrong lease never grants access.
Never retrieve another coordinator's lease to bypass this check.

Use this loop until the exact receipt is reconciled or a concrete observation
blocker is diagnosed. No background worker reads Chat on the coordinator's behalf:

1. Follow `nextAction` for workspace/ownership/tool prerequisites first.
2. For pending, execute `coordinatorAction`: `read_now` reads the exact Chat;
   `wait_then_read` waits only until `readbackDueAt` (at most 60 seconds per wait);
   `confirm_receipt` uses the actual matching message with normal confirmation
   commands, never the visibility hint alone. Start from the latest page each time.
   `read_exact_chat_in_browser` performs the read-only fallback below immediately.
3. Record every actual read with `record-readback`, then obtain fresh guidance.
   A progress update, another local tool call, idle Chat, or completed host turn
   does not discharge this responsibility. Due reads take priority over optional work.
4. `diagnose_readback` means check host/runtime health and exact-request pagination,
   retaining the evidence. If the Chat is generating or readable progress exists,
   continue the same request. If a diagnostic establishes that the host cannot
   provide the needed result, record `result: observation_blocked`,
   `errorCategory: unavailable`, and a concrete, sanitized `blockedReason` (1–500
   characters, no credentials or body). Explain the failed read/health/pagination
   checks and recovery needed; idle/elapsed time alone is not this evidence.
5. `restore_observation` preserves pending. Perform available safe tool/routing
   recovery; if none can resolve it, report a resumable observation blocker, not
   message failure or completed delegation. A later continuation rechecks the
   same request: old observations expire for scheduling, never for ownership.

### Host transcript omissions: exact Chat browser readback

`read_thread` can return a completed user-only turn even when the matching
assistant DONE/PLAN already exists on the Chat web page. Repeated host-only
polls cannot resolve this observation defect. When guidance returns
`read_exact_chat_in_browser`, use the supported browser tool to navigate only
the `chatUrl` returned by `session get --brief --json`. Verify the final HTTPS
ChatGPT URL, project and conversation before reading the visible DOM. Do this
automatically; it is authorized internal receipt recovery, not a new task.

Browser access here is **read-only observation**. Do not send, edit, regenerate,
delete, change models, inspect network traffic, call private Chat APIs, or read
unrelated Chats. Do not substitute browser visibility for a receipt check.
Read the exact request and its assistant response, including four identity
fields, STATE, any REVIEW_HEAD and INIT memory fields. An old or quoted reply,
user message, title, preview or generic DONE is not the current assistant receipt.

Record a fresh observation with the normal task/workspace/Chat/generation/epoch/
message/iteration/useId fields and `source: "browser"`, `sourceUrl: "<actual URL>"`,
`result: "reply_visible"` (or the actual absent/error result), and `readAt`.
Browser observations must omit `hostTurnId` and `hostTurnStatus`; DOM evidence
is not host telemetry. Save the exact assistant body as UTF-8 and pass
`confirm-reply --observed-reply-file <file>` along with the usual actual identity,
STATE, REVIEW_HEAD and memory flags. The CLI validates the body and stores only
its SHA-256 and observer provenance. If delivery is not yet confirmed, first use
normal `confirm-delivery`; generated INIT still requires its exact user body
with `--observed-message-file`. Never reconstruct or normalize that INIT body.
MEMORY_SOURCES must be comma-separated exact tool names with no empty or duplicate
entries; pass the same set to --memory-sources. READY omits MEMORY_REASON;
DEGRADED includes its exact reason. Never rewrite an observed assistant body to
make a malformed memory declaration pass validation.

If `resolution=workspace_switch_required` has pending, guidance returns
`reconcile_source_pending`, not an impossible migration instruction. Use the
current task identity from the current checkout with `--bound-workspace` on
`record-readback`, `confirm-delivery`, and `confirm-reply`; observed workspace
identity remains the **source** workspace. This resolves the unique existing
owner and does not require the old directory to exist. `host-control` can use
the same flag to restore source observation tools. After confirmation, release
only your own source lease with `finish --bound-workspace --use-id <own-id>`;
then follow the existing `switch-workspace → migration BOOT → workspace_info`
flow. The flag does not permit new business sends into the old workspace.

If browser access is unavailable, record `source: "browser"`,
`result: "observation_blocked"`, `errorCategory: "unavailable"` and the concrete
`blockedReason`; omit `sourceUrl` when no page could actually be observed. Never
invent a URL observation or host turn. If the exact page has no matching reply,
record the actual result and continue observing the same pending request.
Neither absence nor elapsed time authorizes clearing, superseding, resending,
changing generation, or replacing the Chat. Receipt recovery is complete only
after normal confirmation, not after opening the page.

| businessGate | Required work before dependent business can continue |
| --- | --- |
| await_boot | Complete BOOT receipts and actual workspace_info confirmation |
| await_plan | Confirm INIT/ANALYSIS reply, then assess substantive analysis |
| await_review | Confirm EXECUTED reply before dependent changes or acceptance |
| await_reply | Reconcile legacy request; do not guess its business authority |
| connection_required | Resolve the reported connection/ownership prerequisite |
| assess_reply | Assess scope, evidence and user authorization; ready is not business DONE |

All receipt commands (`confirm-send-accepted`, `record-delivery-pending`,
`confirm-delivery`, `confirm-reply`, `confirm-workspace`, `fail-delivery`) require the held `--use-id`,
as do host-control and reservations. Omit it only when there is no lease.
No pending exception authorizes finish, another send, Chat replacement or promotion
of local/Gitea investigation into ChatGPT analysis. General planning/TDD/worktree
skills must preserve this loop; they cannot turn a pending status into a fallback.
After an initial BOOT DONE, `workspace_confirmation_required` keeps `await_boot`
until actual workspace_info and confirm-workspace complete. Migration retains its
separate `migration_workspace_confirmation_required` action. Neither stage resends BOOT.

### Routing exceptions and unavailable channels

- Simple deterministic operations, such as a trivial mechanical typo edit, may
  run directly only when no repository exploration, design, or diagnosis is needed.
  Mechanical steps alone do not qualify: a cross-file rename with unresolved
  impact still needs ChatGPT analysis before execution.
- With a complete user-supplied plan, ask ChatGPT only for necessary code mapping
  and gap analysis. Do not force replanning or expand the approved scope. Work
  already fully specified by the user need not wait for redundant planning, but
  an already-sent request still requires the pending loop above. Only independent,
  bounded execution may overlap; dependent analysis/review cannot be bypassed.
- Review-only requests stay review-only. A user prohibition on external sharing
  takes precedence; do not send prohibited task content.
- An unavailable channel is not permission to silently perform all reasoning locally.
  Report the offload blocker and preserve the binding and pending receipts. Continue
  only independently authorized, fully specified work that does not depend on the
  missing reply and does not postpone due reads. “Read-only local/memory/Gitea
  investigation” is still reasoning, not a blanket exception. If substantial reasoning
  must move back to Codex, obtain the user's direction. Do not claim ChatGPT analysis
  or acceptance without an observed substantive reply.

These exceptions do not waive host preflight, receipt readback, binding ownership,
or the exact REVIEW_HEAD requirement whenever a ChatGPT message is sent.

After confirming a weak PLAN, request missing analysis with
`begin-send --kind analysis --message-id <new-id> --iteration <next> --use-id <own-lease>`
and normal preflight/delivery/reply checks. Send `STATE: ANALYSIS`, the four exact
identity fields, and `REQUEST: supply the missing code evidence/actions/tests/success
criteria`. This reuses current-generation mem; it does not pretend execution occurred.
Use `--kind executed` only for actual execution results. Neither kind reuses an old
generation's mem initialization; new business tasks still start with prepare-init.

### C2C recovery is already authorized

Invoking this Skill, or asking Codex to complete work that uses it, authorizes the
coordinator to maintain C2C's own binding, receipt, lease, migration-handshake and
fixed-pool state through the commands in this Skill. Do not stop to ask the user
for separate permission to reconcile a malformed BOOT receipt, finish an exact
pending readback, release this task's lease, quarantine or retire a terminally
unusable binding, claim the next safe LRU Chat, or complete the replacement BOOT.
These internal routing operations are required to deliver the already authorized
task. Continue automatically until the channel is ready or every pool candidate
has a concrete safety blocker.

This standing authorization does not cover repository publication, deployment,
service restart, credential changes, destructive cleanup, or another task's
lease/pending state. Preserve uncertain sends: automatic recovery reconciles the
exact existing request and reply and never treats a timeout or empty read as
permission to resend or clear it.

## Always use this routing model

- One global Router uses the existing OpenAI Secure MCP Tunnel and existing
  ChatGPT connector.
- Every local workspace is registered automatically when its task starts.
- Every Codex task owns exactly one ordinary ChatGPT conversation from the global
  **Codex-with-ChatGPT** fixed ten-Chat pool. Reuse a healthy binding; otherwise
  automatically inspect candidates in LRU order and use the first safe one.
  Prior ownership is not an exclusion by itself. Never select by title or bypass
  the atomic reclaim contract. Never ask the user to add standby Chats or create
  a new Codex task merely to make acceptance possible.
- Only the main coordinating agent calls `session pool claim`, sends ChatGPT
  control messages, and confirms receipts. Subagents return findings only to the
  coordinator.
- A bound Chat stays with its task while it has a pending receipt, uncertain
  dispatch, active coordinator lease, or degraded channel. An idle, verified
  Chat can later be safely reclaimed only through the fixed-pool contract below.
- ChatGPT Work, UIA, ChatGPT Classic, drafts, clipboard sending and browser
  control messages are outside this Skill. The exact-Chat read-only browser
  observer above is the sole browser exception.

## Workspace migration BOOT handshake

After `session switch-workspace`, keep the same Chat. Its latest receipt still
belongs to the source workspace; never present the destination workspace as an
observed identity before BOOT. Ordinary `read-ok` correctly rejects that mismatch.
Use the migration-only preflight below, including for an existing degraded legacy
migration. The coordinator performs the evidence collection; do not ask the user
to supply another Chat or edit the ledger.

1. Resolve the current task using its real host identity and inspect the binding,
   migration history, generation and pool assignmentEpoch. Probe callable tools.
2. Read the exact Chat by conversation ID alone (omit hostId). Verify it is idle,
   its latest request and completed reply have matching source task/workspace,
   iteration/message/state/review HEAD, and no newer request or unfinished reply.
3. Write UTF-8 JSON with the actual observations. `chatReadAt` is the actual read
   time, within 60 seconds; do not refresh it without rereading. The source receipt
   may be older. Include `useId` only when holding this task's own lease; omit
   `reviewHead` if the registered receipt has no REVIEW_HEAD. Plain HEAD is not
   REVIEW_HEAD.

```json
{
  "taskId": "<current-task-id>",
  "conversationId": "<exact-chat-id>",
  "fromWorkspaceId": "<observed-source-workspace-id>",
  "toWorkspaceId": "<current-workspace-id>",
  "generation": 3,
  "assignmentEpoch": 3,
  "iteration": 20,
  "messageId": "<observed-completed-message-id>",
  "state": "PLAN",
  "chatReadAt": "<actual-UTC-ISO-read-time>",
  "chatStatus": "idle",
  "readbackClean": true
}
```

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session host-control -w <workspace> --result probe --tools read_thread,send_message_to_thread --json
node "__C2C_CHECKOUT__/bin/c2c.js" session host-control -w <workspace> --result migration-read-ok --observation-file <evidence.json> --json
node "__C2C_CHECKOUT__/bin/c2c.js" session prepare-boot -w <workspace> --expected-generation <current-generation> --json
```

Numbers above illustrate the schema, not expected values. Read actual values;
include `--use-id` on `prepare-boot` when holding a lease. `migration_boot_ready`
authorizes only a private BOOT preparation. `prepare-boot` creates or resumes the
same capability, body, message ID and iteration and returns a private `messageFile`,
never a route token or BOOT body. Read that file only into the exact
`send_message_to_thread` call; do not print, log, copy, or handwrite its contents.
Before sending, require `sendAllowed: true`. A later invocation that finds the same
reservation returns `reconcile_boot_receipt`, not resend permission. Send once,
then read back the same Chat and confirm delivery and the identity-matching reply,
then `confirm-workspace` using actual workspace_info fields. Only then start
business INIT. The old receipt cannot satisfy the new BOOT confirmation. After
acceptance or timeout, read the existing pending request directly and use its
normal receipt commands; do not resend or clear an uncertain send. If an older
client incorrectly reserved this BOOT with
`REVIEW_HEAD`, do not ask for authorization or send another BOOT: after exact
delivery and reply identity match, `confirm-reply` automatically discards that
BOOT-only head when the reply omits it. A different non-empty head remains an
identity mismatch, and `confirm-workspace` still requires the actual MCP identity.
A proven not-invoked send requires fresh probe and migration evidence before
re-preparing the **same** BOOT; an accepted, delivered, reply-waiting or terminal
uncertain send can never use this path. If preparation was interrupted before a
send, rerun `prepare-boot`; it resumes the persisted transaction. After workspace
confirmation it clears private material while retaining a token-free audit record.

`session get` and `session resume` report
`migration_workspace_confirmation_required` when the destination BOOT is already
delivered with a matching `DONE` and no request remains in flight. Immediately call
the target C2C MCP `workspace_info`, then run `confirm-workspace` with its actual
workspace ID, route task ID, name, and branch. Do not reread the source receipt,
reopen preflight, send another BOOT, or continue business work as though ChatGPT
delegation had completed. The absence of `REVIEW_HEAD` on the registered source
receipt remains valid and does not alter this step.

Binding resolution has priority over migration substate: from an old or any other
workspace without pending, `session get` and `session resume` say `switch_workspace`
before giving a migration action. A unique source binding with pending first uses
`reconcile_source_pending` and the receipt-only `--bound-workspace` path above.
Host-tool recovery also comes first: when either exact
Chat read or send is unavailable, `restore_host_tools_then_read_bound_chat` comes
before source readback or target `workspace_info`; do not label that condition as
ordinary migration preflight.

`MIGRATION_OBSERVATION_EXPIRED` requires a fresh exact Chat read.
`MIGRATION_RECEIPT_MISMATCH` or `MIGRATION_CANDIDATE_CHANGED` requires inspecting
current binding and messages; never substitute expected observations.
`MIGRATION_HISTORY_UNPROVEN` means the ledger cannot uniquely prove lineage;
preserve it and report the missing link. `MIGRATION_SEND_UNRESOLVED` requires
finishing existing readback. Legacy history can recover an immediate source
without changing Chat or generation; longer chains require explicit destinations.

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

- `workspaceRegistration` is `registered`, `unregistered`, `revoked`, or
  `legacy`. With a global Router, `anchorWorkspaceId` and the default
  `runtimeAlias` always identify that Router's anchor, even when this workspace
  is not registered. `workspace_not_registered` or `workspace_revoked` is a
  workspace access condition, not proof of a stopped runtime or bad credential.
  `ok: false` can therefore coexist with a healthy anchor. Diagnostics never
  register a workspace; use `router ensure` only for the task's actual working
  directory when registration is intended. Never move another task's Chat
  binding just because it belongs to an older worktree.
- An explicit `--runtime-alias` sets `runtimeAliasSource: explicit`; its runtime
  result describes that alias, not necessarily the Router anchor. Runtime
  repair commands refuse unregistered and revoked workspaces before writing.
- `runtime diagnose` sets top-level `ok` only when registration permits use and
  the selected runtime is available, running, healthy, ready and not stale.
  `router_state_invalid` or `router_state_unavailable` stops diagnostics and
  repair; an unreadable, corrupt or conflicting Router registry is never
  treated as the absence of a Router.
- `POOL_EXHAUSTED`: no compatible Chat exists. `POOL_OBSERVATION_REQUIRED`
  means local rotation candidates exist: follow the mandatory rotation flow
  below. `POOL_BUSY` means local candidates are blocked; inspect exclusion reasons.
- A runtime lookup error does not prove that the Tunnel is stopped. Inspect
  `runtime.errorClass` first. Restart the existing launcher only when runtime
  status actually confirms it is stopped and the task authorizes recovery.
- `credentialSource: managed_dpapi` and `credentialState: verified`: the
  managed Key successfully read the exact Tunnel. A later alias lookup or
  output parsing failure must retain this credential result; do not rotate it.
- `credentialState: invalid`: the managed DPAPI Key received
  `401 invalid_api_key`; obtain explicit user confirmation immediately before
  rotating it in official runtime settings.
- `credentialState: missing`: the managed DPAPI files need restoration before
  a Runtime reconnect.
- `runtime repair-profile` and `runtime repair-user-environment` repair only
  C2C local token-file paths. They never select or replace the managed Runtime
  Key.

Control traffic never uses browser, UIA, ChatGPT Classic, or ChatGPT Work.
Read-only exact-Chat browser observation is allowed when host transcript
recovery requests it; it never sends control traffic.

## Acquire the task Chat

Resolve the task id in this order: `CODEX_THREAD_ID`, explicit `--task-id`, then
one generated `c2c_task_<uuid>` retained for the current task.

When both `CODEX_THREAD_ID` and `--task-id` are present, they must match
exactly. A mismatch returns `TASK_ID_IDENTITY_MISMATCH` before any registry or
pool operation; it never silently substitutes one task identity for another.

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session resume -w <workspace> --task-id <task-id> --brief --json
```

`session resume` is the normal continuation entry point. It resolves the exact
task binding before any runtime or pool check. `exact` resumes the bound Chat;
`workspace_switch_required` means read the original Chat, then move the same
binding with `session switch-workspace`; `ambiguous` stops for manual handling;
only `unbound` may claim stock. Never move a Git worktree or change a task id to
fit an old binding.

For an unbound task, synchronize inventory once before claim. Use Codex App
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
Run this check before every pool claim: resolve the task binding first. An `unbound` task
may request stock; a failed exact binding uses the recovery flow below.
`pool claim` is globally locked. It selects FIFO unclaimed stock first. With ten
live pool entries already allocated, it requires a fresh (at most 60 seconds)
exact host observation proving either an explicitly idle owner task or a fully
corroborated `notLoaded` owner task, plus an idle exact Chat and clean receipt
readback, before it may reclaim the least-recently-used safe candidate. Pending,
accepted, uncertain, awaiting-reply, degraded, active, missing or unobserved
entries are never reclaimed. A bare `notLoaded` result is not idle proof. Do not
conclude that the pool is busy merely because available stock is zero. Run the
following flow before reporting a blocker.

### Mandatory rotation when unclaimed stock is empty

1. Run `node "__C2C_CHECKOUT__/bin/c2c.js" session pool reclaim-candidates --json`
   (add `--pro` only for an explicitly Pro request). Do not import a Chat already
   in the pool. The ordered `candidates` are local candidates, not host idle proof.
2. For each candidate in returned order, first query its exact owner task with
   `read_thread`, recording its host id and timestamp. If it is explicitly idle,
   continue. If it is `notLoaded`, take a same-host
   `wait_threads(timeoutMs: 0)` snapshot without sending the old task a message.
   Continue only when that exact snapshot reports `inactiveStatus` and the latest
   turn is `completed`; record the turn id, status, host id, and timestamp. A
   missing/archived task without this corroboration, an active task, read failure,
   unknown status, or host/task mismatch excludes that candidate for this pass.
   Continue with the next candidate.
3. Read the exact `conversationId`. It must explicitly be idle. Verify the latest
   Chat user message and completed assistant reply match the candidate's `taskId`,
   `workspaceId`, `iteration`, `lastDeliveredMessageId`, and `lastState` (and
   `lastReviewHead` when present), with no newer request or unfinished reply.
   Follow read cursors when needed. Never infer this from ledger age, title, or a
   lack of visible activity.
4. For a `notLoaded` candidate, immediately take a second same-host
   `wait_threads(timeoutMs: 0)` snapshot. It must still report `inactiveStatus`
   with the same completed latest turn id. Record its timestamp. Do not use a
   later `observedAt` value to hide stale earlier reads.
5. Immediately write one verified observation to a UTF-8 JSON file outside the
   repository and call claim below. Every individual read must be no more than 60
   seconds old at claim time. A candidate change moves to the remaining candidates;
   only expired evidence may be refreshed once. Never populate idle/clean fields
   without the preceding proof.

```json
[
  {
    "conversationId": "<candidate.conversationId>",
    "workspaceId": "<candidate.workspaceId>",
    "taskId": "<candidate.taskId>",
    "generation": 1,
    "assignmentEpoch": 1,
    "observedAt": "<actual UTC observation time>",
    "taskStatus": "idle",
    "chatStatus": "idle",
    "readbackClean": true
  }
]
```

For the corroborated `notLoaded` branch, retain the raw task status and include
all individual reads and the ledger receipt that the exact Chat showed:

```json
[
  {
    "conversationId": "<candidate.conversationId>",
    "workspaceId": "<candidate.workspaceId>",
    "taskId": "<candidate.taskId>",
    "generation": 1,
    "assignmentEpoch": 1,
    "observedAt": "<actual UTC time after recheck>",
    "taskStatus": "notLoaded",
    "taskReadTaskId": "<candidate.taskId from read_thread>",
    "snapshotTaskId": "<same task id from first snapshot>",
    "recheckTaskId": "<same task id from recheck>",
    "taskReadLatestTurnId": "<same completed turn id from read_thread>",
    "taskReadLatestTurnStatus": "completed",
    "chatStatus": "idle",
    "readbackClean": true,
    "taskReadHostId": "<read_thread host id>",
    "snapshotHostId": "<same host id>",
    "snapshotStatus": "inactiveStatus",
    "latestTurnId": "<completed turn id>",
    "latestTurnStatus": "completed",
    "taskReadAt": "<actual UTC task read time>",
    "snapshotReadAt": "<actual UTC first snapshot time>",
    "chatReadAt": "<actual UTC Chat read time>",
    "recheckHostId": "<same host id>",
    "recheckSnapshotStatus": "inactiveStatus",
    "recheckLatestTurnId": "<same completed turn id>",
    "recheckLatestTurnStatus": "completed",
    "recheckReadAt": "<actual UTC recheck time>",
    "receiptIteration": 7,
    "receiptMessageId": "c2c_msg_<exact registered message>",
    "receiptState": "DONE",
    "receiptReviewHead": "<only when candidate has one>"
  }
]
```

Replace the example integers with the exact candidate generation and epoch.
The observation identifies the **old owner**, while the claim identifies your
**own current task**:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session pool claim \
  -w <your-workspace> --task-id <your-task-id> \
  --reclaim-observations-file <absolute-json-file> --json
```

`--reclaim-observations` remains supported, but cannot be combined with the file
option. Do not put route tokens in observations or copy them into diagnostics.

6. The locked claim rechecks ownership, generation, assignment epoch, pending
   state, leases, and the `notLoaded` receipt against the current ledger. If the
   candidate changed, continue with remaining candidates. It does not force a
   takeover or remove the unavoidable host-recovery race window.
7. After success, use only the newly returned binding/token for BOOT and the
   normal accepted → exact delivery → matching reply → confirm-workspace flow.
   Do not send task content until ready. A safely reclaimed Chat is an authorized
   pool rotation, not an arbitrary takeover of another task's binding.
8. If the pass finds no safe candidate, report every candidate's actual local
   exclusion or host-readback reason and counts. Do not report only the first
   candidate. Do not clear pending or age out an `activeUse` lease; an old lease alone
   is not reclaim permission. Do not create additional Chats or change transport.

Use `session finish --use-id <id>` after a normal turn to release only the
coordinator lease while retaining the task binding. A pending delivery cannot
be finished as reusable.

### Recovery of a failed current binding

For an ordinary ChatGPT Chat, call `send_message_to_thread` and `read_thread`
with its exact `threadId`, omitting `hostId`, `model`, and `thinking`. A Codex
owner task's `hostId` belongs only on owner-task reads/snapshots; it must not be
copied to ChatGPT sends. A `no rollout found` error is not deletion evidence.
Check target kind and arguments first. After an explicit terminal rejection and
exact readback, correct the routing and attempt normal same-Chat recovery with
a fresh reserved message. Never resend after an uncertain invocation.

Record routing verification time before sending. If correctly routed sending still explicitly fails, record `host_rejected`,
read the exact idle Chat, and resolve all pending/accepted/uncertain sends.
An old incorrectly routed rejection followed by a routing check is ineligible.
Match the Chat's completed receipt to the current ledger; reject any newer request
or incomplete response, including any hidden delivery of the rejected probe.
Do not stop solely because the task is already bound. Collect all reclaim
candidates above in oldest `lastUsedAt` order and immediately submit the first
safe one. Alongside the candidate observation array, write a UTF-8 recovery
object outside the repo:

```json
{
  "taskId": "<own current task>",
  "workspaceId": "<current workspace>",
  "conversationId": "<current failed Chat>",
  "generation": 1,
  "failureCheckedAt": "<exact current lastDeliveryCheckedAt>",
  "routingCheckedAt": "<actual UTC routing verification BEFORE the new rejected send>",
  "chatReadAt": "<actual UTC exact idle Chat read>",
  "observedAt": "<actual UTC completion time>",
  "hostRoutingChecked": true,
  "routingMode": "conversation_id_only",
  "chatStatus": "idle",
  "readbackClean": true,
  "receiptIteration": 7,
  "receiptMessageId": "<exact lastDeliveredMessageId>",
  "receiptState": "<exact lastState>",
  "receiptReviewHead": "<omit if absent in ledger>",
  "reason": "host_rejected"
}
```

All four times use UTC ISO format with milliseconds and must be within 60 seconds,
ordered routing → rejection → Chat read → observation. Add `useId` only for your
own active continuation lease; it is transferred unchanged to the new binding.
If no completed receipt exists (a rejected first BOOT), use JSON null for both
receiptMessageId and receiptState, retain actual iteration, and verify the exact
standby marker with no newer request. Never invent receipt fields. Run:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session pool claim -w <workspace> \
  --reclaim-observations-file <candidate-array.json> \
  --recover-bound-file <current-binding.json> --json
```

This atomically archives both displaced owners' receipts, quarantines the old
unusable Chat without deleting inventory, transfers the candidate to this task,
increments generation/epoch, and invalidates old capabilities. Complete BOOT
and workspace confirmation on the returned Chat before business INIT.
`RECLAIM_CANDIDATE_CHANGED` means continue with remaining candidates;
`RECLAIM_OBSERVATION_EXPIRED` permits one refresh of all reads. `POOL_BUSY`
requires inspecting local exclusions; `POOL_OBSERVATION_REQUIRED` needs host
evidence. Exhaustion reports every candidate's reason, never asks for more Chats.

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

For a new task with no binding, report the missing inventory without creating
a session just to record `host-control`. Do not import an old worktree's owner.
A completed host turn with no readable message is an observation gap, not
evidence that tools returned or that an audit completed.

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
delivered, iteration advance, or reply is recorded. For a CLI-prepared BOOT,
fresh preflight then restores the same private preparation and message ID; other
terminal recovery uses the normal next permitted message identity.

For review requests pass `begin-send --review-head <full SHA>`, include
`REVIEW_HEAD: <full SHA>` in the user turn and require the reply to echo it.
Pass `confirm-reply --observed-review-head <echoed SHA>`; the ledger rejects
missing or mismatching HEAD values. Confirm `DONE` only when that SHA and all four
receipt identity fields match the current request. An older HEAD's DONE is
historical evidence only. Automated fixtures and a real host read/send/readback
review must be reported separately.

If a generated review-bearing INIT or ANALYSIS reply has the exact four receipt
fields and required mem fields but omits `REVIEW_HEAD`, confirm the actual receipt
without inventing a head. Guidance then returns
`review_head_clarification_required`: preserve that receipt, refresh host
preflight, and send a new `STATE: ANALYSIS` with the same exact
`--review-head`. Do not rewrite the observed reply, resend INIT, or send
EXECUTED. Only the matching exact-head ANALYSIS reply clears this fence.

## Boot Prompt and Router capability

For every first binding, fixed-pool rotation, workspace migration, or interrupted
BOOT recovery, complete host preflight and use the single BOOT preparation entrypoint:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session prepare-boot \
  -w <workspace> --task-id <task-id> --expected-generation <generation> \
  --use-id <own-lease> --json
```

The JSON returns non-sensitive task identity, generation, assignmentEpoch,
message ID, iteration, body digest, `sendAllowed`, next action, and a private
`messageFile`. It never returns `C2C_ROUTE_TOKEN`, the BOOT body, or a route
token in a normal error. The material file is outside the checkout. On Windows
it permits only the current user and SYSTEM; on Unix the directory is `0700` and
the file is `0600`. If that permission cannot be applied, preparation fails; do
not fall back to a public temporary file.

When `sendAllowed: true`, read the body from `messageFile` only in memory and pass
it unchanged to `send_message_to_thread` for the returned exact conversation ID.
Do not handwrite BOOT, extract its token into a shell command, add `REVIEW_HEAD`,
or use `begin-send --bootstrap`. Check the command's `ok`, message ID, iteration,
generation and exact bound conversation before the one send.

`CONNECTOR` remains a local display or selection label only. It is not a field returned by workspace_info,
so it must never be added to the generated BOOT,
treated as an MCP identity field, or used to confirm a workspace.

Repeated `prepare-boot` calls recover the same transaction, capability, body,
message ID and iteration. If a reservation already exists, its body is recoverable
but `sendAllowed: false`: first read the same Chat and follow normal delivery or
reply confirmation. Only a proven `host-control --result not-invoked
--confirm-not-invoked` result, followed by fresh required preflight, permits
re-reserving that same unsent BOOT. Accepted, delivered, waiting, or uncertain
sends never get a new token, new message, or replacement Chat. After a matching
BOOT reply and actual `confirm-workspace`, private material is deleted; a cleanup
failure remains a retryable, token-free audit record.

The Router resolves the attached capability to exactly one current workspace.
Every one of the eight C2C read-only tools requires its `route_token`; a missing,
wrong, revoked, or cross-task token returns `ROUTE_ACCESS_DENIED`. The token never
grants write, shell, Git mutation, or access to another workspace.

Before calling `send_message_to_thread`, verify the reservation command exited
successfully and returned ok=true with the exact message ID and iteration.
If preflight expired, refresh probe and exact readback, then reserve; do not send
after a failed CLI command. Check each dependent command before proceeding.
Use `--use-id <own-lease>` with get/host-control when holding a coordinator lease.
With no pending request, `probe_then_read_bound_chat` means refresh the missing or
expired preflight before reserving. Pending readback takes priority over that timer.

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

Delivery and reply have separate clocks. After the first 60 seconds, read every
15 seconds; after five minutes, read every 30 seconds. Five minutes changes the
cadence, never ends the wait. Each wait is at most 60 seconds. After fifteen
minutes, diagnose host health and pagination; keep waiting if observations are
possible and the outcome is unresolved. Start each read at the newest page and
follow cursors as needed to find the exact request and matching reply.

After delivery, use the same cadence for the assistant reply. `idle`, a completed
host turn, an empty page, or a timeout cannot prove that no reply exists.
`session get --use-id <own-lease>` and `resume` expose `delivery_readback_required`
or `reply_readback_required`, waitingMs, nextReadInMs and diagnosticRequired.
An unknown legacy phase start has waitingMs=null and requires diagnostics, not
an invented timestamp. A different coordinator lease must be respected.

Record actual read results with `session record-readback --observation-file
<UTF8-JSON> --json`. This does not confirm delivery or reply. Example shape:

```json
{
  "taskId": "<own-task>", "workspaceId": "<workspace>",
  "conversationId": "<exact-chat>", "generation": 1, "assignmentEpoch": 1,
  "messageId": "<pending-message>", "iteration": 1,
  "readAt": "<actual-UTC-read-time>", "result": "empty",
  "paginationComplete": false, "chatStatus": "idle", "useId": "<own-lease>"
}
```

Read actual identities and epoch from the binding and pool. Result is one of
empty, request_visible, reply_visible, missing, timeout, read_failed. Include
hostTurnId, hostTurnStatus (inProgress/completed/failed/interrupted), chatStatus
(active/idle), paginationComplete, errorCategory (timeout/unavailable/missing/other)
and useId only when actually known or held. Never invent missing host evidence.
Submit each observation within 60 seconds of its read. A stale generation,
message, lease or epoch requires rereading; never overwrite the newer binding.

Temporary missing/timeout results update observations while preserving the
message phase and pending receipt. Keep the same Chat and never resend.
On task continuation and before any new message, reconcile the existing pending
request first. If the host cannot be observed, report the concrete observation
blocker and pending identity; resume that same readback when tools return.
This is not permission to substitute full local analysis for ChatGPT analysis.

`fail-delivery` is only for an explicit host_rejected, conversation_gone, or
identity_mismatch result. Preserve the existing terminal recovery and fixed-pool
rules; short empty reads never authorize retirement or rotation.
Authorized terminal recovery does not require another user decision.

A matching PLAN closes its transport receipt even when its analysis is weak.
Check SOURCE_EVIDENCE, ACTIONS, TESTS and SUCCESS_CRITERIA before implementation;
after confirming the completed reply, request missing analysis in a fresh message.
MEMORY_STATUS READY is a reply declaration: real acceptance additionally requires
verifiable mem and source-tool evidence, not just that declaration.

Then wait for the matching ChatGPT reply and run `session confirm-reply` with
the same observed identity fields. After `workspace_info` reports the expected
workspace id, route task id, name, and branch, run `session confirm-workspace`
with `--observed-route-task-id <routeTaskId>`. The optional
`--observed-connector-name` is legacy display input only; it is never an
identity proof. Use the tool's observed `workspaceId` and `routeTaskId`, not the
BOOT receipt's `WORKSPACE_ID` and `TASK_ID`, to fill this command:

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session confirm-workspace \
  -w <workspace-root> --task-id <own-task-id> \
  --observed-workspace-id <workspace_info.workspaceId> \
  --observed-route-task-id <workspace_info.routeTaskId> \
  --observed-workspace-name <workspace_info.workspaceName> \
  --observed-branch <workspace_info.git.branch> --json
```

Quote paths, names, and branches as required by the current shell. For a null
`git.branch`, omit `--observed-branch`. Run the command only after the matching
DONE receipt is registered, including after a workspace switch. Never fill a
missing observation using an expected identity from the ledger or BOOT prompt.
Only a `ready` task may receive task content.

## Normal control loop

Every control message includes `TASK_ID`, `WORKSPACE_ID`, `ITERATION`, and a
fresh `MESSAGE_ID`. Complete host preflight above, send to the exact bound Chat,
record host acceptance, poll `read_thread`, and then confirm delivery and reply.
`session prepare-init` creates the INIT id, iteration, body, digest, and atomic
reservation together. `session prepare-boot` owns all BOOT identities and private
route material. `session new-message-id` is only for recovery probes and EXECUTED;
never write a handmade `c2c_msg_*` value.

`REVIEW_HEAD` belongs only to review-bearing INIT or EXECUTED messages. Never put
it on BOOT. `session prepare-boot` has no review-head input, and legacy malformed
BOOT receipts are reconciled only through their existing exact readback. A BOOT
proves routing and workspace identity, not a code review.

A send-tool result means only accepted. It is delivered only after the original
user turn is read back. It is complete only after an identity-matching reply is
read back. A late readback keeps the same message in `sending`; it does not
advance the iteration or create a second send. A later recovery after an
explicit terminal host result uses a fresh message id and `begin-send --probe`.

Keep control messages under 1 KB. ChatGPT must retrieve code itself. The reply
may be longer when needed for an actionable plan. SOURCE_EVIDENCE must distinguish
actual tool observations from assumptions or executor reports.

## Mandatory mem business INIT

Every new C2C business task, the first business request after a pool rotation,
and the first business request after a workspace migration must use this exact
flow. BOOT remains C2C identity verification only. A previous task's Chat mem
context never satisfies this requirement, because the initialization belongs to
the current binding generation.

1. Create a UTF-8 JSON input file. Keep each field concise so the generated
   message stays under 1 KB. `repository.provider` is `github`, `gitea`, or
   `other`; `memoryProject` is the ChatGPT mem project identifier.

```json
{
  "goal": "<one short task statement>",
  "constraints": "<scope, user decisions, exclusions>",
  "successCriteria": "<observable outcome>",
  "repository": { "provider": "gitea", "name": "owner/repo", "branch": "main" },
  "localState": "clean main",
  "memoryProject": "<registered mem project>"
}
```

2. Reserve and render the exact INIT. Do not replace its `MESSAGE_ID`, edit its
   text, or use `begin-send` for INIT. Include `--use-id` if this task holds a
   lease, and `--review-head` only for a review-bearing INIT.

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session prepare-init \
  -w <workspace> --task-id <task-id> --input-file <init.json> \
  --use-id <use-id> --json
```

Send the returned `message` string unchanged with `send_message_to_thread` to
the bound `conversationId`, then record `confirm-send-accepted`. Read the exact
user message back, write only its exact body to a UTF-8 file, and bind its SHA-256
through delivery confirmation. A missing file or differing body leaves the INIT
pending and must not be replaced.

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session confirm-delivery \
  -w <workspace> --task-id <task-id> --message-id <message-id> \
  --observed-task-id <task-id> --observed-workspace-id <workspace-id> \
  --observed-iteration <iteration> --observed-message-file <exact-user-body.txt> --json
```

3. The generated request requires ChatGPT to call `memory_start_task` first with
   `detail="standard"`, `intent="start"`, `mode="hybrid"`, and
   `includeProjectContext=true`. It passes the goal, constraints, and success
   criteria as `task`, and the exact `MEMORY_PROJECT` as `project`. If historical
   facts or documents are needed, it calls `memory_search`. For Gitea work it
   then uses read-only `codewiki_*` and `gitea_*` tools as needed. It also calls
   C2C `workspace_info` and current-source tools; local C2C evidence wins on a
   conflict. It never calls `memory_write_summary`, any Gitea write tool, or any
   other write interface without separate user authorization.

4. Read the matching reply and confirm its exact identity plus all mem fields.
   `READY` means `memory_start_task` actually succeeded. `DEGRADED` is allowed
   only with a concrete reason (missing connector, unregistered project, or a
   read failure); retain it and continue from C2C local evidence. It never means
   that Codex may claim the unavailable mem analysis occurred.

```text
node "__C2C_CHECKOUT__/bin/c2c.js" session confirm-reply \
  -w <workspace> --task-id <task-id> --message-id <message-id> \
  --observed-task-id <task-id> --observed-workspace-id <workspace-id> \
  --observed-iteration <iteration> --state PLAN \
  --memory-project <MEMORY_PROJECT> --memory-status READY \
  --memory-sources memory_start_task,memory_search,codewiki_repo_tree,gitea_get_issue --json
```

For a degraded reply replace the last two lines with its exact source list,
`--memory-status DEGRADED`, and `--memory-reason <exact reason>`. After this
confirmation only, send ordinary business follow-ups as
`session begin-send --kind executed`; the CLI rejects EXECUTED if the current
generation has no READY or DEGRADED mem initialization.

```text
[C2C]
STATE: EXECUTED
TASK_ID: <task-id>
WORKSPACE_ID: <workspace-id>
ITERATION: <n>
MESSAGE_ID: <message-id>

GOAL: <same agreed outcome>
RESULTS: <changes, checks, failures; executor-reported>
EVIDENCE: <current diff, test-record or artifact locations>
LOCAL_STATE: <clean|local changes|unpushed commits>

This follows an already confirmed current-generation mem INIT. Read current
evidence through the read-only tools. Echo the four identity fields.
Return the next substantive PLAN, verified DONE, or BLOCKED with prerequisites.
Separate independent observations from executor reports.
```

## ChatGPT read-source order

1. `memory_start_task` loads project memory, rules, and document context.
2. `memory_search` answers a specific historical or documentation question.
3. For Gitea, read-only `codewiki_*` and `gitea_*` tools read Wiki, repository
   structure, Issues, commits, and current remote state.
4. C2C MCP reads the actual current workspace, uncommitted diff, and execution
   records. It is final authority when sources conflict.

Memory, Wiki, and remote repository data can be stale. The C2C Router still has
exactly eight read-only workspace tools; mem, OpenDeepWiki, and Gitea are not
implemented or exposed by this repository's Router.

## Safety invariants

1. C2C MCP remains eight read-only tools. Never add write, shell, package,
   Git-mutation, delete, or secret-reading tools.
2. Never paste repository files, diffs, long logs, credentials, cookies,
   Tunnel tokens, or route tokens outside the CLI-generated private BOOT body
   sent to its exact bound Chat.
3. Only one in-flight request exists per task Chat. Parallel subagents do not
   write to it. ChatGPT reviews only after their results are merged into a
   stable workspace checkpoint.
4. Use another fixed-pool Chat only after the exact bound id is proven deleted or
   terminally identity-mismatched and the current send is resolved. Automatically
   retire or quarantine the unusable binding, then claim the first safe LRU
   candidate; do not replace a healthy or temporarily degraded Chat.
5. Do not auto-switch transport. OpenAI Secure MCP Tunnel is the default;
   Cloudflare remains an explicit user-chosen fallback.
