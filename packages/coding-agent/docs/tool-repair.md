# Tool repair

Pi validates every model-emitted tool call against its TypeBox schema before execution. Valid calls run unchanged. Invalid calls either pass through a named deterministic repair and then execute with the repaired arguments, or they bounce with schema feedback when no safe repair applies.

Execution failures are not argument repairs. Pi removes their potentially large failed protocol turns from provider context and normally retains one bounded failure record: constant-size operation fingerprint, bounded operation preview, occurrence count, failure code, a cause-bearing diagnostic when available, and `next_action`. Every retained record carries `"MUST":true`; the provider receives one canonical `mandatory_tool_failure_recovery_protocol` template explaining that `repair` or `next_action` is an execution constraint, unchanged retries are gated, and unrelated argument changes are not recovery. A successful exact retry clears its record. Any successful tool result or a new owner turn advances the recovery world and re-admits previously failed exact operations; an operation that fails again is refused again until the next advance. Change-approach classes such as non-UTF-8 text edits are different: Pi discards the complete attempted operation, exposes one bounded reason/directive for the next assistant response, then expires it. A tool-owned guard can use the same one-turn path for an operation rejected before external execution; the runtime remains available, and compaction does not retain that rejected call as completed work or an open problem. Pi uses `repair` only for argument/protocol rejections with a concrete call correction; policy, preflight, abort, and execution failures use `next_action`. It never invents a deterministic repair from an unknown nonzero exit.

Canonical execution-failure template:

```json
{
  "MUST": true,
  "failure_key": "<bounded operation identity>",
  "state": "failed",
  "phase": "execution",
  "tool": "<tool name>",
  "failure_code": "<classified cause>",
  "diagnostic": "<bounded cause-bearing detail>",
  "next_action": "<mandatory capability-backed recovery or blocker delivery>"
}
```

## Runtime behavior

- The shared validation choke point is `validateToolArguments` in `packages/ai/src/utils/validation.ts`.
- Repair is validate-then-repair: schema-valid arguments are returned unchanged; only invalid arguments enter the repair layer.
- The execution gate refuses only the exact unchanged operation whose last run was unproductive. Unrelated tools and materially changed calls remain available. Any successful tool result or a new owner turn advances the world and re-admits it; internal custom continuation messages do not impersonate owner turns. Refused calls retain tool-result pairing but run no hooks or tool code. Only the bounded repeated-signature and provider-turn cost guards can stop a wedged run.
- Repair is built-in and has no settings toggle. `PI_TOOL_REPAIR_DISABLED=1` is only an emergency diagnostic kill switch; normal configuration should leave repair on.
- Teaching can be disabled independently with `toolRepair.teach: false` or `PI_TOOL_REPAIR_TEACH_DISABLED=1`. Repairs can still execute; the in-band "Tool argument repair note" is suppressed.
- Tool-recovery logging can be disabled with `toolRepair.logging: false`. Repairs, protocol-health accounting, and standing-rule teaching still run; Pi only skips recovery-log records and the background recovery-log worker.
- Text tool-call protocol calibration can be enabled per model with `textToolCallProtocol: true` in `models.json`. `/toolprobe [provider/model]` grades native task-scale and echo calls first. When native calls are absent, each text dialect must round-trip both an echo and an exact nested multiline edit payload before Pi persists it. A persisted native verdict always keeps that model off the text protocol, including when global or model settings enable it. Use `toolRepair.textProtocol` only as a global emergency force/kill switch for models without native proof; `PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED=1` always disables it.
- Every bounced text-protocol call contributes protocol-health evidence, even when a valid sibling appears in the same assistant batch. Evidence is isolated by model, dialect, and failure class; a clean parsed turn ends the current in-memory failure episode. Repeated bounced repair shapes also feed the same bounded per-model standing-rule system as locally repaired calls.
- The third identical validation bounce receives the live bounded schema and a validator-safe example in provider-visible tool feedback. Malformed JSON feedback retains a bounded offset and nearby source context when the serving runtime supplies it.

Example project settings:

```json
{
  "toolRepair": {
    "teach": true,
    "textProtocol": true,
    "logging": true
  }
}
```

## Visible signals

- Expanded Ctrl+T action details show `[repaired arguments]` when execution used repaired arguments.
- RPC `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events include a `repair` object when arguments were repaired.
- `/toolhealth` prints model adaptation records for this host: tool-probe verdicts, calibrated or failed text protocol, learned standing rules, teach statistics, recovery-log worker counters, and execution-failure counts by phase.
- `/toolrule-remove <provider/model> <mode>` removes one learned standing rule from the host-local adaptation store.
- `/toolprotocol-reset <provider/model>` removes a stored text protocol calibration or failed-calibration record so the next turn can calibrate again.
- `/toolprobe [provider/model]` probes the current fleet or one explicit model for native tool calls first, then text-protocol fallback, persists the verdict in the host-local adaptation store, and prints a report table.
- RPC exposes the same controls through `get_tool_repair_health`, `tool_probe`, `remove_tool_repair_rule`, and `reset_tool_protocol`.

## Replay new failure shapes

Pi records sanitized validation-bounce shapes in the failure corpus and can replay them offline:

```bash
node scripts/tool-repair-replay.mjs ~/.pi/agent/state/failure-corpus.jsonl
node scripts/tool-repair-replay.mjs ~/.pi/agent/state/failure-corpus.jsonl --json
node scripts/tool-repair-replay.mjs ~/.pi/agent/sessions/<session>.jsonl --fixtures /tmp/tool-repair-fixtures.json
```

The replay helper reads `tool_validation` corpus records and legacy bounced `tool_argument_validation` session entries. Current recovery telemetry is written by a dedicated `node:worker_threads` worker to `state/tool-recovery-events.jsonl`; bounced calls append sanitized `tool_validation` corpus rows, while rejected or failed executions append bounded `tool_execution` rows with phase, failure code, optional redacted diagnostic, and next action. Records do not store full tool arguments.

## Repair modes

The repair registry currently names these deterministic modes:

- `nullOptionalDrop`
- `nullRequiredBounce`
- `jsonStringParse`
- `jsonObjectPropertySalvage`
- `singleObjectWrap`
- `bareScalarWrap`
- `emptyObjectPlaceholder`
- `numberFromString`
- `boolFromString`
- `enumCaseNormalize`
- `propertyCaseNormalize`
- `propertyAliasNormalize`
- `singleElementUnwrap`
- `stringifiedNumberInArray`
- `bashCommandArgvJoin`
- `bashCommandUnwrap`

Use `/toolhealth` to see probe verdicts and which modes have become learned standing rules for the active host/model. If a learned rule becomes harmful, remove that mode with `/toolrule-remove`.

## Text protocol calibration recovery

When probing finds neither a task-capable native route nor a text dialect that passes both calibration tasks, Pi stores a host-local `none` verdict. Later non-routed turns do not silently retry the failed text dialect or an unproven native route: the provider request gets a bounded no-route instruction and no tools, and the session's exact active tool surface is restored when that run settles. Run `/toolprobe <provider/model>` again after changing the model, server template, or provider conditions. An explicit `toolRepair.textProtocol: true` remains the operator override.

For a previously calibrated model, three live failures of the same model/dialect/failure class within one failure episode invalidate the stored protocol and persist a `none` verdict. Interleaved failure classes are counted independently, a valid sibling cannot erase a bounce, and only a clean parsed turn resets the volatile episode evidence.

## Source map

Confirmed against current source:

- Shared validation and repair choke point: `packages/ai/src/utils/validation.ts`.
- Repair mode names and standing-rule text: `packages/ai/src/utils/tool-repair/registry.ts`.
- Agent repair event metadata and teach-note gate: `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`.
- Bounded execution-failure assessment and retry memory: `packages/agent/src/tool-failure-memory.ts`.
- Mandatory recovery template: `packages/agent/src/tool-failure-recovery-protocol.ts`.
- Operation-local replay admission and transcript restoration: `packages/agent/src/tool-failure-recovery-gate.ts`.
- Interactive marker: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`.
- Settings/env kill switches: `packages/coding-agent/src/core/settings-manager.ts`, `packages/coding-agent/src/core/tool-repair-settings.ts`.
- Health, tool probing, rule removal, and protocol reset: `packages/coding-agent/src/core/tool-repair-health.ts`, `packages/coding-agent/src/core/models/adaptation-store.ts`, `packages/coding-agent/src/core/slash-commands.ts`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`.
- Recovery logging, failure corpus, and replay: `packages/coding-agent/src/core/tool-recovery-logger.ts`, `packages/coding-agent/src/core/tool-recovery-log-worker.ts`, `packages/coding-agent/src/core/failure-corpus.ts`, `scripts/tool-repair-replay.mjs`.
