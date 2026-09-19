# Host control availability

C2C issue #4 separates the Codex coordinator's control tools from the read-only
Router/Tunnel data plane. The coordinator records observed callable names with
`session host-control --result probe --tools <comma-separated names|none>`.
This command records an observation; it does not discover or call host tools.
The standalone `verify:codex-app-host` checks the proxy inventory only and is
not proof of model-visible tools or ChatGPT delivery.

| Observation | Status | Action |
| --- | --- | --- |
| read and/or send not exposed | tools_missing | Restore host capabilities, preserve binding |
| both exposed | readback_required | Read exact saved Chat and verify identity |
| exact readback after probe | ready | Resume receipt checks, or reserve if no pending message |
| host invocation timeout | call_timeout | Keep uncertain send; read before any retry |
| other temporary call failure | call_failed | Same conservative recovery |
| proven send never invoked | not_invoked | Release matching unaccepted reservation only |
| explicit Chat deletion | existing conversation_gone | Retire via terminal handling |
| mismatching Chat identity | existing identity_mismatch | Quarantine via terminal handling |
| unhealthy Tunnel | runtime diagnosis | Diagnose data plane independently |

All failure observations preserve the current pool owner. Temporary host
failures set `channelState: degraded` without removing pending receipt fields.
Recovery derives `sending` versus `awaiting_reply` from those fields; it never
infers delivery from restored capability. Uncertain invocation is sticky across
probes. Lack of `sendAcceptedAt` alone never proves a call was not made.
An explicit `host_rejected` result conflicting with an existing acceptance or
delivery receipt is rejected; preserve the reservation and read the original
Chat. Failure JSON retains observed acceptance/delivery facts. A successful
readback after an uncertain send may therefore have `accepted: false` and
`delivered: true` (no host acknowledgement was recorded).

The CLI requires a preflight no older than 60 seconds. Existing library callers
without a host observation remain compatible; once present, a non-ready host
observation blocks `beginTaskSend`, including `--probe` recovery attempts.
The coordinator must repeat preflight after continuation and before each send;
persisted readiness alone is not evidence of the current executor inventory.

See the [Skill](../skill/SKILL.md#host-control-preflight-and-recovery) for commands
and HEAD-specific review rules. Report missing tools to Codex feedback/support
with host version, timestamp, task id and tool names. Never include credentials,
route tokens, or private message bodies. C2C cannot fix host tool injection.

An unbound task reports its actual tool inventory without creating an owner or
claiming a Chat just to save a host observation. Another task's existing
owner cannot be imported. A completed host turn with no readable messages is
an observation gap; neither completion metadata nor another task's available
tools proves consumer recovery.

## Continuation and fixed-pool reuse

Begin a normal continuation with `session resume --brief --json`, not a Router
diagnosis or pool scan. The resolver first finds the current task's exact
binding. A unique binding in another workspace returns
`workspace_switch_required`; after a fresh exact Chat readback, use
`session switch-workspace` to move that same binding. Do not move a worktree,
change the task id, or claim another Chat to work around the path change.

If that source binding has pending, the shared decision is instead
`reconcile_source_pending`. The source receipt commands support `--bound-workspace`
from the current checkout, retaining the exact task and old workspace identities.
After normal confirmation, release only your own source lease with the same flag
on finish, then migrate. No send command accepts this override.

Fresh idle/terminal host reads that omit a phase receipt trigger
`read_exact_chat_in_browser`. Read only the get/resume `chatUrl` in a supported
browser and record source=browser, the final exact URL, and the actual read time.
Do not copy host turn metadata into browser observations. If visible, validate the
assistant body with normal confirm-reply --observed-reply-file; INIT delivery still
requires the exact user body digest. The browser is a second observer, not another
send surface. No private APIs, regeneration, edits, clearing pending or Chat replacement.
If no browser page can be observed, record the concrete observer blocker without
inventing a URL; pending remains intact.

The ten live pool entries are reusable only when a candidate is locally ready,
has no pending/accepted/uncertain delivery and no active coordinator lease, and
has a fresh 60-second host observation proving an idle owner task or a fully
corroborated `notLoaded` owner task, plus an idle exact Chat and clean readback.
A bare `notLoaded` result is insufficient. The CLI accepts that structured
observation; it does not pretend to call Codex App tools itself. Use `session pool
reclaim-candidates --json` when unclaimed stock is empty. It returns local
candidates in least-recently-used order, receipt identities, and exclusion reasons
without exposing route tokens. `POOL_OBSERVATION_REQUIRED` means a local candidate
still needs host proof; `POOL_BUSY` means local candidates are blocked. Neither
means that all owner tasks were observed busy by the host.

For each local candidate, read the exact owner task and exact Chat. When the task
reads `notLoaded`, take a same-host immediate `wait_threads(timeoutMs: 0)`
snapshot and require `inactiveStatus` with a completed latest turn; then, after the
Chat receipt check, take one more same-host snapshot with the same completed turn.
Record each read timestamp, host id, turn id/status, and the receipt fields shown
by the Chat. Immediately pass the complete `ReclaimObservation` array through
`session pool claim --reclaim-observations-file <UTF-8 JSON path>`. The legacy
inline option remains supported; the two inputs are mutually exclusive. The locked
claim rejects stale ownership, epoch, leases, pending states, changed receipt, or
any individual read older than 60 seconds. If a candidate changes, inspect
remaining candidates instead of forcing takeover; refresh only expired evidence
once. Missing or failed host reads are not idle proof. Exhaustion of this pass must
report every actual exclusion/readback reason.

See the installed Skill's **Mandatory rotation when unclaimed stock is empty**
for the complete host sequence and JSON example. After rotation, the new owner
must complete BOOT and workspace verification before task content is sent.
`session finish` releases the active lease but keeps the same task binding.

BOOT carries no `REVIEW_HEAD`; the CLI rejects that combination. If an older
client already left a delivered BOOT with an erroneous pending review head, read
the exact existing request and reply and run the normal receipt commands. Matching
BOOT identity automatically reconciles the reply and discards the erroneous head,
after which actual `workspace_info` is still required. Do not resend it or ask
the user to authorize C2C-internal recovery.

The coordinator automatically checks every LRU candidate before reporting pool
exhaustion; it never asks the user for additional standby Chats. A prior owner's
binding alone is not a busy condition. ChatGPT sends/readbacks use the exact
conversation id without `hostId`; only Codex owner reads use host routing.
After `no rollout found`, check this distinction before classifying the Chat.
If a correctly routed send is explicitly rejected and the current Chat is idle
with no unresolved receipt, use `pool claim --recover-bound-file` together with
the first safe candidate's observations. See the Skill for the exact JSON and
commands. This retains the fixed inventory and archives old receipts; it does not
authorize taking busy Chats or replacing a binding after an uncertain send.

`status` and `runtime diagnose` report `workspaceRegistration` independently of
the global anchor's health. Unregistered/revoked workspaces return
`workspace_not_registered`/`workspace_revoked`; they do not cause the CLI to
invent a per-workspace runtime alias. `runtimeAliasSource: explicit` identifies
an explicitly selected alias. Runtime lookup failures preserve any successful
managed credential validation. Register only the actual execution workspace
when intended; diagnose does not register, and runtime repair commands reject
unregistered/revoked workspaces before modifying anchor configuration.
Malformed, unreadable or duplicate Router registrations stop diagnostics and
repair with `router_state_invalid` or `router_state_unavailable`; they cannot
select legacy mode. `runtime diagnose` top-level `ok` also requires the selected
runtime to be available, running, healthy, ready, non-stale and free of errors.

### Migrated workspace

An old-workspace receipt is valid historical evidence, not proof of the new
workspace. Use `migration-read-ok --observation-file` after tool probe and exact
Chat read. `migration_boot_ready` is limited to new BOOT, is consumed by reservation,
and requires current expected generation. Finish normal delivery/reply readback
and actual workspace_info confirmation before business messages. Never report an
expected new workspace ID as observed in an old message. Preserve unresolved
sends; migration does not waive receipt or lease protection.
