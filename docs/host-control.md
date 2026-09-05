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

All failure observations preserve the permanent pool owner. Temporary host
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
