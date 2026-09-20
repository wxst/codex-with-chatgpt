---
name: codex-with-chatgpt
description: >
  Use when repository exploration, planning, root-cause analysis, test design, or review should be delegated to ChatGPT through this project's C2C Chat.
---

# Codex with ChatGPT

Installed checkout: `__C2C_CHECKOUT__`

## Purpose and six rules

Use ChatGPT subscription capacity for repository reasoning. ChatGPT explores code, plans, diagnoses, and reviews through read-only sources; use Pro and xhigh when available for complex work. Codex checks scope and connection, executes, applies necessary judgment, and verifies. Do not complete the same deep analysis locally before INIT and then ask ChatGPT only to review it.

1. One primary Codex coordinator owns this task's C2C exchange. Subagents return findings; they do not send or confirm C2C messages.
2. Every continuation checks task-scoped state and follows `nextAction`; it may restore or acquire only this task's lease when that action requires one. Never obtain another task's lease or change task identity to bypass ownership.
3. Pending means reconcile the original request first. Do not resend, rotate the Chat, migrate the binding, or do dependent business reasoning while its outcome is unresolved.
4. A new send requires a successful CLI reservation and fresh host preflight. After sending, confirm user-message delivery and assistant reply separately.
5. Transport receipt, BOOT/workspace readiness, useful PLAN, and business completion are different gates.
6. Using this Skill authorizes recovery of C2C state for this task. It does not authorize publication, deployment, service restart, credential changes, destructive cleanup, or changes to another task.

## Daily reasoning workflow

1. Check the goal, constraints, repository state, applicable instructions, and the current task binding. Do not repeat the deep exploration ChatGPT is about to perform.
2. Reach ready, then send a generated INIT before substantial exploration or implementation. Every new business task, Chat rotation, and workspace migration requires a new prepare-init so mem is initialized for the current generation.
3. Wait for an identity-matching, substantive PLAN containing SOURCE_EVIDENCE, ACTIONS, TESTS, and SUCCESS_CRITERIA. Identity echoes, generic advice, or an unexamined DONE are not a plan. Do not edit before the required PLAN except for a listed routing exception.
4. Check scope, evidence, feasibility, and risk. Execute the plan; make targeted checks rather than repeating all exploration.
5. Send an evidence-bearing EXECUTED. ChatGPT reads current state and returns the next PLAN, supported DONE, or BLOCKED with its missing prerequisite. Return complex failures to ChatGPT for diagnosis.
6. Continue until the requested outcome is verified or a real blocker remains. There is no fixed iteration limit. Confirm all receipts and release this task's lease with session finish --use-id <own-use-id> when complete.

Business flow: ready → INIT → PLAN → execution → EXECUTED → PLAN / DONE / BLOCKED. BOOT DONE verifies connection only. ChatGPT's business DONE does not replace Codex verification against the agreed success criteria.

### Exceptions

- Simple deterministic work (such as a trivial typo) may run directly only when repository exploration, design, and diagnosis are unnecessary. A cross-file change with unresolved impact still needs ChatGPT analysis before execution.
- With a complete user plan, ask ChatGPT only for necessary code mapping and gap analysis; do not require redundant replanning. Fully specified, independent work already authorized by the user may overlap a pending reply only if it does not delay readback or depend on that reply.
- Review-only stays review-only. Respect user restrictions on sharing task content.
- An unavailable ChatGPT channel preserves the binding and pending state and is reported as an analysis-offload blocker. It does not permit all reasoning to silently move to Codex. Read-only local, mem, and Gitea research is still reasoning, not a blanket exception. Continue only independent, fully specified work the user authorized. Never claim ChatGPT analysis or acceptance without its observed reply.

These exceptions do not waive host preflight, receipt readback, binding ownership, pending responsibility, or the message-specific REVIEW_HEAD rules below. Do not force replanning when the user already supplied a complete plan. A cross-file impact question still needs ChatGPT analysis before execution.

## Continuation and lease recovery

Use the actual task identity from CODEX_THREAD_ID. If you pass --task-id, it must equal that host id. Never invent another task id to get a binding or lease.

Start every turn with the read-only status command:

    node "__C2C_CHECKOUT__/bin/c2c.js" session get -w <workspace> --brief --json

get never returns useId. Follow its nextAction; do not combine fields to invent a different action.

| leaseStatus | Meaning | Action |
| --- | --- | --- |
| none | No active coordinator lease. | Follow nextAction without acquiring a lease for pending readback or host preflight. When a new lease is required, use resume --recover-own (plain resume remains compatible); an unbound task completes safe pool assignment and its unleased host preflight first. |
| recoverable_own | The real CODEX_THREAD_ID owns the unique authoritative binding and its active lease. | Run resume --recover-own; it restores the same useId and repairs a missing or stale continuation cache. |
| own | A known supplied useId was validated for this task. | Use that id on every state-changing command. |
| ownership_unproven | The current host task identity is missing or cannot be matched to the unique authoritative owner. | Preserve state and report the missing identity or ledger evidence. A missing continuation file alone never produces this state. |
| conflict | A supplied useId, duplicate binding, pool owner, generation, or assignment epoch conflicts with authoritative state. | Preserve state and stop lease mutations. |

For recoverable_own, run:

    node "__C2C_CHECKOUT__/bin/c2c.js" session resume -w <workspace> --recover-own --json

--recover-own requires the real CODEX_THREAD_ID. It returns this task's useId only on success. For leaseStatus=none, first perform the read-only or unleased recovery step named by nextAction. This includes reading/confirming a legacy pending message without --use-id, or probing and reading when preflight is absent. When nextAction reaches a lease-fenced preparation/send or ready continuation with no existing lease, run session resume --recover-own to acquire and persist this task's new lease. When the unique ledger owner matches this host task, the same mode restores the existing lease id even if its private continuation cache is missing, stale, or has ordinary corrupt contents. It recreates that cache under the session lock after checking the authoritative binding. If the caller already holds the known id, session resume --use-id <known-own-use-id> validates and continues it. Never retrieve activeUse.useId from the ledger or an ordinary/blocked get or resume response.

The private continuation is a restricted-permission cache outside the repository. It records task id, use id, workspace, Chat, generation, assignment epoch, and timestamps, and is updated under the session lock. The real host task id plus a unique matching authoritative ledger binding establishes this task's lease; the cache can be rebuilt from that state. A symlink, hard link, unsafe permissions, or filesystem error is a storage-safety failure and must be reported as such, never as another coordinator's ownership. Generation, epoch, pending identity, Router capability, and single-writer rules remain independent checks.

## Shared recovery decision

get, resume, and host-control use the same state decision. nextAction names the required phase; coordinatorAction gives the read/wait/confirm/diagnose operation; businessGate says whether dependent business must wait. nextAction is authoritative.

| Priority | State | Required action |
| --- | --- | --- |
| 1 | Ambiguous binding or task identity mismatch | Stop; preserve the ledger. |
| 2 | Existing lease belongs to this host task's unique binding | Resume with --recover-own; keep the same useId and rebuild the continuation cache if needed. |
| 3 | ownership_unproven or conflict | Do not mutate lease, receipt, binding, or generation. Read-only exact-Chat observation may gather facts if available; missing cache contents alone are not this condition. |
| 4 | Required host read is missing | Restore read_thread before confirming a receipt. If send_message_to_thread is missing but read_thread works, read and reconcile an existing pending request; do not start a new send. |
| 5 | Pending request or uncertain send | Reconcile the same message id and iteration. No new reservation, migration, Chat replacement, or dependent analysis. |
| 6 | No pending request and workspace differs | If own lease exists, follow release_own_lease_before_workspace_switch: finish --bound-workspace --use-id <verified-own-id>, then get again. Only leaseStatus=none proceeds to switch_workspace and the same-Chat handshake. |
| 7 | BOOT absent or preparation interrupted | Refresh preflight and use prepare-boot, recovering its existing preparation. |
| 8 | BOOT reply confirmed but workspace unverified | Read target workspace_info and run confirm-workspace. Do not resend BOOT. |
| 9 | Review-bearing INIT/ANALYSIS omitted required HEAD but otherwise matches | Confirm only the exact transport receipt; follow review_head_clarification_required. |
| 10 | Exact binding is ready | Start or continue the business exchange. |
| 11 | No binding | Inspect the fixed pool and use only an eligible Chat. |

coordinatorAction can be read_now, wait_then_read, confirm_receipt, diagnose_readback, restore_observation, read_exact_chat_in_browser, or follow_next_action. businessGate can be await_boot, await_plan, await_review, await_reply, connection_required, or assess_reply. These fields do not grant execution authority. A missing send tool does not make a readable pending request disappear.

## Executable command recipes

Use the repository CLI, the task identity from CODEX_THREAD_ID, and values returned by successful commands or actual host reads. Keep the installed checkout path; do not assume a global c2c command.

```powershell
$cli = '__C2C_CHECKOUT__\bin\c2c.js'
$workspace = 'C:\path\to\current-repository'
$taskId = $env:CODEX_THREAD_ID
node $cli session get -w $workspace --brief --json
```

For recoverable_own, run node $cli session resume -w $workspace --recover-own --json; use the returned useId only after ok=true. This resumes the ledger's existing useId and rebuilds its private cache when absent or stale. For none, finish the unleased action named by nextAction first. When that action reaches lease acquisition, run node $cli session resume -w $workspace --recover-own --json. A known validated lease resumes with node $cli session resume -w $workspace --use-id $ownUseId --json. ownership_unproven and conflict stop lease mutations only when caller identity or authoritative ownership conflicts; a missing cache alone is not a blocker.

Record the actually available tools. With no active lease, omit --use-id for a required probe/read; when this task has a validated own lease, append it. The paired commands below are alternatives: execute only the form matching the current lease, not both. Never record guessed tool availability:

```powershell
node $cli session host-control -w $workspace --result probe --tools read_thread,send_message_to_thread --json
node $cli session host-control -w $workspace --use-id $ownUseId --result probe --tools read_thread,send_message_to_thread --json
```

Read the exact conversationId from get using only that conversation id, not Codex hostId. Set $conversationId and $workspaceId from the current binding and verified host read. After confirming the exact Chat and task/workspace identity, record read-ok:

```powershell
node $cli session host-control -w $workspace --result read-ok --conversation-id $conversationId --observed-task-id $taskId --observed-workspace-id $workspaceId --json
node $cli session host-control -w $workspace --use-id $ownUseId --result read-ok --conversation-id $conversationId --observed-task-id $taskId --observed-workspace-id $workspaceId --json
```

Before prepare-init or prepare-boot, the probe and exact Chat read must be fresh (60 seconds). After a successful readback, get determines whether to continue without a lease or acquire this task's lease. A pool claim first returns probe_then_read_bound_chat: verify the exact standby marker and new ledger owner in that Chat, complete unleased probe/read-ok when leaseStatus is none, then get again. Only after get reaches prepare_boot_required use session resume --recover-own to acquire the lease. A rotation is not ready for business INIT until BOOT, delivery, reply and workspace_info confirmation complete.

For a BOOT, CLI output must be ok=true and sendAllowed=true with the expected task, workspace, conversation, generation and assignment epoch. Its messageFile is private JSON, and only its body may be sent. Validate all preparation identities and the body SHA-256 in memory; keep the body in a variable for exactly one send to the exact conversation. This PowerShell example never emits the material, token, or body:

```powershell
$preparation = node $cli session prepare-boot -w $workspace --expected-generation $generation --use-id $ownUseId --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $preparation.ok -or -not $preparation.sendAllowed) { throw 'BOOT is not authorized to send; reconcile nextAction' }
$material = Get-Content -LiteralPath $preparation.messageFile -Raw | ConvertFrom-Json
foreach ($key in @('preparationId','taskId','workspaceId','conversationId','generation','assignmentEpoch','messageId','iteration','bodySha256')) { if ($material.$key -ne $preparation.$key) { throw "BOOT identity mismatch: $key" } }
$sha = [Security.Cryptography.SHA256]::Create()
try { $actualDigest = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$material.body)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
if ($actualDigest -ne $preparation.bodySha256) { throw 'BOOT body digest mismatch' }
$bootBody = [string]$material.body
# Keep both values in this same execution boundary; do not print the body or put it in shell history.
```

The host tool call is send_message_to_thread({threadId: preparation.conversationId, prompt: bootBody}); here threadId is the exact Chat conversation id, never a Codex hostId. PowerShell variables cannot cross into a separate MCP invocation. Use one supported execution environment that can safely read the private file and pass its body directly to that host call. If none is available, report a private BOOT-material read/send blocker and do not expose the body.

Create INIT and readback files as UTF-8 without a BOM. The INIT file contains goal, constraints, successCriteria, repository.provider/name/branch, localState and memoryProject:

```powershell
$utf8NoBom = [Text.UTF8Encoding]::new($false)
$initFile = Join-Path $env:TEMP 'c2c-init.json'
$init = [ordered]@{ goal='Read-only task goal'; constraints='No writes'; successCriteria='Return a source-backed finding'; repository=[ordered]@{ provider='github'; name='owner/repo'; branch='main' }; localState='main; clean'; memoryProject='registered-project' }
[IO.File]::WriteAllText($initFile, ($init | ConvertTo-Json -Compress -Depth 5), $utf8NoBom)
$prepared = node $cli session prepare-init -w $workspace --input-file $initFile --use-id $ownUseId --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $prepared.ok -or -not $prepared.reserved) { throw 'INIT reservation failed; do not send' }
# Send $prepared.message unchanged to $prepared.task.conversationId.
```

After the host accepts a send, record host acceptance. For INIT, save the exact visible user-message body and confirm its digest; use the same pattern for BOOT delivery but omit --observed-message-file when the message is not generated INIT:

```powershell
$messageFile = Join-Path $env:TEMP 'c2c-init-readback.txt'
[IO.File]::WriteAllText($messageFile, $exactObservedUserBody, $utf8NoBom)
node $cli session confirm-send-accepted -w $workspace --message-id $prepared.messageId --use-id $ownUseId --json
node $cli session confirm-delivery -w $workspace --message-id $prepared.messageId --observed-task-id $taskId --observed-workspace-id $prepared.workspaceId --observed-iteration $prepared.iteration --observed-message-file $messageFile --use-id $ownUseId --json
```

If host acceptance is recorded but the exact user message remains absent after the short delivery window, record that it is still pending and continue reads:

```powershell
node $cli session record-delivery-pending -w $workspace --message-id $pendingMessageId --use-id $ownUseId --json
```

Every read observation uses the current task, binding, generation, epoch, pending message and iteration, with its real UTC read time. readAt is not refreshed unless another actual read occurs. A no-lease legacy pending receipt omits useId in both JSON and command; with this task's validated lease, use the same own id in both:

```powershell
$readbackFile = Join-Path $env:TEMP 'c2c-readback.json'
$readAt = $actualReadTimeFromThisHostRead
$readback = [ordered]@{ taskId=$taskId; workspaceId=$workspaceId; conversationId=$conversationId; generation=[int]$generation; assignmentEpoch=[int]$assignmentEpoch; messageId=$pendingMessageId; iteration=[int]$iteration; readAt=$readAt; result='empty'; paginationComplete=$false; useId=$ownUseId }
[IO.File]::WriteAllText($readbackFile, ($readback | ConvertTo-Json -Compress), $utf8NoBom)
node $cli session record-readback -w $workspace --observation-file $readbackFile --use-id $ownUseId --json
```

For a real matching assistant reply, save exact UTF-8 text and pass its actual IDs, iteration, state, and fields. For INIT, record the observed memory values and sources; add MEMORY_REASON only when the actual reply says DEGRADED. A weak PLAN still closes its receipt before a separate ANALYSIS request:

```powershell
$replyFile = Join-Path $env:TEMP 'c2c-reply.txt'
[IO.File]::WriteAllText($replyFile, $exactObservedAssistantBody, $utf8NoBom)
node $cli session confirm-reply -w $workspace --message-id $messageId --observed-task-id $taskId --observed-workspace-id $workspaceId --observed-iteration $iteration --state PLAN --observed-reply-file $replyFile --memory-project $memoryProject --memory-status $memoryStatus --memory-sources ($memorySources -join ',') --use-id $ownUseId --json
```

For DEGRADED add --memory-reason <actual-reason>; add --observed-review-head <actual-head> only when that exact head appears in the reply. Never prefill READY, MEMORY_SOURCES, a head, or tool evidence. Browser observations record source=browser, the actual sourceUrl and read time; omit host-turn fields.

After BOOT's matching reply, call C2C workspace_info and pass its actual fields to confirm-workspace. CONNECTOR is a local display label, not a workspace_info field:

```powershell
node $cli session confirm-workspace -w $workspace --observed-workspace-id $observedWorkspaceId --observed-route-task-id $observedRouteTaskId --observed-workspace-name $observedWorkspaceName --observed-branch $observedBranch --use-id $ownUseId --json
```

Set `$observedWorkspaceId`, `$observedRouteTaskId`, `$observedWorkspaceName`, and `$observedBranch` from the actual target `workspace_info`; CONNECTOR is not a returned field. After business verification and all pending receipts resolve, release this task's lease while preserving its Chat binding:

```powershell
node $cli session finish -w $workspace --use-id $ownUseId --json
```

## Pending messages and observations

The coordinator performs reads and confirmations; CLI does not poll in the background. At each continuation and before a new send, check pending first.

- Follow coordinatorAction. Wait no more than 60 seconds at a time. For delivery and reply separately: read every 5 seconds for the first 60 seconds, every 15 seconds afterward, then every 30 seconds after 5 minutes. Five minutes changes cadence; it is not a failure threshold. After 15 minutes diagnose host health and pagination, then keep observing while possible.
- Start each read at the latest page; follow cursors to the exact user request and matching assistant reply. idle, completed, empty pages, temporary errors, and incomplete host transcripts do not prove no reply exists.
- Record every actual read with session record-readback. A missing result updates observation only; it does not clear pending or reverse confirmed delivery. Supply actual fields only. If --use-id is supplied, it must match the observation's lease. Never invent a new timestamp to extend stale evidence.
- If guidance says read_exact_chat_in_browser, open only the exact chatUrl from get/resume in the supported browser. Verify HTTPS URL, project, conversation, request and assistant body. Browser is read-only: never send, edit, regenerate, delete, inspect private APIs, or read unrelated Chats.
- Save exact visible assistant text as UTF-8 and use confirm-reply --observed-reply-file. Record source=browser, actual sourceUrl and read time; omit host turn fields. Visibility alone is not confirmation.
- If all available readers are genuinely unavailable, record observation_blocked with errorCategory=unavailable and a concrete sanitized blockedReason. Preserve pending; report its identity, last real read time, missing capability, and next safe action. Resume the same request when observation returns. Never resend, rotate Chat, or default to local full analysis.

For a pending message whose binding is in another workspace, use receipt-only commands with --bound-workspace while retaining the source task/workspace identity. This cannot send business content. After receipt resolution, finish only this task's source lease, then migrate the same binding.

A weak PLAN is a completed receipt, not a pending message. Confirm it, assess evidence/actionability, then request missing analysis in a new ANALYSIS message. Do not keep the first receipt pending or claim execution.

## ChatGPT-first business analysis and mem

Each new C2C business task, first request after Chat rotation, and first request after workspace migration uses session prepare-init. Older Chat context never counts as current-generation mem initialization.

Create UTF-8 JSON with exactly the task goal, constraints, success criteria, repository provider/name/branch, local state, and memoryProject. Example:

    {"goal":"<short task>","constraints":"<scope and decisions>","successCriteria":"<observable result>","repository":{"provider":"gitea","name":"<owner/repo>","branch":"<branch>"},"localState":"<branch and worktree state>","memoryProject":"<registered project>"}

Reserve and generate the exact INIT:

    node "__C2C_CHECKOUT__/bin/c2c.js" session prepare-init -w <workspace> --input-file <init.json> --use-id <own-use-id> --json

Do not handwrite INIT or use begin-send for it. Send the exact returned message unchanged to the bound conversation id only. Confirm host acceptance; read the exact user message back; save that exact text in UTF-8 and run confirm-delivery with --observed-message-file so its digest matches the reservation. A mismatch preserves pending.

The request tells ChatGPT to call memory_start_task first with current goal/constraints/success criteria, the exact memoryProject, detail=standard, intent=start, mode=hybrid, and includeProjectContext=true. Use memory_search for missing history/documents. For Gitea, use codewiki_* and gitea_* read-only as needed. Use C2C read-only tools for the actual current workspace; C2C wins on conflict. Do not call memory_write_summary, Gitea write tools, or other writes without separate user authorization.

The actual reply must provide MEMORY_PROJECT, MEMORY_STATUS, MEMORY_SOURCES and, for DEGRADED, MEMORY_REASON. Record only tools actually called. READY means memory_start_task succeeded. DEGRADED requires a concrete failure reason and allows work to continue on C2C evidence; it does not claim mem analysis occurred. INIT confirmation records this result only for the current generation. EXECUTED is forbidden until that INIT is recorded; Chat, generation, or workspace changes require a new INIT.

Read-source order:
1. memory_start_task: project memory, rules and documents.
2. memory_search: specific missing historical or documentation facts.
3. codewiki_* and read-only gitea_*: Gitea Wiki, repository, Issue and current remote data.
4. C2C's eight read-only MCP tools: current workspace, uncommitted diff and execution records; final authority if facts conflict.

## Message types and REVIEW_HEAD

CLI-generated task/workspace/message ids and iteration are authoritative. Never hard-code an iteration or reuse an old message id. Keep control messages under 1 KB.

| Message or reply | REVIEW_HEAD | Confirmation and next action |
| --- | --- | --- |
| BOOT request/reply | Forbidden. | Match all receipt identities. BOOT DONE verifies connection only; confirm the actual target `workspace_info` before ready. |
| Positive/continuing reply to review-bearing INIT or ANALYSIS | Must match the requested head. | If identity, STATE, and required INIT mem fields match but the head is omitted, confirm transport only and follow `review_head_clarification_required` with a separate exact-head ANALYSIS. |
| Positive/continuing reply to review-bearing EXECUTED | Must match the requested head. | Missing or wrong head is rejected; there is no omission exception. |
| Negative `STATE: BLOCKED` or `STATE: ERROR` for any business kind, including legacy pending messages | Omission is allowed for transport confirmation; a nonempty head must still match. | Only when binding `verificationState=ready`, confirm the matching transport receipt. Task/workspace/iteration/message identity and existing INIT mem fields remain required. If the head is omitted, clear prior `lastReviewHead`; do not infer a head or approval. After normal lease and preflight requirements, `nextAction` returns to `resume_bound_chat` and `businessGate=assess_reply`; the same Chat remains reusable. Honor any ordinary next action first. Do not request a head clarification, automatically re-PLAN, or rotate it. |

The negative-reply exception applies only to a matching `BLOCKED` or `ERROR` response; it does not approve work, satisfy a review, or alter the normal head requirement for other replies. A wrong nonempty HEAD is always an identity mismatch. Confirm the reply's actual transport receipt before assessing its business meaning.

To recover an already-pending negative reply, reread the exact original assistant body in the bound Chat and refresh `record-readback` if its observation is stale. Then call `confirm-reply` for the same message id and iteration with the actual `BLOCKED`/`ERROR` state and exact observed body. If the body has no head, omit `--observed-review-head`; never copy the requested or previous head into the observation. This internal receipt repair needs no user approval and does not send BOOT, resend the pending request, or rotate the Chat. After confirmation, still follow normal lease and preflight guidance; the negative reply adds no new recovery gate.

For a weak PLAN, confirm its valid reply first, then send a separate `ANALYSIS`. For real execution results, send `EXECUTED` only after the current-generation INIT was confirmed. Use actual task, workspace, iteration, generation, message id, results, and evidence paths. Never copy an earlier message identity. The following scripts are editable templates: replace quoted sample result/evidence text with observed facts, and set `$reviewBearing`/`$reviewHead` only from the actual review request.

After fresh host preflight and exact Chat readback, run this identity preparation before either kind. Then run exactly one of the ANALYSIS or EXECUTED reservation recipes below:

```powershell
$sessionState = node $cli session get -w $workspace --use-id $ownUseId --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $sessionState.ok -or $sessionState.resolution -ne 'exact' -or $sessionState.task.pendingMessageId) { throw 'Resolve binding and pending receipt before another send' }
if ($sessionState.task.taskId -ne $taskId -or $sessionState.task.taskId -ne $env:CODEX_THREAD_ID) { throw 'Task identity mismatch' }
$workspaceId = [string]$sessionState.workspaceId
$iteration = [int]$sessionState.task.iteration + 1
$generation = [int]$sessionState.task.generation
$idResult = node $cli session new-message-id --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $idResult.ok) { throw 'Could not allocate message id' }
$messageId = [string]$idResult.messageId
$reviewHead = ''
$reviewBearing = $false
$headLine = ''
$headArgs = @()
if ($reviewBearing) {
    if ($reviewHead -notmatch '^[0-9a-f]{40}$') { throw 'A review-bearing message requires the actual full HEAD' }
    $headLine = "REVIEW_HEAD: $reviewHead"
    $headArgs = @('--review-head', $reviewHead)
}
```

For a valid but insufficient PLAN, reserve ANALYSIS:

```powershell
$analysisBody = @"
[C2C]
STATE: ANALYSIS
TASK_ID: $taskId
WORKSPACE_ID: $workspaceId
ITERATION: $iteration
MESSAGE_ID: $messageId
$headLine

GOAL: Request the missing analysis needed to resolve this review finding.
EVIDENCE: Cite only current sources and observed facts.
REQUEST: Return SOURCE_EVIDENCE, ACTIONS, TESTS, SUCCESS_CRITERIA. Do not claim execution.
"@
if ([Text.Encoding]::UTF8.GetByteCount($analysisBody) -ge 1024) { throw 'ANALYSIS body must be under 1 KB' }
$reserveArgs = @('session','begin-send','-w',$workspace,'--task-id',$taskId,'--message-id',$messageId,'--iteration',"$iteration",'--expected-generation',"$generation",'--kind','analysis','--use-id',$ownUseId) + $headArgs
$reservation = & node $cli @reserveArgs --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $reservation.ok -or -not $reservation.reserved -or $reservation.task.pendingMessageId -ne $messageId) { throw 'ANALYSIS reservation failed; do not send' }
```

For EXECUTED, run the identity preparation above again; never reuse a reserved ANALYSIS id. Populate the result and evidence fields from actual completed work, then reserve with `--kind executed`:

```powershell
$resultSummary = 'Replace with the actual change and outcome.'
$evidencePaths = 'Replace with actual source paths, test names and outputs.'
$executedBody = @"
[C2C]
STATE: EXECUTED
TASK_ID: $taskId
WORKSPACE_ID: $workspaceId
ITERATION: $iteration
MESSAGE_ID: $messageId
$headLine

RESULTS: $resultSummary
EVIDENCE: $evidencePaths
REQUEST: Inspect the current result and return PLAN, DONE, or BLOCKED with source-backed findings.
"@
if ([Text.Encoding]::UTF8.GetByteCount($executedBody) -ge 1024) { throw 'EXECUTED body must be under 1 KB' }
$reserveArgs = @('session','begin-send','-w',$workspace,'--task-id',$taskId,'--message-id',$messageId,'--iteration',"$iteration",'--expected-generation',"$generation",'--kind','executed','--use-id',$ownUseId) + $headArgs
$reservation = & node $cli @reserveArgs --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or -not $reservation.ok -or -not $reservation.reserved -or $reservation.task.pendingMessageId -ne $messageId) { throw 'EXECUTED reservation failed; do not send' }
```

After reservation succeeds, use the freshly verified exact conversation id and pass the exact body with the Codex App host tool, for example `send_message_to_thread({threadId: $sessionState.task.conversationId, prompt: $analysisBody})` (or `$executedBody`). This `threadId` is the Chat conversation id, not the Codex task's host id. Then record host acceptance and separately confirm delivery and the reply.

## Host preflight and sending

Before every new send and after a task continuation, inspect this coordinator's actual callable tools. Require read_thread and send_message_to_thread for new sends. A proxy tools/list or Tunnel health is not proof that the current task can use them. Record observed tools:

    node "__C2C_CHECKOUT__/bin/c2c.js" session host-control -w <workspace> --task-id <task-id> --use-id <own-use-id> --result probe --tools read_thread,send_message_to_thread --json

Use --tools none when neither is available, or only the real name when one is available. If read_thread exists, read the exact bound Chat and record read-ok with actual task/workspace/Chat identity. For a newly claimed Chat before BOOT, verify the exact user marker and pool owner instead. Host preflight is fresh for 60 seconds; repeat it before each send.

A missing read/send tool sets a recoverable host blocker and preserves ownership/receipts. Report task id, time, host version and missing tool names without secrets; restore host capability and continue the same task. Do not rotate credentials, restart a Tunnel, change transport, or claim another Chat because tools are absent.

ChatGPT sends/reads use exact conversation id and omit Codex hostId. Use hostId only for Codex owner task reads/snapshots. A no rollout found result means check routing parameters; it is not proof the Chat was deleted. Do not use wait_threads for ChatGPT Chats; it is for Codex task status.

## BOOT preparation and delivery

For first binding, safe rotation, migration, or valid interrupted BOOT recovery, finish preflight and run:

    node "__C2C_CHECKOUT__/bin/c2c.js" session prepare-boot -w <workspace> --expected-generation <generation> --use-id <own-use-id> --json

The output is token-free and includes binding identity, generation, assignment epoch, message id, iteration, digest, sendAllowed, next action and private messageFile path. The file is a private JSON material object; the actual BOOT message is the body property. Verify identity and digest in memory, then pass only the unchanged body string to send_message_to_thread for the exact bound conversation. Never print or log the JSON material, send the whole JSON envelope, copy the token into a command, handwrite a BOOT, add REVIEW_HEAD, or use begin-send --bootstrap. If the available runtime cannot safely read the private material without exposing it, report that blocker.

The file is outside the checkout with access limited to current user and SYSTEM on Windows; Unix uses directory 0700 and file 0600. A permission failure stops preparation. Repeated prepare-boot resumes the same preparation, body, capability, message id and iteration. A recoverable preparation is not send permission: send once only if the command succeeds, identity matches, and sendAllowed=true. If an old reservation exists, reconcile it first.

After the host accepts the send, record confirm-send-accepted. It proves acceptance only. Read the original user turn and confirm delivery with its actual iteration; do not use a fixed value such as zero. Read the matching BOOT reply, then call the target C2C workspace_info. Run confirm-workspace with observed workspaceId, routeTaskId, workspaceName and git.branch. CONNECTOR is only a local display label. Binding becomes ready only after the matching BOOT reply and actual workspace confirmation.

An accepted, delivered, waiting, or uncertain BOOT stays on its original readback; no new token, message, or Chat. Re-reservation of the same unsent BOOT requires proof the host send was never invoked via host-control --result not-invoked --confirm-not-invoked, plus fresh preflight. After workspace confirmation, private material is removed; a cleanup failure may be retried without reverting ready.

## Workspace migration handshake

Before migration, recover an existing own lease normally. If nextAction is release_own_lease_before_workspace_switch, automatically run `node $cli session finish -w $workspace --bound-workspace --use-id $ownUseId --json`, require ok=true, then get again. This fenced release is a separate transition; never execute it while a source request remains pending. A wrong/stale use-id cannot release the lease. With no active lease, switch_workspace becomes executable. Do not acquire a fresh lease before that switch.

After successful source finish, clear `$ownUseId`; that released source credential cannot authorize the destination generation. After switch-workspace, keep the same Chat and original task. The target initially has no lease. Run its fresh probe and migration-read-ok without --use-id, and omit useId from the evidence. Read the exact Chat using conversation id only and verify the registered source receipt and absence of a newer request or unfinished reply. The previous receipt remains a source-workspace fact; do not relabel it. Do not use an old-owner pool-reclaim observation as migration evidence.

Write actual observations to a UTF-8 file, omitting reviewHead if the registered source receipt had none. The fresh post-switch example below has no lease. On interruption recovery, get first: if a destination lease already exists, recover that exact private lease and append its validated useId to the observation and commands instead. Never reuse the released source id. The CLI verifies lineage, unique binding, generation, assignment epoch, no pending send, lease ownership, and read freshness under lock.

    {"taskId":"<actual-task>","conversationId":"<exact-chat>","fromWorkspaceId":"<source-id>","toWorkspaceId":"<target-id>","generation":<actual-generation>,"assignmentEpoch":<actual-epoch>,"iteration":<actual-iteration>,"messageId":"<registered-id>","state":"<registered-state>","chatReadAt":"<actual-UTC-time>","chatStatus":"idle","readbackClean":true}

    node "__C2C_CHECKOUT__/bin/c2c.js" session host-control -w <workspace> --task-id <task-id> --result probe --tools read_thread,send_message_to_thread --json
    node "__C2C_CHECKOUT__/bin/c2c.js" session host-control -w <workspace> --task-id <task-id> --result migration-read-ok --observation-file <evidence.json> --json
    node "__C2C_CHECKOUT__/bin/c2c.js" session get -w <workspace> --brief --json
    node "__C2C_CHECKOUT__/bin/c2c.js" session resume -w <workspace> --recover-own --json
    node "__C2C_CHECKOUT__/bin/c2c.js" session prepare-boot -w <workspace> --expected-generation <actual-generation> --use-id <new-destination-use-id> --json

Use the actual values, not the example. After migration-read-ok, require get=prepare_boot_required (or resume_boot_preparation), then acquire fresh destination lease after migration preflight. Require resume ok=true, save its new useId (different from the released source id), and pass that destination lease to prepare-boot, all BOOT receipts and confirm-workspace. migration_boot_ready permits only CLI-generated BOOT. Send once; complete delivery and reply readback; then actual target workspace_info and confirm-workspace; only then send business INIT.

If get/resume reports migration_workspace_confirmation_required, BOOT DONE is already delivered and confirmed; immediately do workspace_info then confirm-workspace. Do not reread the source receipt, re-probe, resend BOOT, change generation, or replace Chat. Workspace mismatch first reconciles source pending with --bound-workspace, then releases any verified own lease before switch_workspace. Missing host read/send tools must be restored before a dependent host action.

Expired migration evidence requires fresh reads. A receipt mismatch or changed candidate requires inspecting current state, not substituting expected values. Unproven history preserves state and reports the missing link. An unresolved send continues its own readback.

## Fixed Chat pool and automatic LRU rotation

Reuse the configured fixed ten-Chat inventory; do not ask for more Chats or create tasks to bypass acceptance. Check pool status rather than treating retired ledger history as live inventory. A healthy exact binding continues normally and never enters allocation. If this task has no binding, or evidence confirms its exact binding is unusable, check the pool in least-recently-used order and choose the first safe candidate. Check this task's binding before every pool claim. A prior owner is eligible only after safe readback; old ownership by itself is not a blocker. Never age out a long-lived lease.

If unassigned stock is empty, run reclaim-candidates and inspect every candidate in returned oldest-lastUsedAt order. The result is local eligibility only, not proof of host idle state:

    node "__C2C_CHECKOUT__/bin/c2c.js" session pool reclaim-candidates --json

The fixed marker is the exact user message C2C_STANDBY_READY (the UI may display C2C\_STANDBY\_READY). Import only a manually verified entry during explicit inventory setup; copy the raw marker text and marker message id from list_threads/read_thread:

    node "__C2C_CHECKOUT__/bin/c2c.js" session pool import --conversation-id <conversation-id> --project-id <project-id> --marker-message-id <marker-message-id> --marker-text <raw-user-marker-text> --json

For each candidate in order:
1. Read the exact owner task with read_thread, retaining its host id only for owner task status. It must be explicitly idle; or, if notLoaded, obtain a same-host wait_threads(timeoutMs: 0) snapshot reporting inactiveStatus and the completed latest turn. Never send the old task a wake-up message.
2. Read the precise Chat by conversation id only. It must be idle and its newest user message and completed assistant reply must match the candidate's task/workspace/iteration/last delivered message/state/review HEAD, with no newer request or incomplete answer. Follow all needed pages.
3. For notLoaded, take a second same-host immediate snapshot, again inactiveStatus with the same completed latest-turn id. Preserve raw status, each host/task identity, and actual read timestamp. Every individual read is within 60 seconds at claim time.
4. Write actual evidence to a UTF-8 JSON file outside the checkout. Never synthesize idle/clean fields or refresh timestamps without reading again. On changed candidate, continue to the next; refresh expired evidence once.

Explicit-idle evidence:

    [{"conversationId":"<candidate-chat>","workspaceId":"<candidate-workspace>","taskId":"<candidate-owner>","generation":<actual-generation>,"assignmentEpoch":<actual-epoch>,"observedAt":"<actual-UTC-time>","taskStatus":"idle","chatStatus":"idle","readbackClean":true}]

Corroborated notLoaded evidence (all listed task reads, snapshots, Chat receipt and timestamps are required):

    [{"conversationId":"<candidate-chat>","workspaceId":"<candidate-workspace>","taskId":"<candidate-owner>","generation":<actual-generation>,"assignmentEpoch":<actual-epoch>,"observedAt":"<actual-recheck-time>","taskStatus":"notLoaded","taskReadTaskId":"<owner-from-read_thread>","snapshotTaskId":"<owner-from-first-snapshot>","recheckTaskId":"<owner-from-second-snapshot>","taskReadLatestTurnId":"<same-completed-turn>","taskReadLatestTurnStatus":"completed","taskReadHostId":"<codex-owner-host-id>","snapshotHostId":"<same-host-id>","snapshotStatus":"inactiveStatus","latestTurnId":"<same-completed-turn>","latestTurnStatus":"completed","taskReadAt":"<actual-read-time>","snapshotReadAt":"<actual-first-snapshot-time>","chatStatus":"idle","readbackClean":true,"recheckHostId":"<same-host-id>","recheckSnapshotStatus":"inactiveStatus","recheckLatestTurnId":"<same-completed-turn>","recheckLatestTurnStatus":"completed","recheckReadAt":"<actual-recheck-time>","chatReadAt":"<actual-chat-read-time>","receiptIteration":<actual-iteration>,"receiptMessageId":"<registered-message>","receiptState":"<registered-state>","receiptReviewHead":"<only-if-present>"}]

Claim identifies this task; observations identify the old owner. The locked claim rechecks owner, generation, epoch, verification state, lease, pending messages, and receipt. Use:

    node "__C2C_CHECKOUT__/bin/c2c.js" session pool claim -w <workspace> --reclaim-observations-file <evidence.json> --json

After success, follow the CLI's nextAction. If leaseStatus=none, probe current host tools, read that exact Chat, verify its standby marker and ledger owner, then record read-ok without --use-id. A failed-binding recovery may carry this task's own lease: restore it when recoverable_own, then include that verified use-id in preflight and every mutation. Do not assume every successful claim is unleased. Run get again. When it returns prepare_boot_required, use session resume --recover-own to acquire this task's lease, then prepare BOOT and confirm delivery/reply/workspace before business INIT. If an active lease already belongs to this host task's unique authoritative binding, recover the same useId; the CLI rebuilds a missing, stale, or ordinary-corrupt continuation cache under lock. It does not take another task's lease. POOL_OBSERVATION_REQUIRED means local candidates need host proof; POOL_BUSY means local blockers remain, not that all owners were proven active. Exhaustion requires a reason for every candidate. Never clear another task's pending state or lease.

If the current binding is proven unusable and has no pending or uncertain send, use session pool claim with --recover-bound-file <terminal-recovery.json> plus all safe-candidate observations. Existing host-rejection evidence remains valid. A confirmed conversation length limit may also authorize recovery: read the exact Chat and preserve source=host or source=browser, terminalText, chatReadAt, observedAt, and current receipt identity; browser evidence must set sourceUrl to the exact HTTPS Chat URL on chatgpt.com or chat.openai.com with the bound conversation id in its path. The CLI accepts the new reason conversation_limit_reached only with an explicit 1–512 character length-limit message, idle/clean Chat readback, current binding/generation/lease/receipt match, and evidence no older than 60 seconds. Do not first send a message that is expected to fail. Recovery archives and quarantines the unusable binding, transfers only the first safe LRU candidate, increments generation/epoch, and revokes old capability. If the locked ledger still identifies this host task as the unique owner of its active lease, resume the same useId and rebuild the private cache after recovery; one-hop history is audit evidence, not an extra ownership gate. This is not a general lease transfer. no rollout found, timeout, empty page, missing read, and uncertain send are not terminal proof. Host and ledger observations are separate; the lock recheck narrows but cannot remove all later host-activity race.

## Router and runtime diagnosis

The control plane is Codex App background tools: list_threads, read_thread, send_message_to_thread. The data plane is the Router and its eight read-only MCP tools. Router access is per task/workspace capability; missing, wrong, revoked or cross-task route_token returns ROUTE_ACCESS_DENIED. Do not add shell, write, Git mutation, delete, or secret-reading tools; this project does not implement mem, OpenDeepWiki, or Gitea.

Check only the actual workspace:

    node "__C2C_CHECKOUT__/bin/c2c.js" router ensure -w <workspace> --json
    node "__C2C_CHECKOUT__/bin/c2c.js" transport -w <workspace> --json
    node "__C2C_CHECKOUT__/bin/c2c.js" status -w <workspace> --json
    node "__C2C_CHECKOUT__/bin/c2c.js" runtime diagnose -w <workspace> --json

workspace_not_registered and workspace_revoked are workspace conditions. Register only the intended current workspace. Corrupt Router state stops diagnostics and repair. An explicit runtime alias describes that alias, not necessarily the Router anchor.

On Windows the managed runtime uses CurrentUser DPAPI tunnel-runtime-key.dpapi and tunnel-runtime-id.dpapi under %USERPROFILE%/.config/codex-with-chatgpt. credentialState=verified means the managed key reached the exact Tunnel; invalid means an explicit 401 for that key; missing means the DPAPI source must be restored. Lookup failure is not proof that the Tunnel stopped. Do not rotate credentials, restart Router/Tunnel, or change transport as a default recovery. Follow the managed launcher only when the authorized task explicitly includes that operation.

## Evidence and completion

Confirm a reply only from its exact message id and iteration, task/workspace identity, STATE, the reply-table REVIEW_HEAD rule, and required INIT mem fields. A matching negative reply confirms transport only and leaves the business blocker for `assess_reply`; it is not review approval or task completion. Send acceptance is not delivery; delivery is not reply; reply receipt is not useful analysis; useful PLAN is not business completion. Report observed tool evidence separately from executor reports, tests, CI, and deployment.

Finish only when this task has no pending message. Check ready binding, released own lease, no pool expansion, and unchanged other task bindings. If blocked, report what was observed, what remains unknown, the pending identity, the last real read time, and the next safe recovery action.

See `__C2C_CHECKOUT__/docs/protocol.md` for field semantics and `__C2C_CHECKOUT__/docs/host-control.md` for the host/candidate contract. These files belong to the checkout, not the single-file installed Skill directory.
