# Tool repair

Pi validates every model-emitted tool call against its TypeBox schema before execution. Valid calls run unchanged. Invalid calls either pass through a named deterministic repair and then execute with the repaired arguments, or they bounce with schema feedback when no safe repair applies.

Execution failures are not argument repairs. Pi removes their potentially large failed protocol turns from provider context and normally retains one bounded failure record: constant-size operation fingerprint, bounded operation preview, occurrence count, failure code, a cause-bearing diagnostic when available, and `next_action`. Every retained record carries `"MUST":true`; the provider receives one canonical `mandatory_tool_failure_recovery_protocol` template explaining that `repair` or `next_action` is an execution constraint, unchanged retries are gated, and unrelated argument changes are not recovery. A matching successful retry clears the record. Change-approach classes such as non-UTF-8 text edits are different: Pi discards the complete attempted operation, exposes one bounded reason/directive for the next assistant response, then expires it. A tool-owned guard can use the same one-turn path for an operation rejected before external execution; the runtime remains available, and compaction does not retain that rejected call as completed work or an open problem. Pi uses `repair` only for argument/protocol rejections with a concrete call correction; policy, preflight, abort, and execution failures use `next_action`. It never invents a deterministic repair from an unknown nonzero exit.

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
- Recovery exhaustion opens the run-scoped circuit, disables tools, and permits exactly one provider delivery turn. A tool call emitted despite that empty tool surface is paired with a rejected result without running hooks or tool code, followed by a deterministic blocker delivery.
- Repair is built-in and has no settings toggle. `PI_TOOL_REPAIR_DISABLED=1` is only an emergency diagnostic kill switch; normal configuration should leave repair on.
- Teaching can be disabled independently with `toolRepair.teach: false` or `PI_TOOL_REPAIR_TEACH_DISABLED=1`. Repairs can still execute; the in-band "Tool argument repair note" is suppressed.
- Tool-recovery logging can be disabled with `toolRepair.logging: false`. Repairs still run, but Pi does not enqueue recovery records or spawn the background recovery-log worker.
- Text tool-call protocol calibration can be enabled per model with `textToolCallProtocol: true` in `models.json`. `/toolprobe [provider/model]` probes native calls first and can persist a host-local text-protocol verdict only when native calls are absent. A persisted native verdict always keeps that model off the text protocol, including when global or model settings enable it. Use `toolRepair.textProtocol` only as a global emergency force/kill switch for models without native proof; `PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED=1` always disables it.

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

- Interactive tool panels show `[repaired arguments]` when execution used repaired arguments.
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
- `singleElementUnwrap`
- `stringifiedNumberInArray`
- `bashCommandArgvJoin`
- `bashCommandUnwrap`

Use `/toolhealth` to see probe verdicts and which modes have become learned standing rules for the active host/model. If a learned rule becomes harmful, remove that mode with `/toolrule-remove`.

## Text protocol calibration recovery

Confirmed behavior: when text tool-call protocol calibration fails for every variant, Pi stores a host-local failed record and subsequent turns for that model fail fast until an explicit reset. Use `/toolprotocol-reset <provider/model>` (or RPC `reset_tool_protocol`) after changing the model, server template, or prompt configuration.

For a previously calibrated model, repeated live parse failures invalidate the stored protocol after three matching failures. The next turn reruns calibration before using the text protocol again.

## Source map

Confirmed against current source:

- Shared validation and repair choke point: `packages/ai/src/utils/validation.ts`.
- Repair mode names and standing-rule text: `packages/ai/src/utils/tool-repair/registry.ts`.
- Agent repair event metadata and teach-note gate: `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`.
- Bounded execution-failure assessment and retry memory: `packages/agent/src/tool-failure-memory.ts`.
- Mandatory recovery template and terminal-delivery prompt: `packages/agent/src/tool-failure-recovery-protocol.ts`.
- Interactive marker: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`.
- Settings/env kill switches: `packages/coding-agent/src/core/settings-manager.ts`, `packages/coding-agent/src/core/tool-repair-settings.ts`.
- Health, tool probing, rule removal, and protocol reset: `packages/coding-agent/src/core/tool-repair-health.ts`, `packages/coding-agent/src/core/models/adaptation-store.ts`, `packages/coding-agent/src/core/slash-commands.ts`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`.
- Recovery logging, failure corpus, and replay: `packages/coding-agent/src/core/tool-recovery-logger.ts`, `packages/coding-agent/src/core/tool-recovery-log-worker.ts`, `packages/coding-agent/src/core/failure-corpus.ts`, `scripts/tool-repair-replay.mjs`.
