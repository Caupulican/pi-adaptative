# Failure grammar — the deterministic error→repair map

Two grammars make the layer complete: the ENVELOPE grammar
(`text-protocol-grammar.md`) says how a call is shaped; this FAILURE grammar
says how a malformed call is recognized and repaired. It is the formal
contract `analyzer.ts` classifies against and `registry.ts` encodes. Every
entry is `errorSignature → transform → guard → note`, keyed to a validator
error at an instance path. Adding a mode = adding a row here + a registry
entry + fixtures. Nothing is repaired that is not in this table.

Notation: `P` = failing instance path; `expect(P)` = the JSON-schema type(s)
declared at P; `got` = the received value's runtime type; `req(P)` = whether P
is in its parent's `required`; `def(P)` = P has a schema `default`.

## Core failure grammar (tool-agnostic — applies to every schema)

| # | name | errorSignature | got | transform | guard (keep iff) | note |
|---|---|---|---|---|---|---|
| 1 | nullOptionalDrop | type mismatch at P | `null`, `!req(P)` | delete key P | always (absence is valid for optional) | "sent null for optional `P` → omit the field instead" |
| 1b | nullRequiredBounce | type mismatch at P | `null`, `req(P)`, `!def(P)` | none | never (bounce) | "`P` is required and cannot be null → send a real value" |
| 2 | jsonStringParse | expect array\|object at P, got string | `"[...]"`/`"{...}"`, including text-protocol smart-quote delimiter drift | `JSON.parse(s)`; if strict parse fails, normalize `“`/`”` delimiters and the observed missing object-key quote pattern, then parse | parsed matches expect(P) AND sub-checks | "sent `P` as a quoted JSON string → send a raw JSON array/object" |
| 2b | jsonObjectPropertySalvage | expect object at P, got malformed object string | e.g. `{"path":"x" extra:1000}` | extract schema-declared JSON literal property values into a new object | each declared property appears at most once, no undeclared value is kept, and whole-object Check passes | "sent `P` as malformed JSON with recoverable declared properties → keep the schema-declared properties" |
| 3 | singleObjectWrap | expect array at P, got object | `{...}` | `[obj]` | `[obj]` passes `items(P)` | "sent one object where `P` takes a list → wrap it in `[ ]`" |
| 4 | bareScalarWrap | expect array at P, got scalar | string/number/bool | `[v]` | `[v]` passes `items(P)` | "sent a single value where `P` takes a list → wrap it in `[ ]`" |
| 5 | emptyObjectPlaceholder | expect scalar at P (or array whose `items` reject `{}`), got object | `{}` | delete key P | `!req(P)` (schema default applies) else bounce | "sent `{}` as a placeholder → omit `P`; its default applies" |
| 6 | numberFromString | expect number/integer at P, got string | `"42"`, numeric | `Number(s)` | finite (and integer if integer(P)) | "sent `P` as a quoted number → send a bare number" |
| 7 | boolFromString | expect boolean at P, got string | `"true"`/`"false"` | `s === "true"` | exact match only (never truthiness) | "sent `P` as a quoted boolean → send bare true/false" |
| 8 | enumCaseNormalize | expect enum at P, got string not in set | case/space variant | match case-insensitively/trimmed to one enum member | exactly one member matches | "`P` must be one of `a|b|c` → matched `<value>`" |
| 9 | propertyCaseNormalize | root object has key K whose casing differs from a declared schema property | e.g. `Path` for `path` | rename K to the schema key | exactly one declared root property matches case-insensitively and the canonical key is absent | "sent `P` with different property-key casing → use the schema key casing" |
| 10 | singleElementUnwrap | expect scalar at P, got 1-elem array | `[v]` | `v` | `v` passes expect(P) AND `length===1` | "sent `P` as a 1-item list where a single value was expected → send the value" |
| 11 | stringifiedNumberInArray | expect number[] at P, got string[] | `["1","2"]` | map `Number` | all finite | "list `P` holds quoted numbers → send bare numbers" |

Rules that keep this deterministic and safe:
- **Repairs never invent a value.** 5 relies on the schema `default`; nothing
  fabricates content. If a guard fails, the mode does not apply → bounce.
- **Guard is mandatory.** Every transform runs on a clone and is kept ONLY if
  it Checks against the sub-schema at P. A transform whose guard fails leaves
  args untouched and falls through to the next applicable mode, then bounce.
- **Order within one path:** 2 (strict/quote-normalized parse) → 2b (declared-property salvage) → 8/6/7 (coerce scalar) → 3/4/11 (wrap)
  → 10 (unwrap) → 5 (placeholder-drop) → 1 (null-drop). Parse before wrap so a
  stringified array becomes an array, not a wrapped string. Across paths:
  instance-path order. Root property-key casing repair runs before these per-path
  transforms because required-property validator errors do not carry the misspelled key path.
- **Bounded multi-pass.** After all per-path transforms, Check the whole args
  once. Pass → return repaired. Fail → repeat the walk-transform-Check cycle,
  up to `MAX_REPAIR_PASSES` (3, `repairer.ts`) whole-args re-Checks total;
  still failing after the bound → bounce. This is a sanctioned BOUNDED loop
  (decision D1), not the unconditional retry banned elsewhere in this file: a
  real cascade needs it because one pass's transform can expose an error a
  fresh validator walk must see — e.g. an outer `jsonStringParse` (mode 2)
  turns a stringified object into a real object whose OWN properties
  (`propertyCaseNormalize`, `numberFromString`, ...) were invisible to the
  first pass's error list, since those errors only exist once the outer
  string is a real object. Each pass is still O(validation-errors) via the
  same static dispatch, so total cost across the bound stays small and
  linear; a microbench (D2) gates the repaired-path budget. The bound is the
  deepest TESTED cascade (2 passes, the json-string-parse-then-nested-fixture
  case) plus one margin layer — not an arbitrary ceiling; a test
  (`tool-repair.test.ts`, "repair multi-pass bound (D1)") fails if any tested
  cascade needs more passes than the bound allows.
- Modes 2b and 6–11 are the increment past the original four; each is guard-gated so
  it can only ever turn an invalid call into a valid one, never change a
  valid call (the hot path never reaches them — see Performance).

## Tool-specific failure grammar (bash and the shape-sensitive tools)

The core grammar is schema-driven and covers every tool automatically. A few
tools have a KNOWN, recurring, tool-shaped failure that the core grammar sees
only as a generic type error; naming them lets the note teach precisely.
These are still guard-gated core repairs — NOT special-cased logic — the
tool-specificity lives only in the note text and the telemetry tag.

### bash(command:string, timeout:number?)
`command` is the arg models most often mis-shape, and bash is the highest-
traffic tool, so its failures matter most.

| observed | core mode | note (bash-specific) |
|---|---|---|
| `command` sent as `["ls","-la"]` (argv array) | bareScalarWrap inverse → join | "bash takes ONE command string, not an argv list → joined to `ls -la`" (guard: every element string; join with spaces) |
| `command: {"cmd":"ls"}` (object wrapper) | emptyObjectPlaceholder sibling: unwrap known single key | "bash `command` is a string → unwrapped `{cmd}`" (guard: single string-valued key in {cmd,command,script}) |
| `timeout: "30"` | numberFromString | "timeout is a number of seconds → sent 30" |
| `timeout: {}` | emptyObjectPlaceholder | "sent `{}` for timeout → omitted; silence watchdog applies" |
| `timeout: 0` / negative | NOT a failure — schema-valid, tool treats as unset | (no repair; documented tool behavior) |

The argv-array and object-wrapper `command` cases are common enough to be
named registry entries (`bashCommandArgvJoin`, `bashCommandUnwrap`) with the
same guard-then-keep discipline; they only fire when the core string check
already failed.

### edit(path, edits:{oldText,newText}[])
The canonical array-shape offender (Opus 4.6, GLM-5.1 in the code comment).

| observed | core mode | note |
|---|---|---|
| `edits: "[{...}]"` | jsonStringParse | "sent `edits` as a quoted JSON string → send a raw array" |
| `edits: {oldText,newText}` | singleObjectWrap | "sent one edit object → wrap in `[ ]`" |
| `oldText`/`newText` at top level (no `edits`) | legacy adapter (NOT a repair) | migrated to `edits:[{...}]` by the existing edit adapter |

### read / ls / grep / find (numeric + enum args)
| observed | core mode | note |
|---|---|---|
| `offset`/`limit`/`context`/`tail`: `"10"` | numberFromString | "`P` is a number → sent 10" |
| `limit`/`offset`: `null` | nullOptionalDrop | "omit `P` to use the default" |
| read `filter`: `"None"`/`" minimal"` | enumCaseNormalize | "`filter` is one of none/minimal/aggressive → matched `<value>`" |
| `ignoreCase`/`literal`/`metadata`: `"true"` | boolFromString | "`P` is a boolean → sent true" |

## What is deliberately NOT in the grammar (bounce, do not repair)

- Missing REQUIRED args with no default — the model must supply intent.
- Wrong VALUE that is validly typed (e.g. a nonexistent path, a bad regex) —
  not a shape error; belongs to execution + R44 teachable-errors, not repair.
- Ambiguous enum (matches 2+ members) — bounce with the candidate list.
- Any transform whose guard fails — never force it.
- Semantic wrongness in a well-formed call — out of mechanical reach.

## Performance contract (binding — the grammar must not slow the harness)

The failure grammar only ever runs on ALREADY-FAILED calls. The hot path
(well-formed args) never touches it. Concretely:

1. **Check-first, allocation-free on success.** A valid call pays exactly one
   `validator.Check(args)` (cached compiled validator) and returns the SAME
   object — no clone, no walk, no grammar lookup. This is the ~99% path for
   strong models and it is unchanged from today's cost.
2. **Repairs are bounded on the failed path.** The analyzer walks the
   validator's error list (already produced by the failed Check), not the
   schema tree; the exceptions are `propertyCaseNormalize` and
   `jsonObjectPropertySalvage`, which scan only root object keys or declared
   object properties after a failed Check. Each
   path error maps to at most a few candidate modes by a static dispatch table
   keyed on `(expect, got)` — a Map lookup, not a scan.
3. **No per-call compilation.** errorSignature matchers are precompiled
   constants; note templates are format strings; the registry is built once
   at module load. Nothing in the repair path constructs a RegExp, compiles a
   schema, or parses JSON except the one `JSON.parse` a mode explicitly needs.
4. **Bounded work.** At most: one clone of args, one transform per failing
   path PER PASS, one sub-Check per attempted transform, up to
   `MAX_REPAIR_PASSES` (3) whole-args re-Checks (decision D1's sanctioned
   bounded multi-pass — see above; not an unbounded loop, no backtracking
   search). Worst case is linear in the number of validation errors times the
   pass bound, both of which are themselves tiny.
5. **Text protocol only for flagged models.** The parser (R38) runs only when
   a model is configured for text mode; native-tool-call models never invoke
   it. The primer is generated once per session, not per turn.
6. **Measured.** A microbench fixture asserts the clean-path cost is within
   noise of a bare `Check` (no regression), and that a repaired call stays
   under a fixed budget. Perf is an acceptance criterion, not an aspiration.

The design principle: completeness lives entirely on the SLOW (already-broken)
path; the FAST path is a single cached check. Adding the 6th–20th failure mode
costs the hot path nothing.
