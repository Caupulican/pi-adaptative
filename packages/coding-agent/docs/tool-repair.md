# Tool repair

Pi validates every model-emitted tool call against its TypeBox schema before execution. Valid calls run unchanged. Invalid calls either pass through a named deterministic repair and then execute with the repaired arguments, or they bounce with schema feedback when no safe repair applies.

## Runtime behavior

- The shared validation choke point is `validateToolArguments` in `packages/ai/src/utils/validation.ts`.
- Repair is validate-then-repair: schema-valid arguments are returned unchanged; only invalid arguments enter the repair layer.
- Repair can be disabled independently from teaching with `toolRepair.repair: false` or `PI_TOOL_REPAIR_DISABLED=1`. When repair is disabled, invalid calls bounce instead of executing repaired arguments.
- Teaching can be disabled independently with `toolRepair.teach: false` or `PI_TOOL_REPAIR_TEACH_DISABLED=1`. Repairs can still execute; the in-band "Tool argument repair note" is suppressed.
- Text tool-call protocol calibration can be enabled per model with `textToolCallProtocol: true` in `models.json`. Use `toolRepair.textProtocol` only as a global emergency force/kill switch; `PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED=1` always disables it.

Example project settings:

```json
{
  "toolRepair": {
    "repair": true,
    "teach": true,
    "textProtocol": true
  }
}
```

## Visible signals

- Interactive tool panels show `[repaired arguments]` when execution used repaired arguments.
- RPC `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` events include a `repair` object when arguments were repaired.
- `/toolhealth` prints model adaptation records for this host: calibrated or failed text protocol, learned standing rules, and teach statistics.
- `/toolrule-remove <provider/model> <mode>` removes one learned standing rule from the host-local adaptation store.
- `/toolprotocol-reset <provider/model>` removes a stored text protocol calibration or failed-calibration record so the next turn can calibrate again.
- RPC exposes the same controls through `get_tool_repair_health`, `remove_tool_repair_rule`, and `reset_tool_protocol`.

## Replay new failure shapes

Pi records sanitized validation-bounce shapes in the failure corpus and can replay them offline:

```bash
node scripts/tool-repair-replay.mjs ~/.pi/agent/state/failure-corpus.jsonl
node scripts/tool-repair-replay.mjs ~/.pi/agent/state/failure-corpus.jsonl --json
node scripts/tool-repair-replay.mjs ~/.pi/agent/sessions/<session>.jsonl --fixtures /tmp/tool-repair-fixtures.json
```

The replay helper reads `tool_validation` corpus records and bounced `tool_argument_validation` session entries. Records contain shape metadata, failure modes, and error keywords; they do not store full tool arguments.

## Repair modes

The repair registry currently names these deterministic modes:

- `nullOptionalDrop`
- `nullRequiredBounce`
- `jsonStringParse`
- `singleObjectWrap`
- `bareScalarWrap`
- `emptyObjectPlaceholder`
- `numberFromString`
- `boolFromString`
- `enumCaseNormalize`
- `singleElementUnwrap`
- `stringifiedNumberInArray`
- `bashCommandArgvJoin`
- `bashCommandUnwrap`

Use `/toolhealth` to see which modes have become learned standing rules for the active host/model. If a learned rule becomes harmful, remove that mode with `/toolrule-remove`.

## Text protocol calibration recovery

Confirmed behavior: when text tool-call protocol calibration fails for every variant, Pi stores a host-local failed record and subsequent turns for that model fail fast until an explicit reset. Use `/toolprotocol-reset <provider/model>` (or RPC `reset_tool_protocol`) after changing the model, server template, or prompt configuration.

For a previously calibrated model, repeated live parse failures invalidate the stored protocol after three matching failures. The next turn reruns calibration before using the text protocol again.

## Source map

Confirmed against current source:

- Shared validation and repair switch: `packages/ai/src/utils/validation.ts`.
- Repair mode names and standing-rule text: `packages/ai/src/utils/tool-repair/registry.ts`.
- Agent repair event metadata and teach-note gate: `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`.
- Interactive marker: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`.
- Settings/env kill switches: `packages/coding-agent/src/core/settings-manager.ts`, `packages/coding-agent/src/core/tool-repair-settings.ts`.
- Health, rule removal, and protocol reset: `packages/coding-agent/src/core/tool-repair-health.ts`, `packages/coding-agent/src/core/models/adaptation-store.ts`, `packages/coding-agent/src/core/slash-commands.ts`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`.
- Failure corpus and replay: `packages/coding-agent/src/core/failure-corpus.ts`, `scripts/tool-repair-replay.mjs`.
