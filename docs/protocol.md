# C2C Agent Protocol

## Business reasoning loop

ChatGPT performs primary repository exploration, planning, root-cause analysis,
test design, and review using read-only source access. This uses ChatGPT subscription
capacity to reduce repeated reasoning in Codex. Codex owns execution, necessary
judgment, and verification; it checks scope and readiness before requesting analysis.

`ready → generated mem INIT → PLAN → execution → EXECUTED → PLAN / DONE / BLOCKED`

Every business INIT is created only by `session prepare-init -w <workspace>
--input-file <UTF-8 JSON> [--use-id] [--review-head] --json`. It atomically
generates the receipt id, iteration, under-1-KB body, its SHA-256, and the send
reservation; agents send its returned `message` unchanged. The JSON contains
`goal`, `constraints`, `successCriteria`, `repository.provider/name/branch`,
`localState`, and `memoryProject`.

The generated INIT supplies the goal, constraints, and success criteria and first
requires ChatGPT to call `memory_start_task` with the exact `memoryProject`,
`detail="standard"`, `intent="start"`, `mode="hybrid"`, and
`includeProjectContext=true`. It uses `memory_search` for needed history and
documents, read-only `codewiki_*` and `gitea_*` tools for Gitea facts when
relevant, and C2C source tools for the current workspace. It must not call
`memory_write_summary`, Gitea write tools, or any other write tool without
separate user authorization. C2C local evidence is final if sources conflict.

The matching INIT reply must echo `MEMORY_PROJECT`, `MEMORY_STATUS`, and
`MEMORY_SOURCES`; `MEMORY_REASON` is mandatory for `DEGRADED`. `READY` records a
successful `memory_start_task`; `DEGRADED` records a concrete unavailable,
unregistered, or read-failure reason and permits C2C-only continuation. Delivery
confirmation for INIT requires `--observed-message-file` and compares its exact
readback digest. Reply confirmation stores the mem result only for the current
generation. A pool rotation, generation change, or workspace migration clears it;
old Chat context never authorizes a new task. `begin-send --kind executed`
requires a current-generation READY or DEGRADED INIT.

ChatGPT returns a substantive PLAN with SOURCE_EVIDENCE, ACTIONS, TESTS, and
SUCCESS_CRITERIA. Codex checks and executes that plan, then sends EXECUTED with
results and evidence locations. Complex failures return to ChatGPT for diagnosis;
Codex does not repeat the entire investigation. An identity echo or generic advice
does not satisfy PLAN. BOOT DONE confirms connectivity only, not business completion.
Business DONE requires evidence for the agreed outcome, checked by Codex. There is
no fixed business-iteration cap. All messages retain the delivery and identity
requirements below.

Simple deterministic operations, such as a trivial typo edit, can run directly only
when no exploration, design, or diagnosis is needed. Mechanical cross-file changes
with unresolved impact still require analysis. Complete user plans need only
necessary code mapping and gap analysis, not forced replanning. Review-only work
stays review-only, and user restrictions on external sharing take precedence.
An unavailable channel is an offload blocker: preserve binding and receipts, do
not claim analysis occurred, and do not silently move all reasoning to Codex.
Only independently authorized, fully specified work may continue without it.
This exception never suspends pending readback: due observations take priority.
Read-only local/memory/Gitea investigation is reasoning and cannot silently replace
the delegated analysis. Generic planning/TDD/worktree workflows preserve this rule.

See the [Skill templates](../skill/SKILL.md#normal-control-loop). Documentation
tests prove instruction presence; real acceptance requires observed source reads,
a substantive response, exact same-Chat receipts, and normal lease release.

For the lease recovery counterexamples and test coverage matrix, see
[lease-recovery-matrix.md](lease-recovery-matrix.md).

Control plane: Codex App background tools `list_threads → read_thread →
send_message_to_thread`.

Data plane: the C2C Router MCP endpoint. It has eight read-only tools.

Browser sending, UIA, ChatGPT Classic, ChatGPT Work, drafts, and clipboard
flows are not control surfaces. Supported browser tools may read the exact bound
Chat as an alternate observer when the host transcript omits a visible reply.

### Alternate observer and source-workspace receipts

A fresh host observation with a missing phase receipt and idle/terminal state
produces `coordinatorAction=read_exact_chat_in_browser` (active generation still
waits). Open the `chatUrl` from get/resume and verify its final URL and visible
assistant body. Record `source=browser`, `sourceUrl` and the actual read time;
omit host turn fields. The normalized URL must match the binding including its
project. Credentials, ports, query strings, non-HTTPS and other Chats are rejected.
Legacy observations default to `source=host`. Browser unavailable may be recorded
as observation_blocked without a fabricated URL. Missing results retain pending.

Visibility remains a hint. Normal `confirm-delivery` enforces the INIT digest;
normal `confirm-reply --observed-reply-file <UTF-8 body>` validates the four IDs,
STATE, review HEAD and memory fields against the observed assistant body. Only a
fresh matching observation can supply its provenance. The ledger stores the
SHA-256 and source, not the response body. No resend, cancellation or supersession
is introduced. Network inspectors and private Chat APIs are outside this path.

When a unique task is bound elsewhere with pending, get/resume/host-control return
`reconcile_source_pending` before migration. The receipt commands and record-readback
accept `--bound-workspace` from the current checkout; all observed identities remain
the source identities, and all lease/message/generation checks still apply.
Host-control can restore source observation with the same flag; finish can release
the caller's own source lease only after pending is resolved. Sending has no such
override. Once reconciled, use the existing same-Chat workspace migration handshake.

## Global Router

One Router is anchored to the existing OpenAI Secure MCP Tunnel and its existing
ChatGPT connector. `c2c router ensure -w <workspace>` registers each new local
workspace. The gateway keeps one transport runtime; requests are stateless and
resolve a new `Workspace` instance from a task capability on every call.

On upgrade, `c2c session migrate --json` takes the existing global session lock,
backs up legacy pool and workspace records, and writes the assignment ledger
before ordinary pool claims resume.

An old `unavailable` record created by the retired read-miss rule stays out of
stock. After direct `read_thread` confirms the original Chat and its task and
workspace identity, `c2c session restore --confirm` re-adopts that exact
conversation in the same generation. Explicit host deletion proceeds to a new
claim.

A route capability binds:

```text
workspaceId + taskId + conversationId → SHA-256(route_token)
```

The raw `route_token` appears only in the CLI-generated private BOOT material
that is sent once to its exact task Chat. It is not saved in the session registry,
Router state, normal CLI JSON, logs, or task outputs. The private file is outside
the checkout and restricted to current-user plus SYSTEM on Windows or `0700`/`0600`
on Unix. All eight MCP tool schemas require `route_token`. An invalid, revoked,
expired, or cross-task token returns `ROUTE_ACCESS_DENIED` before workspace access.

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
atomically saves a permanent `workspaceId + taskId → conversationId` binding in
the single assignment ledger. The ledger contains both inventory and task
owners, validates that each Chat has one owner, and uses an atomic replacement
write. Malformed or conflicting ledger state pauses claims and sends while the
original evidence remains intact.
A claimed Chat is never returned to stock. If it is deleted, it becomes retired
and the same task may claim a next generation. A temporary direct-tool failure
only sets `degraded`; it does not replace the Chat. Empty compatible stock yields
`POOL_EXHAUSTED` and blocks task content.

When all compatible entries are claimed, the pool may rotate the least-recently-
used locally eligible Chat only after fresh host evidence. The normal branch
requires an explicitly idle owner task and idle exact Chat. A `read_thread`
result of `notLoaded` is not idle by itself: it additionally requires two
same-host immediate `wait_threads(timeoutMs: 0)` snapshots reporting
`inactiveStatus`, the same completed latest turn, an idle exact Chat, and a clean
receipt matching the ledger's task/workspace/iteration/message/state/review HEAD.
Each task, snapshot, Chat, and recheck read must be within 60 seconds at claim
time. The locked ledger rechecks owner, generation, epoch, verification, lease,
pending state, and the observed receipt before it archives the old owner and
invalidates its route capability. Host and ledger reads are separate operations,
so this narrows rather than removes a later host-activity race.

The fixed inventory is reused automatically, with no request for extra standby
Chats. Healthy exact bindings continue normally. For an unusable bound Chat,
`session pool claim --recover-bound-file <UTF-8 JSON object>` combines current
binding recovery evidence with `--reclaim-observations-file <candidate array>`.
Replacement requires fresh terminal evidence for the current binding, no pending
or uncertain send, and a complete safe-candidate observation set. The existing
`host_rejected` evidence shape remains supported. A second reason,
`conversation_limit_reached`, accepts the current task/workspace/conversation/
generation and optional own lease, current receipt identity, `chatReadAt`,
`observedAt`, `chatStatus:"idle"`, `readbackClean:true`, `source:"host"|"browser"`,
and an explicit `terminalText` of 1–512 characters that identifies the ChatGPT
conversation length limit. Browser evidence also requires `sourceUrl`: HTTPS on
`chatgpt.com` or `chat.openai.com`, with the bound conversation id in its path;
host evidence must omit the URL. It does not require an intentionally failed send
or `host_rejected` proof. Reads and receipt must match the current binding and be
no older than 60 seconds; the locked recheck also requires no active pending,
uncertain send, or conflicting lease. The lock archives displaced assignments
with receipts and destinations, quarantines the unusable Chat without retiring
inventory, and assigns the first eligible LRU candidate. Generation and
assignment epochs fence concurrent recovery. Replacement requires BOOT and
workspace confirmation.

ChatGPT `send_message_to_thread`/`read_thread` calls omit Codex `hostId` routing.
`no rollout found` is a routing error to investigate, not deletion proof. Unknown
delivery outcomes retain the original pending message and prevent rotation.

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

Task identity comes from `CODEX_THREAD_ID` when the host provides it. An
explicit `--task-id` may repeat that value for automation, while a different
value stops before any registry or pool write with `TASK_ID_IDENTITY_MISMATCH`.

The coordinator never handwrites a new BOOT. After normal or migration preflight,
it runs `session prepare-boot --expected-generation <n> [--use-id] --json`.
That staged transaction persists a token-free preparation record, writes the full
BOOT body to a private material file, registers an initially inert Router
capability, attaches it to the current unique binding, and reserves exactly one
message. Its normal JSON includes only identity, generation, assignmentEpoch,
message ID, iteration, digest, next action and the material-file path; it never
includes the body or `route_token`.

Only when `sendAllowed: true` may the coordinator read that private file in memory
and pass its unchanged body to `send_message_to_thread` for the exact bound Chat.
The generated Boot Prompt contains `C2C_ROUTE_TOKEN` and tells ChatGPT to call
`workspace_info` first with `route_token`. The task becomes `ready` only after
delivery and reply readback plus matching workspace id, routed task id, name,
branch, and all four receipt identity fields.

The Boot reply must echo `routeTaskId`, `workspaceName`, and `git.branch` as
returned by `workspace_info`, alongside `TASK_ID`, `WORKSPACE_ID`, `ITERATION`,
and `MESSAGE_ID`. `CONNECTOR` is a local display/selection label, not a
`workspace_info` field and never an identity proof. A reply that only echoes
receipt fields leaves workspace verification pending.

`send_message_to_thread` means accepted only. The coordinator records that
acceptance, then polls `read_thread` on the exact conversation. It confirms
delivery after the matching user message appears, and confirms reply only after
the matching ChatGPT reply appears. `wait_threads` is not used for ordinary
ChatGPT conversations.

Repeated `prepare-boot` calls return the same private preparation/body/message
instead of issuing another capability. A prepared reservation whose send outcome
is unknown has `sendAllowed: false`; read the exact existing Chat before any other
action. Only a `not-invoked` attestation for a send tool that was never called,
followed by fresh required preflight, permits re-reserving that same BOOT. Accepted,
delivered, reply-waiting and uncertain sends never receive another token, message,
or Chat. Confirmation deletes the private body and retains a token-free audit
record; cleanup failure is retryable and does not revert ready.

Delivery and reply use independent clocks. The first 60 seconds poll every 5
seconds, then every 15 seconds until five minutes, then every 30 seconds. Five
minutes is a cadence change, not a terminal failure or permission to stop reading.
After fifteen minutes diagnose host health and pagination and continue if readable.
Each wait is at most 60 seconds. Start with the newest page and follow cursors to
find the exact pending request/reply. `idle`, completed turns, partial/empty pages,
timeout and late delivery are observation gaps, not proof of absent replies.

The current coordinator owns an active read/record/confirm loop. CLI guidance does
not start a worker. `coordinatorAction` distinguishes read_now, wait_then_read,
confirm_receipt, diagnose_readback, restore_observation and follow_next_action.
`readbackDueAt` and `observationAgeMs` are derived from actual observations;
no observation means read now. Matching visible replies take priority over an
elapsed diagnostic threshold. Visibility never bypasses exact receipt validation.
Old/mismatched/future observations cannot keep a resumed task waiting indefinitely.

`businessGate` separately identifies await_boot, await_plan (INIT or ANALYSIS),
await_review (EXECUTED), await_reply (legacy), connection_required or assess_reply.
These describe required work, not a grant of filesystem execution authority.
Ready/PLAN alone never proves substantive analysis or business completion.
An initial BOOT DONE with workspace verification still pending returns
workspace_confirmation_required + await_boot. The recorded bootReplyGeneration
prevents an old-generation DONE from being promoted as the current BOOT; legacy
generation-one receipts remain compatible. Migration uses its existing distinct
action. confirm-workspace is also lease-fenced and requires actual MCP identity.

`session record-readback --observation-file <UTF8 JSON>` records actual taskId,
workspaceId, conversationId, generation, assignmentEpoch, messageId, iteration,
readAt and result (empty/request_visible/reply_visible/missing/timeout/read_failed).
After concrete health/read/pagination diagnosis, observation_blocked additionally
requires errorCategory=unavailable and a sanitized nonempty blockedReason up to
500 characters. It is a recoverable observation gap, never terminal send failure.
Idle/completed/time alone is insufficient; report what prevents observing the
result and the needed recovery. A later continuation rechecks the original request.
Optional paginationComplete, hostTurnId, hostTurnStatus, chatStatus, errorCategory
and useId remain unknown when absent. Observations must be within 60 seconds,
match the lock-protected current binding/message/lease and never regress in time.
No body or route token is stored. Observations never confirm a receipt or resend.

### Lease ownership and recovery

`get`, `resume` and `host-control` use the same recovery decision. `leaseStatus` is
one of `none`, `own`, `recoverable_own`, `ownership_unproven` or `conflict`.
`get` never returns `useId`. A blocked command never reveals a lease id.
`recoverable_own` means the actual `CODEX_THREAD_ID` matches the unique
authoritative task and pool owner for this active lease, workspace, Chat,
generation and assignment epoch. The private continuation is a restricted cache,
not a second ownership authority: absent, stale, or ordinary corrupt contents are
reconstructed from the verified ledger under lock. `ownership_unproven` means the
host task identity is absent or cannot be matched to a unique authoritative
owner; it is never produced solely because the cache is missing. `conflict` means
a supplied identity or authoritative binding/pool state conflicts with current
state. None of these outcomes authorizes replacing another task's lease.

For `leaseStatus=none`, follow `nextAction` without assuming lease acquisition is
the first step. A legacy pending request may be read and confirmed without
`--use-id`. Probe/read preflight without a lease when guidance requires it. Acquire
only when the next allowed step is ready continuation or a lease-fenced send or
preparation. For `recoverable_own`, call
`session resume --recover-own`; this requires the actual `CODEX_THREAD_ID` and
returns the existing `useId` after validating the unique ledger/pool binding. It
rebuilds the private cache when ordinary contents are absent, stale, or corrupt.
A known current lease may instead use `resume --use-id <known-own-id>`. Never copy
a use id from a ledger or blocked output.

`--recover-own` is the automatic task continuation entry, not a restore-only
flag. With no active ledger lease it acquires and persists a new lease under the
existing busy/preflight checks, or finishes a matching prepared transaction.
After release it may acquire a fresh id; it never resurrects the released id.
With an active lease owned by this host task's unique binding it restores the same
lease and never replaces it. A missing cache cannot trigger fresh acquisition.
Plain `resume` remains a compatible acquisition entry.

The private cache is outside the repository and has restricted permissions. It
records task, use id, workspace, Chat, generation, assignment epoch, timestamps
and recovery stage. Acquire/restore/release is serialized with the session ledger;
interruption reuses the same use id. Ordinary malformed cache contents can be
rebuilt from verified ledger ownership. Symlinks, hard links, unsafe ACLs or other
filesystem safety failures remain `LEASE_CONTINUATION_INVALID` storage errors;
they are not lease-ownership diagnoses. All state-changing receipt commands accept
`--use-id` and validate ownership under the same lock. `record-readback --use-id`
may bind an observation that omits its use id; if both values are present they
must match.

One explicit `binding_recovered` path may retain the same task's lease across a
generation/Chat recovery when the actual host task identity and current unique
authoritative owner still match. One-hop history is retained for audit, not used
as an extra ownership gate. The private cache may be reconstructed for the
recovered binding. This is not a general transfer. Normal `switch-workspace`
keeps the same Chat and requires releasing
the task's lease before migration. Pending/uncertain sends cannot use terminal
binding recovery.

Recovery order is: resolve task identity and binding; recover or classify the
lease; restore only the host capability needed for the current action; reconcile
any pending request; then migrate, prepare BOOT, confirm workspace, or continue
business. If `send_message_to_thread` is missing but `read_thread` works, the
coordinator may still read and reconcile pending. Missing send capability blocks
new sends, not available reads. If reading is unavailable, no receipt can be
confirmed. Temporary read failures retain sending/awaiting_reply. Legacy
degraded pending records recover their phase from registered delivery evidence.
Only explicit terminal evidence uses fail-delivery; observation failure never
authorizes resend.

`nextAction` names the current phase, `coordinatorAction` selects read/wait/
confirm/diagnose within it, and `businessGate` marks dependent work that must wait.
Do not recompute a competing action by combining these fields. With no pending,
expired preflight returns `probe_then_read_bound_chat`. A send still requires a
successful reservation with matching identity. Documentation tests prove wording,
not model behavior; real acceptance requires same-Chat reads, matching receipts,
and normal lease release.

Matching PLAN receipts and substantive analysis are separate: confirm the receipt,
then require code evidence/actions/tests/success criteria or request supplementation.
Use `begin-send --kind analysis` / `STATE: ANALYSIS` for that supplementation or
diagnosis, with four receipt IDs and a concrete REQUEST. It requires this generation's
mem INIT, reuses that initialization and makes no claim that execution occurred.
Use executed only to report actual execution. Business exemptions do not abandon
already-sent messages or authorize dependent work before the needed reply.
MEMORY_STATUS READY alone does not prove tools ran; acceptance needs tool evidence.

Reply handling uses the single message/reply table in the source Skill. A matching
`STATE: BLOCKED` or `STATE: ERROR` for INIT, ANALYSIS, or EXECUTED, including a
legacy pending message, may confirm transport only when binding
`verificationState` is `ready` and its task/workspace/iteration/message identity
and existing INIT mem fields match, even if `REVIEW_HEAD` is omitted. An omitted
head clears the previous `lastReviewHead`; it never supplies review approval or a
value inferred from the request. A nonempty wrong head remains
`REVIEW_HEAD_MISMATCH`. The shared decision keeps
after ordinary lease/preflight requirements, `nextAction=resume_bound_chat`,
`businessGate=assess_reply`, and `recoveryReason` identifies the negative receipt;
the same Chat remains reusable. Honor any ordinary next action first. This reply
adds no head-specific gate, clarification, automatic re-PLAN, or Chat rotation.
For an existing pending negative response, reread the exact original Chat body,
refresh its readback observation when stale, and `confirm-reply` the same message
id/iteration using its actual BLOCKED/ERROR body. Omit `--observed-review-head` if
the body omits the field; never insert the requested or previous head. This internal
receipt repair needs no user approval, BOOT, resend, or Chat replacement.
For positive/continuing review-bearing INIT or ANALYSIS replies, an
omitted head still records transport only and sets
`review_head_clarification_required`; positive review-bearing EXECUTED still
requires the exact head. BOOT and INIT identity/memory requirements are unchanged.


BOOT must not carry `REVIEW_HEAD`. `prepare-boot` has no review-head option and
the legacy `begin-send --bootstrap` CLI path fails with `BOOT_PREPARE_REQUIRED`;
attempting to reserve a BOOT with a review head fails with
`BOOT_REVIEW_HEAD_FORBIDDEN`.
For legacy ledgers that already contain a malformed BOOT combination, an exact delivered BOOT reply with
matching task/workspace/iteration/message identity may be confirmed without the
head. The pending head is discarded and does not become `lastReviewHead`; normal
review messages still require the exact head, and a non-matching non-empty BOOT
head remains `REVIEW_HEAD_MISMATCH`. Readback and actual
`workspace_info` confirmation remain mandatory.

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

1. ChatGPT first calls `memory_start_task` for project memory, rules and document
   context. It uses `memory_search` for a specific missing historical fact.
2. For Gitea, use read-only `codewiki_*` and `gitea_*` tools for Wiki, repository
   structure, Issues, commits and current remote facts. Use an available
   read-only GitHub connector for GitHub-hosted remote facts when applicable.
3. Use the eight read-only C2C MCP tools for the current local workspace,
   uncommitted diff and execution records. C2C is final authority for current
   local state when sources conflict.

## Workspace migration preflight

`switch-workspace` records a migration handshake under the assignment ledger lock,
including source receipt identity, destination, generations and assignmentEpoch.
The receipt retains its original workspace. `host-control --result
migration-read-ok --observation-file <UTF8 JSON>` validates a fresh idle exact Chat
read against that lineage and current owner. Its `migration_boot_ready` status
permits only `prepare-boot` with the expected generation. The staged preparation
can resume after interrupted material, capability, attachment, or output work;
it cannot authorize a hand-built BOOT or a second send. The exact new BOOT reply
and actual workspace_info confirmation complete the handshake. It
cannot authorize INIT or make the historical DONE a destination BOOT receipt.

Legacy migrations are recovered only from unique workspace_switch history and
matching current receipt; no Chat replacement or generation increment occurs.
Ambiguous or incomplete lineage fails closed. Pending sends and leases retain
normal protection; terminal rejection or proven non-invocation requires fresh
preflight before a same-preparation retry. See the source Skill for the complete JSON and commands.

When `session get` or `session resume` returns
`migration_workspace_confirmation_required`, the destination BOOT has an exact
delivered `DONE` receipt and no unresolved send. The coordinator reads target
`workspace_info` and immediately runs `confirm-workspace` from those actual fields.
This stage does not reopen source-receipt preflight, resend BOOT, replace the Chat,
or increment generation. A source receipt without `REVIEW_HEAD` is valid when the
registered receipt omitted it; plain HEAD is never substituted.

Workspace binding resolution wins over migration substate. A command run from the
old or another workspace returns `release_own_lease_before_workspace_switch` when
a verified own lease exists and no pending remains. Execute the fenced
`finish --bound-workspace --use-id <verified-own-id>` transition, then get again;
only with no active lease does it return `switch_workspace`. No new lease may be
acquired before switching. A unique source binding with pending first returns
`reconcile_source_pending`; it must complete normal receipts before switching.
Likewise, `tools_missing` returns `restore_host_tools_then_read_bound_chat`; the
coordinator restores the exact read/send tools before attempting source readback or
target `workspace_info`.
