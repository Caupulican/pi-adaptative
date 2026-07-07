# Tool repair

Pi validates every model-emitted tool call against its TypeBox schema before execution. Valid calls run unchanged. Invalid calls either pass through a named deterministic repair and then execute with the repaired arguments, or they bounce with schema feedback when no safe repair applies.

## Runtime behavior

- The shared validation choke point is `validateToolArguments` in `packages/ai/src/utils/validation.ts`.
- Repair is validate-then-repair: schema-valid arguments are returned unchanged; only invalid arguments enter the repair layer.
- Repair can be disabled independently from teaching with `toolRepair.repair: false` or `PI_TOOL_REPAIR_DISABLED=1`. When repair is disabled, invalid calls bounce instead of executing repaired arguments.
- Teaching can be disabled independently with `toolRepair.teach: false` or `PI_TOOL_REPAIR_TEACH_DISABLED=1`. Repairs can still execute; the in-band "Tool argument repair note" is suppressed.
- Text tool-call protocol calibration can be disabled with `toolRepair.textProtocol: false` or `PI_TEXT_TOOL_CALL_PROTOCOL_DISABLED=1`.

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
- `/toolhealth` prints model adaptation records for this host: calibrated text protocol, learned standing rules, and teach statistics.
- `/toolrule-remove <provider/model> <mode>` removes one learned standing rule from the host-local adaptation store.
- RPC exposes the same controls through `get_tool_repair_health` and `remove_tool_repair_rule`.

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

## Source map

Confirmed against current source:

- Shared validation and repair switch: `packages/ai/src/utils/validation.ts`.
- Repair mode names and standing-rule text: `packages/ai/src/utils/tool-repair/registry.ts`.
- Agent repair event metadata and teach-note gate: `packages/agent/src/types.ts`, `packages/agent/src/agent-loop.ts`.
- Interactive marker: `packages/coding-agent/src/modes/interactive/components/tool-execution.ts`.
- Settings/env kill switches: `packages/coding-agent/src/core/settings-manager.ts`, `packages/coding-agent/src/core/tool-repair-settings.ts`.
- Health and rule removal: `packages/coding-agent/src/core/tool-repair-health.ts`, `packages/coding-agent/src/core/models/adaptation-store.ts`, `packages/coding-agent/src/core/slash-commands.ts`, `packages/coding-agent/src/modes/rpc/rpc-mode.ts`.
- Failure corpus and replay: `packages/coding-agent/src/core/failure-corpus.ts`, `scripts/tool-repair-replay.mjs`.
