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
claiming a Chat just to save a host observation. A different worktree's existing
owner is not transferable. A completed host turn with no readable messages is
an observation gap; neither completion metadata nor another task's available
tools proves consumer recovery.

## Continuation and fixed-pool reuse

Begin a normal continuation with `session resume --brief --json`, not a Router
diagnosis or pool scan. The resolver first finds the current task's exact
binding. A unique binding in another workspace returns
`workspace_switch_required`; after a fresh exact Chat readback, use
`session switch-workspace` to move that same binding. Do not move a worktree,
change the task id, or claim another Chat to work around the path change.

The ten live pool entries are reusable only when a candidate is locally ready,
has no pending/accepted/uncertain delivery and no active coordinator lease, and
has a fresh 60-second host observation proving both task and Chat idle plus a
clean readback. The CLI accepts that structured observation; it does not pretend
to call Codex App tools itself. Use `session pool reclaim-candidates --json`
when unclaimed stock is empty. It returns local candidates in least-recently-used
order, receipt identities, and exclusion reasons without exposing route tokens.
`POOL_OBSERVATION_REQUIRED` means a local candidate still needs host proof;
`POOL_BUSY` means local candidates are blocked. Neither means that all owner tasks
were observed busy by the host.

For each local candidate, read the exact owner task and exact Chat, verify both
are idle and the latest user/reply identity matches the candidate's registered
receipt with no newer request. Immediately pass the complete `ReclaimObservation`
array through `session pool claim --reclaim-observations-file <UTF-8 JSON path>`.
The legacy inline option remains supported; the two inputs are mutually exclusive.
The locked claim rejects stale ownership, epoch, leases, pending states and
observations older than 60 seconds. If a candidate changes, inspect remaining
candidates instead of forcing takeover. Missing or failed host reads are not idle
proof. Exhaustion of this pass must report its actual exclusion/readback reasons.

See the installed Skill's **Mandatory rotation when unclaimed stock is empty**
for the complete host sequence and JSON example. After rotation, the new owner
must complete BOOT and workspace verification before task content is sent.
`session finish` releases the active lease but keeps the same task binding.

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
