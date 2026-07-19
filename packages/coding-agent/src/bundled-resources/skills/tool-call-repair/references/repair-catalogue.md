# Repair catalogue and harness audit map

Source: cross-model repair work on deepseek-flash, deepseek v4 pro, glm, qwen
(owner, 2026-07) plus the 2026-07-06 pi-adaptative harness audit. Line numbers
are anchors from that date; trust the named function over the number.

## The repairs, precisely (named registry)

Repairs run ONLY after a failed `Check`, keyed to the validator error at the
failing instance path. Each candidate is applied on a clone and kept only if
the sub-schema check passes. One re-Check of the whole args after all repairs;
still failing means bounce to the model.

Each repair is one registry entry: `{name, errorSignature, transform, guard,
noteTemplate}`. The registry is the deterministic contract of what pi can and
will repair; the same entry powers the repair, the teach note, the telemetry
tag, and the docs table. Adding a repair means adding one entry plus its
fixtures, nothing else.

Registry mode names currently in force:

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

### 1. null-for-optional (`nullOptionalDrop`)
- Error signature: type mismatch at path P, received `null`, P not in the
  parent's `required` list.
- Repair: delete key P from its parent object.
- If P IS required: no repair. Bounce. Inventing `0`/`""`/`false` corrupts
  intent (`limit: null` becoming `limit: 0` changes the program). This
  replaced the old `coercePrimitiveByType` null-to-zero-value branches, which
  are gone from the code (verified: zero references in `validation.ts` /
  `tool-repair/`).

### 2. json-string-encoded array or object (`jsonStringParse`)
- Error signature: expected array (or object) at P, received string.
- Repair: `JSON.parse` the string; keep iff the parsed value is the expected
  container type AND passes the sub-schema check.
- MUST be attempted before repair 4 on the same error, or a stringified array
  gets wrapped instead of parsed.

### 3. single object where array-of-objects expected (`singleObjectWrap`)
- Error signature: expected array at P, received object.
- Repair: wrap as `[obj]` iff `obj` passes the array's `items` schema.
- Covers the "empty placeholder" variant: `{}` where `items` has no required
  fields wraps legitimately; `{}` where `items` requires fields fails the
  guard and bounces (relational: the model owes the content).

### 4. bare scalar where array expected (`bareScalarWrap`)
- Error signature: expected array at P, received string/number/boolean.
- Repair: wrap as `[v]` iff `v` passes `items`. Runs after repair 2.

### 5. empty-object placeholder (`emptyObjectPlaceholder`)
- Error signature: expected scalar (number/integer/string/boolean) at P,
  received `{}`; OR expected array at P, received `{}` that fails repair 3's
  guard (its `items` requires fields `{}` lacks).
- Repair: treat `{}` as ABSENT. Optional P: delete the key — a declared
  schema default then applies naturally (`shell({cmd, {} })` becomes
  `shell({cmd})` and the default idleTime supplies the value). Required P
  with a schema `default`: also deletable only if the validator honors the
  default; otherwise bounce. Required P without default: bounce.
- The rule that keeps this deterministic: the repair never invents the
  value; the schema's declared default supplies it, or the model must.

Ordering rule inside one error: parse (2) → wrap (3/4) → treat-as-absent (5).
Across errors: independent paths are order-free; process in instance-path
order for determinism.

## Layer architecture (deterministic code, not prompts)

Module: `packages/ai/src/utils/tool-repair/`

| File | Responsibility | Purity contract |
|---|---|---|
| `registry.ts` | the named repair entries: `{name, errorSignature, transform, guard, noteTemplate}` as typed data + pure functions | no side effects; enumerable (docs + telemetry tags generate from it) |
| `analyzer.ts` | validator error list -> classified failure modes at instance paths | pure; same errors, same classification |
| `repairer.ts` | clone -> transform -> guard-check -> whole-args re-check orchestration | pure; never mutates input; no I/O/clock/randomness |
| `text-protocol.ts` | ONE grammar definition; primer generator (Tool[] -> primer string) and envelope parser (text -> toolCall blocks) over it | pure; no regex scattered in providers |

`validateToolArguments` is only the thin integration point (Check ->
analyzer -> repairer -> re-Check -> bounce). Nothing in the repair path
calls a model. Offline proving ground: `scripts/tool-repair-replay.mjs`
replays corpus records or session files through analyzer/repairer with no
LLM and no session, reporting classified | would-repair | would-bounce and
emitting fixtures - new modes are developed against the script before
touching the live path.

## Choke-point map (audited 2026-07-06)

| Layer | Anchor | State |
|---|---|---|
| Streaming args assembly | each provider, `parseStreamingJson(partialJson)`; e.g. `openai-completions.ts` ~:382, `anthropic.ts` ~:623 | tolerant partial parse; no repair here (correct; keep providers dumb) |
| Blind pre-repair hook | `Tool.prepareArguments`, only user: `edit.ts` `prepareEditArguments` ~:95 | legacy special case of repair 2 for `edits` only (comment names GLM-5.1); delete once general repair lands |
| Check + error | `validation.ts` `validateToolArguments` ~:409-467, `getValidator` ~:97 | ONE TypeBox-compiled validator per schema regardless of origin (D5: the old ad-hoc `coerceWithJsonSchema`/`coerceWithUnionSchema`/`Value.Convert` coercion layer and its `hasTypeBoxMetadata` non-TypeBox-only guard are gone from the code — grep confirms zero references); per-path errors + received args feed `analyzer.ts`; does NOT itself echo the expected schema fragment (see gap 3 below) |
| Failure feedback | `agent-loop.ts` ~:700-704 | validation error becomes error tool result; model-side retry is the only recovery today |
| Check-guarded pattern precedent | `repairer.ts` `repairToolArguments` ~:376-420 | clone, transform, sub-Check, keep-iff-passes; every named repair in the registry follows this shape (decision 5) |

## Adjacent gap backlog (separate items, code-anchored)

1. **Missing tool-call id synthesis.** `openai-completions.ts` ~:254 seeds
   `id: toolCall.id || ""`. Open-model servers sometimes omit or duplicate
   ids; an empty id breaks toolResult matching and replay. Synthesize a
   stable id when absent (e.g. `call_<n>` per message) at assembly time.
2. **Text tool-call extraction.** No fallback for serving stacks that never
   emit native `tool_calls` (intent arrives as `<tool_call>{...}</tool_call>`
   or fenced JSON in content). Models in that population cannot tool-call
   through pi at all; repairs never see them. Extractor would live at the
   provider boundary, gated per model/config, off by default.
3. **Schema echo in validation errors.** The bounce message should include
   the expected sub-schema fragment (and one valid example) at each failing
   path; per-path error text alone often reproduces the same retry mistake.
4. **Truncated-stream guard.** `parseStreamingJson` happily yields a partial
   object when the stream ends mid-args (finish_reason length). If the
   partial validates (all lost fields optional), the tool executes with
   silently missing args. Detect terminal-with-incomplete-json and bounce.
5. **Name sanitization parity.** `google-shared.ts` ~:95 sanitizes tool names
   to `[a-zA-Z0-9_-]{1,64}`; the OpenAI-compat path sends names raw. MCP
   tools with dots/colons 400 on strict backends.
6. **History replay policy (decision needed).** Execution uses repaired args
   but the assistant message keeps the model's original emission, and
   `openai-completions.ts` ~:896 replays that original with a success result.
   The model is shown that the malformed shape worked, reinforcing it every
   turn. Options: replay repaired args (transcript diverges from what the
   model emitted) or keep original (reinforcement). Decide once, document,
   apply across providers.
7. **Escalation counter.** N identical validation failures from the same
   model on the same tool should trigger something better than an identical
   retry: inject the schema example, or escalate the model tier for one turn
   (see `model-router/tool-escalation.ts` for the existing escalation shape).

## Teach-back spec (capture -> fix -> recover -> teach)

The repair engine fixes the call; teach-back fixes the MODEL. Three tiers,
cheapest first:

1. **In-band note (per call).** When a repair fires, append one line to the
   tool result: `[harness] <repairName>: <what was wrong> -> <the right
   form>; executed as <repaired call>.` The IN -> OUT echo shows the model
   exactly what its call became - the strongest teaching signal; the
   repaired call and the repair note travel together in the same
   tool-result message. Text comes from the registry entry's noteTemplate.
   Fire on the FIRST (tool, repairName) occurrence per session; afterwards
   every Nth occurrence (default 5). One line, no lecture; token cost is
   the budget being protected.
2. **Standing per-model rule (persistent).** When telemetry shows a
   (model, failureMode) pair firing above threshold (default: 3 in one
   session, or recurring across sessions), inject a standing rule into that
   model's system prompt via the existing system-prompt builder ("emit arrays
   as JSON arrays, never as quoted strings"). Persist in the per-model
   profile. Hard cap (default 5 rules per model); retire any rule after 30
   days of telemetry silence. Rules are shape rules only, never tool-specific
   prose walls.
3. **Teachable-error catalogue (execution level).** Common EXECUTION errors
   get corrective guidance authored once, centrally: file-not-found suggests
   listing the directory first; edit text-not-found suggests re-reading the
   file; identical repeated failing calls escalate wording ("the same call
   failed twice; change the arguments, do not resend"). Enumerated list, not
   heuristics; each entry names its trigger error class.

Efficacy is measured or the note dies: recurrence of the same (model, mode)
after a teach event must drop; a note whose recurrence does not drop gets
reworded or removed. "Wrong but successful" calls are OUT of mechanical reach
except enumerated detectable subclasses (edit producing zero net change, read
of an empty range treated as content, and similar); anything else is review
territory, not repair territory.

## Telemetry spec

Emit one event per validation outcome: `{model, provider, tool, outcome:
clean|repaired|bounced, failureModes: [1..5|other], repairsApplied:
[registry names], taught: none|note|rule}`. Link repair events to the same call's execution
outcome (did the repaired call succeed?) and compute recurrence-after-teach
per (model, failureMode). Aggregate per model into the table below. Wire
through the existing telemetry path (`core/telemetry.ts` / session-analytics)
rather than a new sink. The "round-trips saved" metric is simply the repaired
count; the "teach works" metric is recurrence decay.

## Model notes (living table; append, do not rewrite)

| Model | Observed modes | Notes | Date |
|---|---|---|---|
| glm (5.1) | 2 | stringified `edits` array on edit tool; was special-cased in `prepareEditArguments` | 2026-07-06 (from code comment) |
| deepseek-flash | 1,2,3,4 | full catalogue observed in external repair work | 2026-07 |
| deepseek v4 pro | 1,2,3,4 | same | 2026-07 |
| qwen | 1,2,3,4 | same | 2026-07 |

## Companion grammars (authoritative)

- `failure-grammar.md` — the `errorSignature → transform → guard → note`
  table (modes 1–10 + bash/edit/read tool-specific rows). What `analyzer.ts`
  classifies against and `registry.ts` encodes.
- `text-protocol-grammar.md` — the envelope EBNF, inbound variants, the
  schema→primer projection, and the dictionary generated from pi's real
  tools. What `text-protocol.ts` speaks and parses.

## Acceptance fixtures (minimum set per repair)

Per provider that feeds the choke point (anthropic, openai-completions,
openai-responses, google, bedrock, mistral): one fixture per failure-grammar
mode (1–10) proving repair, one proving the required-null bounce, one per
guard-fails case proving bounce (transform rejected, args untouched), one
proving well-formed args pass with NO mutation (hot path untouched), the
ordering fixture `'["a","b"]'` → `["a","b"]` not `['["a","b"]']`, and the
bash rows (`command` as argv-array → joined string; `command` as `{cmd}` →
string; `timeout:"30"` → 30; `timeout:{}` → omitted). Plus the microbench:
clean-path within noise of a bare `Check`; repaired-path under budget.
