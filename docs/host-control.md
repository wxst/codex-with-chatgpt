# Host control and continuation

C2C Router/data plane and Codex App host-control tools are separate. The coordinator records its actual callable tools with host-control; it does not make those tools available:

    node "__C2C_CHECKOUT__/bin/c2c.js" session host-control -w <workspace> --task-id <task-id> --use-id <own-use-id> --result probe --tools read_thread,send_message_to_thread --json

Use --tools none when neither tool is exposed, or name only the tool that is present. A tools/list proxy or healthy Tunnel does not prove the current task can call host tools.

| Observation | State | Action |
| --- | --- | --- |
| read_thread missing | tools_missing | Restore host observation; preserve receipts and binding. |
| read_thread present, send_message_to_thread missing | tools_missing | Read and reconcile an existing pending request; do not reserve/send a new message. |
| Both present | readback_required | Read the exact bound Chat; then record read-ok with actual identity. |
| Host timeout or temporary error | call_timeout / call_failed | Keep any uncertain send and reconcile the same Chat. |
| Send tool provably never invoked | not_invoked | Re-reserve only the same unsent preparation after fresh preflight. |
| Explicit deletion or identity mismatch | conversation_gone / identity_mismatch | Use matching terminal recovery after the current request is resolved. |
| Tunnel unhealthy | runtime diagnosis | Diagnose the data plane separately; no automatic restart. |

## Lease ownership

get, resume, and host-control use one recovery decision. Run the read-only status command first:

    node "__C2C_CHECKOUT__/bin/c2c.js" session get -w <workspace> --brief --json

get never returns useId. leaseStatus values mean:

- none: no active lease; follow nextAction without assuming that lease acquisition is the first step.
- own: the supplied known use id matches this task.
- recoverable_own: the real `CODEX_THREAD_ID` matches this task's unique authoritative ledger/pool owner and active lease.
- ownership_unproven: caller task identity is missing or cannot be matched to a unique authoritative owner; a missing continuation cache alone never causes this status.
- conflict: a supplied use id or authoritative binding/pool identity conflicts with current task state.

A continuation file is a restricted cache, not a second ownership authority. If this host task owns the unique authoritative binding and active lease, `resume --recover-own` restores the same useId and repairs a missing, stale, or ordinarily corrupt cache under the session lock. Unsafe paths or permissions are reported as storage-safety errors, not another coordinator's ownership. A blocked get/resume/host-control response never returns a lease id. For leaseStatus=none, follow nextAction: an old pending request can be read and confirmed without --use-id; missing preflight is probed and the exact Chat is read before obtaining a lease. Acquire only when the next authorized action needs one (ready continuation or a lease-fenced preparation/send), using `resume --recover-own` to acquire and persist a new lease (plain `resume` remains compatible). For `recoverable_own`, recover the existing lease with `resume --recover-own`; this mode requires the host-provided `CODEX_THREAD_ID`. A caller with a verified known own id may use `resume --use-id <known-own-id>`:

    node "__C2C_CHECKOUT__/bin/c2c.js" session resume -w <workspace> --recover-own --json

On success, resume returns this task's useId. A caller that already knows its own current id can use resume --use-id <known-own-use-id>. Never copy a useId from the ledger, another task, or blocked output. Preserve genuine identity/ledger conflicts; do not force-takeover or clear by age.

Every state-changing receipt command, including host-control and record-readback, receives this task's verified --use-id when it holds a lease. An observation may omit useId if the command supplies it; if both have a value, they must match. When the ledger has no active lease, omit --use-id. Terminal binding recovery can retain this task's lease when the actual host task and post-commit unique authoritative owner still match; the cache is rebuilt from current ledger identity. One-hop `binding_recovered` history remains audit evidence, not an extra ownership gate. This is not a general transfer. Ordinary workspace migration keeps the Chat and requires releasing this task's lease first.

## Readback and direct Chat routing

If read_thread is present, a missing send_message_to_thread does not block reads of an existing pending message. Read and record that request; confirm it only through the normal identity-checked receipt command. Do not reserve or send a new message until both tools and fresh preflight are available. If read_thread is missing, restore it before receipt confirmation. The supported browser is a read-only alternate observer only when shared guidance returns read_exact_chat_in_browser.

ChatGPT conversation operations use the exact conversation id and omit Codex hostId. hostId is only for reading or snapshotting the Codex owner task. A no rollout found error is a routing clue, not proof the Chat was deleted. Do not use wait_threads for ChatGPT Chats.

After restoring tools, probe the current inventory and read the existing Chat before any new send. Preflight is fresh for at most 60 seconds before sending. If a pending user request exists, locate its exact user turn and matching reply, including older pages. Empty/truncated reads, completed host turns, and idle Chats do not prove the request was not sent or answered.

Record confirm-send-accepted only after the send tool returns; this means host acceptance, not delivery. Confirm delivery only after the exact user turn appears; confirm reply only after the matching assistant response appears. Delivery and reply have separate schedules: every 5 seconds during the first minute, every 15 seconds afterward, and every 30 seconds after 5 minutes. Wait no more than 60 seconds at a time. At 15 minutes diagnose host health and pagination, then keep waiting while observation is possible.

For every actual read, use session record-readback --observation-file <UTF-8 JSON> and include --use-id <own-use-id> only when this task holds a lease. readAt is the actual UTC read time. Task, workspace, Chat, generation, assignment epoch, message id and iteration must match the current pending receipt. Preserve unknown host fields as unknown. An empty page, timeout, or read failure updates only the observation; it cannot clear pending or reverse confirmed delivery.

If guidance returns read_exact_chat_in_browser, open only the exact chatUrl from get/resume. Verify HTTPS, project, conversation, request and assistant body. Record source=browser, actual sourceUrl and read time; omit host-turn fields. Save the exact assistant text as UTF-8 and confirm with confirm-reply --observed-reply-file. Browser visibility alone is not a receipt. Never send, edit, regenerate, delete, read unrelated Chats, or call private Chat APIs from the browser.

When observation is impossible after checking available tools and pagination, record observation_blocked, errorCategory=unavailable and a sanitized reason. Preserve pending and report its identity and missing observation capability. Resume the same message when reading returns. This does not authorize resend, Chat rotation, or local substitution for required ChatGPT analysis.

## Fixed pool and safe reuse

Reuse the configured ten-Chat pool; do not ask the user for more standby Chats. session pool reclaim-candidates --json lists locally eligible candidates in least-recently-used order with owner, workspace, generation, assignment epoch, receipt, and exclusion reasons. It is not host idle proof. Prior ownership by itself is not a reason to exclude a candidate.

Check every local candidate from oldest lastUsedAt onward:
1. Read the exact owner task. Explicit idle is acceptable. notLoaded requires a same-host immediate wait_threads(timeoutMs: 0) snapshot with inactiveStatus and a completed latest turn.
2. Read the exact conversation id without Codex hostId. Require idle Chat and a clean latest user request/reply matching ledger task, workspace, iteration, last delivered message, state, and review head when present. Follow pagination.
3. For notLoaded, take a second same-host immediate snapshot. Require inactiveStatus and the same completed latest-turn id. Preserve all raw states, host/task identities, receipt fields, and actual read times. Every read must be within 60 seconds at claim time.
4. Pass actual observations as UTF-8 JSON to session pool claim --reclaim-observations-file <file>. The locked claim rechecks ownership, generation, epoch, verification, lease, pending and receipt. Candidate change means move to the next candidate; stale evidence permits one refresh.

A bare notLoaded, unavailable read, identity mismatch, pending message, active lease, or active Chat is not safe reclaim evidence. Never clear another task's pending or lease. POOL_OBSERVATION_REQUIRED means host evidence is still needed; POOL_BUSY means local candidates are blocked. Report every candidate's actual reason before reporting exhaustion.

After a successful rotation, obtain this task's lease when nextAction permits it, run fresh host preflight, use prepare-boot, confirm delivery and reply, call workspace_info, then confirm-workspace before business INIT.

A bound Chat can be replaced after either the existing correctly routed explicit host rejection or a confirmed conversation length limit, provided the exact Chat is idle/clean, the current receipt matches, there is no pending or uncertain send, and safe LRU candidate evidence is complete. For `conversation_limit_reached`, pass `--recover-bound-file` with current task/workspace/conversation/generation and optional own lease, current receipt identity, actual `chatReadAt` and `observedAt`, `chatStatus:"idle"`, `readbackClean:true`, `source:"host"|"browser"`, and `terminalText` (1–512 chars) explicitly showing the length limit. Browser source also requires the exact HTTPS URL on `chatgpt.com` or `chat.openai.com` whose path contains the bound conversation id; host source omits `sourceUrl`. The CLI checks all observation times are within 60 seconds and rechecks lease, binding, generation, receipt, pending, and uncertain send under lock. Do not intentionally send a message to provoke rejection. `binding_recovered` retains the same task's lease only when this host task and the post-commit unique authoritative owner match; its continuation cache is rebuildable and history remains an audit trail. `no rollout found`, timeout, empty page, missing reads, and uncertain sends are not terminal proof. The locked ledger recheck narrows the host race but cannot eliminate later activity.

## Migration and BOOT confirmation

Migration evidence keeps the source workspace identity. Use migration-read-ok --observation-file <file> only after fresh host preflight, exact Chat read, and a clean matching source receipt. The CLI verifies lineage, unique owner, generation, epoch, pending state, lease and read freshness under lock. If the registered source receipt has no REVIEW_HEAD, omit it.

migration_boot_ready allows only CLI-generated BOOT. Release the source lease before switch-workspace and discard that use id. The new destination generation begins without a lease: probe and migration-read-ok omit --use-id and the observation omits useId. After preflight, get must return prepare_boot_required or resume_boot_preparation; resume --recover-own obtains the fresh destination lease. Only that new verified id is passed to prepare-boot and subsequent receipts/workspace confirmation. On interrupted destination recovery, restore its existing private lease instead. Read private messageFile JSON in memory, validate it and send only its body. pool claim and switch-workspace do not issue or return route tokens. Send only after prepare-boot succeeds with sendAllowed=true.

If preparation or output was interrupted, prepare-boot resumes the same private material and identity. If send may have been invoked, read the same Chat. Only proof the send tool was never called, followed by fresh preflight, allows re-reservation of that same BOOT. Accepted, delivered, waiting, and uncertain messages stay on readback.

When BOOT has a matching delivered DONE and no pending request, immediately call target workspace_info then confirm-workspace using its actual workspaceId, routeTaskId, workspaceName and git.branch. Do not reread the source receipt, resend, change generation, or replace Chat. Only this actual confirmation makes the binding ready.

BOOT cannot carry REVIEW_HEAD; reconcile a legacy malformed BOOT only from exact existing readback. For business replies, follow the single message/reply table in the source Skill. Once binding `verificationState=ready`, a matching BLOCKED/ERROR confirms transport without REVIEW_HEAD for every kind, including legacy pending; INIT mem and all identity checks still apply. Missing HEAD clears stale lastReviewHead, grants no approval, and keeps `businessGate=assess_reply` with a recovery reason identifying the negative receipt. After ordinary lease/preflight requirements, nextAction returns to resume_bound_chat; honor any ordinary prerequisite action first. For an existing pending response, reread its exact original Chat body and confirm the same message id/iteration; omit --observed-review-head when absent and never substitute the requested or previous head. This internal repair needs no user approval, BOOT, resend, or Chat replacement. A wrong nonempty HEAD is rejected. Positive/continuing review-bearing replies retain their normal exact-head and `review_head_clarification_required` rules; BOOT identity/workspace checks are unchanged.

## Router and runtime diagnosis

The Router exposes exactly eight read-only C2C tools; it has no shell, Git mutation, write, delete, or secret-read capability. Each tool requires a task-bound route_token. Mem, OpenDeepWiki, and Gitea are external read sources, not Router implementations.

Run diagnostics against the actual workspace:

    node "__C2C_CHECKOUT__/bin/c2c.js" router ensure -w <workspace> --json
    node "__C2C_CHECKOUT__/bin/c2c.js" transport -w <workspace> --json
    node "__C2C_CHECKOUT__/bin/c2c.js" status -w <workspace> --json
    node "__C2C_CHECKOUT__/bin/c2c.js" runtime diagnose -w <workspace> --json

workspace_not_registered and workspace_revoked are workspace conditions. Corrupt Router registration stops diagnosis and repair. An explicit runtime alias describes that alias, not necessarily the anchor. On Windows the managed runtime uses CurrentUser DPAPI tunnel-runtime-key.dpapi and tunnel-runtime-id.dpapi under %USERPROFILE%/.config/codex-with-chatgpt. credentialState=verified means the managed key reached the exact Tunnel; invalid means the corresponding explicit 401; missing means restore the DPAPI source. Lookup failure is not proof the Tunnel stopped. Runtime/credential changes and restarts are not default recovery; do them only when the current authorized scope includes them.
