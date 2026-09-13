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

See the [Skill templates](../skill/SKILL.md#normal-control-loop). Documentation
tests prove instruction presence; real acceptance requires observed source reads,
a substantive response, exact same-Chat receipts, and normal lease release.

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
Only a correctly routed explicit host rejection, an idle Chat read, a matching
generation/failure receipt, and no unresolved send or other coordinator lease
permit replacement. The lock archives both displaced assignments with receipts
and destinations, quarantines the unusable Chat without retiring inventory, and
assigns the first eligible LRU candidate. Generation and assignment epochs fence
concurrent recovery. The replacement requires BOOT and workspace confirmation.

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

The new Chat's Boot Prompt additionally contains `C2C_ROUTE_TOKEN` and tells
ChatGPT to call `workspace_info` first with `route_token`. The task becomes
`ready` only after delivery and reply readback plus matching workspace id,
routed task id, name, branch, and all four receipt identity fields.

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

The first 60 seconds are a fast check, with an exact read every 5 seconds. A missing user turn in that period is a
late delivery, not a terminal failure: the task remains `sending`, retains its
same message id and write lock, and records `deliveryPendingSince`. Active work
may continue reading for five minutes. If it is still absent, the next task
operation reads that exact in-flight message before any new send. There is no
automatic resend or Chat replacement. Repeated `missing` and timeout results
remain `degraded`; only explicit deletion evidence or an identity mismatch
retires the exact Chat.

`fail-delivery` requires terminal evidence: `host_rejected`,
`conversation_gone`, or `identity_mismatch`. Explicit deletion retires the
exact binding. An identity mismatch quarantines the binding and requires
`session clear --confirm` before a replacement claim; the coordinator performs
that terminal C2C recovery automatically without asking for separate user
authorization. A host rejection keeps the existing binding degraded.

BOOT must not carry `REVIEW_HEAD`. New `begin-send --bootstrap --review-head`
reservations fail with `BOOT_REVIEW_HEAD_FORBIDDEN`. For legacy ledgers that
already contain that malformed combination, an exact delivered BOOT reply with
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

- GitHub connector: committed code, Issues, PRs, history.
- mem/OpenDeepWiki: Gitea Wiki, architecture, project structure.
- C2C MCP: current local files, status, diff, tests, unpushed changes.

Current local C2C data wins on conflicts.

## Workspace migration preflight

`switch-workspace` records a migration handshake under the assignment ledger lock,
including source receipt identity, destination, generations and assignmentEpoch.
The receipt retains its original workspace. `host-control --result
migration-read-ok --observation-file <UTF8 JSON>` validates a fresh idle exact Chat
read against that lineage and current owner. Its `migration_boot_ready` status
permits only BOOT with expected generation, once per reservation. The exact new
BOOT reply and actual workspace_info confirmation complete the handshake. It
cannot authorize INIT or make the historical DONE a destination BOOT receipt.

Legacy migrations are recovered only from unique workspace_switch history and
matching current receipt; no Chat replacement or generation increment occurs.
Ambiguous or incomplete lineage fails closed. Pending sends and leases retain
normal protection; terminal rejection or proven non-invocation requires fresh
preflight before retry. See the source Skill for the complete JSON and commands.
