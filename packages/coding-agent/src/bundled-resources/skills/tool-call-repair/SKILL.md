---
name: tool-call-repair
description: Use when improving Pi's tool calling, when a model "can't do tool calls" or fails argument validation repeatedly, when adding an argument repair or coercion, or when touching validateToolArguments, prepareArguments, or provider tool-call assembly. Doctrine for making tool calling succeed with any model, especially open models with weak native tool support - validate-then-repair at one choke point, a finite failure-mode catalogue, shape-vs-relational rules, efficiency and telemetry requirements.
---

# Tool-call repair

A model that "can't do tool calls" is almost always emitting one of a SMALL,
FINITE set of shape mistakes (about 90% of cases across deepseek-flash,
deepseek v4 pro, glm, qwen; observed 2026-07). The harness's job is a
four-stage loop: **CAPTURE** every malformed or failing call, **FIX** what is
mechanically repairable, **RECOVER** the turn when repair is impossible
(bounce with a schema echo, never a dead end), and **TEACH** the model so the
mistake stops recurring. Every mechanical repair saves one full turn of
latency and tokens; every successful teach makes the repair unnecessary. That
compounding saving is the feature.

## Decisions (non-negotiable)

1. **One choke point, and it is CODE.** All argument repair lives behind
   `validateToolArguments` (`packages/ai/src/utils/validation.ts`), which
   every tool call already passes through (`packages/agent/src/agent-loop.ts`
   prepareToolCall). The layer itself is a dedicated module of pure
   deterministic functions - `utils/tool-repair/`: `registry.ts` (named
   entries), `analyzer.ts` (validator errors -> classified modes),
   `repairer.ts` (clone -> transform -> guard -> re-check),
   `text-protocol.ts` (primer generator + envelope parser over one shared
   grammar). No I/O, no clock, no randomness, no model calls anywhere in the
   repair path; same input, same output; unit tests need no mocks. This
   skill is doctrine for whoever maintains that module - prose never
   substitutes for the parser/analyzer/repairer code. Never add per-tool
   special cases; `prepareEditArguments` in `edit.ts` is legacy exactly-this
   and gets deleted when the general repair covers it.
2. **Validate, then repair.** Run `Check` first. Well-formed args are NEVER
   mutated (hot path pays one cached compiled-validator check, returns the
   SAME object, nothing else). On failure, walk the validator's error list
   and apply repairs keyed to the error type at the failing path, then
   re-Check once. Still failing: bounce to the model as an error tool result
   that echoes the expected schema fragment. Never preprocess-then-validate;
   blind coercion mutates correct input and hides bugs.
2a. **Performance is a hard requirement, not a hope.** Completeness lives
   ENTIRELY on the slow (already-failed) path; the fast path is one cached
   `Check`. Repairs are O(validation-errors), not O(schema): a static
   `(expect, got)` dispatch Map, precompiled matchers, no RegExp/schema
   compilation/JSON parse per call except the one a mode explicitly needs.
   Bounded work: ≤1 clone, ≤1 transform per failing path, ≤1 sub-Check per
   transform, exactly 1 whole-args re-Check, no transform loops. A microbench
   fixture GATES this (clean-path cost within noise of a bare Check). Adding
   the 20th failure mode must cost the hot path nothing.
3. **Shape repairs only.** A repair may reshape what the model clearly meant
   (parse a stringified array, wrap a bare item, drop a null optional). It may
   never invent a value. Required-but-null, cross-field constraints, and
   semantic errors are relational: bounce those to the model. The current
   `coercePrimitiveByType` null-to-zero-value behavior violates this rule and
   is scheduled to be replaced by the catalogue's null rule.
4. **Uniform across schema kinds.** TypeBox tools (built-ins) and plain
   JSON-schema tools (MCP, extensions) get the same repair set. Today
   built-ins get FEWER repairs (the `hasTypeBoxMetadata` guard skips the
   coercion pass); that asymmetry is a defect, not a design.
5. **Every repair is check-guarded and ordered.** Apply on a cloned candidate,
   keep only if the sub-check passes. Within string-where-array-expected, try
   JSON.parse FIRST and wrap second, or `'["a","b"]'` becomes `['["a","b"]']`.
6. **Telemetry or it does not improve.** Count `{model, failureMode,
   repaired|bounced|taught}` per firing, and link each repair to its
   execution outcome and to recurrence-after-teach. That table tells us which
   models need which repairs, proves the round-trips saved, and marks dead
   repairs and dead teach notes for removal. A repair that never fires in 30
   days is a deletion candidate.
7. **Teach, do not nag.** A silent repair leaves the model repeating the
   mistake forever. When a repair fires, the tool result carries a ONE-LINE
   corrective note ("your `edits` arrived as a JSON string; it was repaired
   to an array - emit a raw JSON array") the FIRST time that (tool, mode)
   fires in a session, throttled after. A mode that keeps firing for a model
   graduates to a standing per-model rule injected into the system prompt,
   capped and retired when telemetry shows it stopped firing. Teaching that
   does not reduce recurrence gets reworded or dropped, measured, not
   assumed.
8. **Only detectable failures can be taught.** A well-formed call that does
   the wrong thing is invisible to this layer except for enumerated
   detectable subclasses (see the teachable-error catalogue in references).
   Do not pretend otherwise; general semantic wrongness belongs to review,
   not to the repair loop.

## Two grammars (the complete contract)

The layer is defined by two formal grammars, both in references, both encoded
as code (not prose):
- **Envelope grammar** (`references/text-protocol-grammar.md`) — how a text-
  mode call is shaped: EBNF for `<pi:call name="X">{json}</pi:call>`, the
  recognized inbound variants, the schema→primer projection, and the
  DICTIONARY generated from pi's real tools (bash, read, edit, write, ls,
  grep, find).
- **Failure grammar** (`references/failure-grammar.md`) — how a malformed
  call is recognized and repaired: the `errorSignature → transform → guard →
  note` table (tool-agnostic modes, including the required-null bounce) plus
  the tool-specific rows for bash (`command` as argv-array or object-wrapper,
  `timeout` as string/{}), edit, read/ls/grep/find. This is what `analyzer.ts`
  classifies against.

## The catalogue (summary; full table in references/failure-grammar.md)

| # | Name | Model emits | Repair (guard-gated) |
|---|---|---|---|
| 1 | nullOptionalDrop | `null` for an optional field | delete key |
| 2 | nullRequiredBounce | `null` for a required field | no repair; bounce with required-value feedback |
| 3 | jsonStringParse | `"[...]"`/`"{...}"` string where container expected | JSON.parse; guarded smart-quote delimiter fallback; keep if it matches + checks |
| 4 | jsonObjectPropertySalvage | malformed object string with recoverable declared properties | keep declared property values if the whole object checks |
| 5 | singleObjectWrap | single object where array-of-objects expected | wrap `[obj]` if it passes `items` |
| 6 | bareScalarWrap | bare scalar where array expected | wrap `[v]` if it passes `items` |
| 7 | emptyObjectPlaceholder | `{}` placeholder where scalar expected | delete if optional (default applies); else bounce |
| 8 | numberFromString | `"42"` where number expected | `Number(s)` if finite |
| 9 | boolFromString | `"true"`/`"false"` where bool expected | exact map (never truthiness) |
| 10 | enumCaseNormalize | case/space enum variant | match to the one member, else bounce |
| 11 | propertyCaseNormalize | root argument key casing differs from schema casing | rename to the schema key when unique |
| 12 | singleElementUnwrap | `[v]` where scalar expected | unwrap if 1 elem and checks |
| 13 | stringifiedNumberInArray | `["1","2"]` where number[] expected | map Number if all finite |
| 14 | bashCommandArgvJoin | bash `command` sent as an argv list | join string values with spaces |
| 15 | bashCommandUnwrap | bash `command` sent as a single-key object wrapper | unwrap the string-valued wrapper |

Every entry is a NAMED registry entry
`{name, errorSignature, transform, guard, noteTemplate}` — one table powers
the repair, the teach note, the telemetry tag, and the docs row: the
deterministic set of what pi can and will repair. Repairs NEVER invent values
and are ALWAYS guard-gated (kept only if the transform Checks), so a repair
can only ever turn an invalid call valid, never alter a valid one. The scalar,
array-number, and bash rows are the increment past the original four; they cost
the hot path nothing because they run only on already-failed calls (see decision
2a).

## Method for an improvement pass

Measure first (telemetry, or fixture-replay of failing transcripts). Pick the
top firing failure mode. Write a failing fixture per affected provider. Land
the error-keyed repair at the choke point. Prove the hot path is unchanged
(well-formed fixture bytes untouched). Record ledger + CHANGELOG entries per
repo convention. Adjacent gaps (missing tool-call id synthesis, text tool-call
extraction and the plain-text protocol primer + calibration handshake for
untrained models, truncated-stream guard, name sanitization parity,
history-replay policy) are catalogued with code anchors in the references
file; take them as separate items, not riders.

## Output contract

Code and fixtures land in `packages/ai` (validation + provider tests).
Per-model observations and new failure modes append to the model-notes table
in `references/repair-catalogue.md`. Durable findings go to the AGENTS.md
ledger. Never chat-only.

## Guards

- Never loosen a schema or delete a test to make a call pass.
- Repairs are pure, deterministic, bounded (~100 lines each, one re-Check).
- A repair without a fixture per provider it claims to fix does not merge.
- Do not repair relational failures; the model must decide values.
