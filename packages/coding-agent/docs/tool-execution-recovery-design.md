# Tool execution repair, recovery routing, and error management

Status: this pass implements a smaller Astra-corrected slice. Deferred work is marked below and is not an acceptance requirement for this pass.
Owner: one choke point per layer below. No per-incident string hardcodes.

Measured live: session `01a0a4cc-a620-7a9a-83b5-c001fe2bc54d` (2026-09-15, pi-adaptative).
29 `isError` tool results plus 1 unlisted rejected replay (`task_steps` selector `7` repeated after the gate blocked the unchanged call).

## Problem

Argument-shape repair (`packages/ai/src/utils/tool-repair/`) already has a catalogue, a validate-then-repair choke point, and teach notes. Execution failures do not. They collapse into one MUST ledger with generic `next_action`, attach inapplicable cross-tool "loaded actions", and rarely retry a uniquely determined correction.

Last session's 29 were not 29 unrelated bugs. They are a small set of missing general mechanisms.

## Evidence inventory (every log class)

Counts are `isError` toolResults in that session. Unlisted = rejected, not executed.

| n | Tool | failure_code / first line | Class |
| - | ---- | ------------------------- | ----- |
| 7 | bash | `exit_1` vitest FAIL workbench-controller | completed verification outcome, rewritten as harness mistake |
| 2 | bash | `exit_1` biome format would have printed | completed diagnostics outcome; format-only drift |
| 1 | bash | `exit_1` biome "No files were processed" on `scripts/*.mjs` | checker coverage miss, treated as failure |
| 1 | bash | `exit_1` git config | completed command outcome |
| 3 | edit | `edit_old_text_not_found` after earlier in-run mutation | stale source; evidence present; no unique rematch |
| 1 | goal | `satisfy_requirement requires a non-empty requirementId` | omitted unique current entity |
| 1 | goal | increment with no unused evidence | live catalog not in recovery contract |
| 1 | goal | `Unknown evidence 'ev-…'` | live catalog not listed |
| 1+4 | task_steps | selector `7` not found (1 executed, 4 rejected unlisted) | ordinal after compact; no control-plane recovery |
| 1 | read | `file_not_found` `/home mar/caudev/…workbench-controller.test.ts` | path spelling; write-create action wrongly loaded |
| 3 | tool_task | wait throw (`no ci.yml run`, HTTP 404, release.mjs) | catch returns `isError` without `errorKind` |
| 1 | skill | load of excluded `autonomous-execution` | policy refuse, retryable-looking error |
| 1 | memory | USER.md `insufficient_observations` | policy refuse, retryable-looking error |

## Current owners (do not fork them)

1. Shape repair: `validateToolArguments` → `packages/ai/src/utils/tool-repair/`.
2. Execution error catalogue: `getToolExecutionErrorPolicy` in `packages/ai/src/utils/tool-repair/registry.ts`.
3. Failure memory + MUST protocol: `packages/agent/src/tool-failure-memory.ts`, `tool-failure-recovery-protocol.ts`.
4. Admission + loaded actions: `packages/agent/src/tool-failure-recovery-gate.ts`.
5. ErrorKind: `AgentToolErrorKind` in `packages/agent/src/types.ts` (`tool_failure` vs `operation_outcome`).
6. Tool-owned recovery contracts: `failureRecovery` on `AgentTool`.
7. File cooperation kinds: `packages/coding-agent/src/core/tools/file-failure-recovery.ts`.
8. Intent promotion (not recovery): `packages/coding-agent/src/core/tool-selection/`.
9. Command family: `packages/coding-agent/src/core/tools/command-family.ts`.
10. Path aliases: `packages/coding-agent/src/core/context/path-alias-table.ts` (spaced segments are legal).

## Confirmed mechanism defects

### D1. Classification is lost, so completed work becomes a "mistake"

`AgentToolErrorKind` already says a completed negative status is `operation_outcome` and must not be rewritten into a failure record. Last session still stored `[harness] MUST:true` records for bash `exit_1` and `tool_task` waits.

Causes, both general:

- `tool-task.ts` wait `catch` returns `{ isError: true }` with no `errorKind`. Missing kind defaults to `tool_failure` (`agent-loop.ts` executeToolCall).
- `instanceof AgentToolExecutionError` is the only way a thrown bash `exit_N` keeps `errorKind: "operation_outcome"`. If the class identity does not survive jiti/runtime copies, the throw is a generic error, `classifyToolFailure` infers `exit_1` from the text, and `rememberToolFailure` rewrites the vitest/biome/git output into a MUST ledger with "Do the corrective work first".

Invariant: classify by duck-typed fields (`name === "AgentToolExecutionError"` plus `failureCode`/`errorKind`/`outputSignature`), never `instanceof`. `isError: true` without `errorKind` is invalid at the tool boundary.

### D2. Loaded recovery actions match observation kinds, not cooperation kinds

`read` file_not_found publishes `filesystem.file.exists`. `write` advertises "If the goal requires this exact missing file… create it with write" on that same kind. Last session's garbled path to an existing test file loaded the write-create action.

`formatRecoveryGuidance` then truncates at 320 chars, so the failed tool's own locate instruction is the part that disappears.

Invariant: a failed tool publishes what went wrong. Other tools may attach actions only when the failed tool published a cooperation kind that names the invited repair (`filesystem.file.missing.create`, `filesystem.workspace.mutated`). Observation kinds (`filesystem.file.exists`, `filesystem.file.current-text`) bind only the failed tool's own correct/locate actions.

### D3. Control-plane tools have no recovery contracts

`task_steps`, `goal`, `skill`, `memory` do not declare `failureRecovery`. Selector/id misses get generic next_action. The model retried `task_steps` selector `"7"` until the gate rejected it four more times.

`resolveTaskStepSelector` already accepts `"7"` as `step-7` when that id exists. Compact removes completed steps (`compactTaskSteps`), so the ordinal dies. Goal `Unknown evidence` does not list live evidence ids (task_steps already lists open steps on miss). `satisfy_requirement` with empty id does not adopt the unique open requirement (increment already does the unique-pending fill).

### D4. No execution-repair choke point

Shape repair may reshape invalid args. Execution may not invent values, but it may apply a **unique existing candidate**:

- path: `/home mar/caudev/...` exists uniquely as `/home/caudev/...` after space→`/` (and alias expansion, NFC, `~`).
- entity: omitted/ambiguous selector with exactly one live match (open requirement, current step).
- source: `oldText` unique in current bytes after newline/indent normalize.

Today the edit tool already returns current-line evidence and says "re-match oldText". It does not retry the unique rematch. Path miss does not try unique mechanical spellings.

### D5. Host identity and checker coverage are silent

`scripts/github-origin.mjs` pins `gh` at precommit. Runtime `gh` / `tool_task` still resolve Actions to the earendil-works/pi parent when `gh-resolved` is unset (MEMORY.md). Last session: wait for `ci.yml` listed other workflows, then HTTP 404 on `repos/1035029907/actions/runs/17785100764`.

Biome `files.includes` has no `scripts/**`. `biome check scripts/*.mjs` completes with "No files were processed" and is stored as `exit_1`.

Post-edit biome format-only drift (`would have printed`) is a completed diagnostic, not a tool crash. Mutation pipeline does not format touched files that biome already owns.

## Invariants

I1. One classification choke point. Every tool error carries `errorKind`. Duck-type thrown execution errors. Unclassified `isError` is a test failure, not a silent `tool_failure`.

I2. MUST ledger is only for operations that did not complete or that violated protocol/policy the model can correct. Completed command/test/diagnostic/wait status is `operation_outcome`: keep the tool output, governor still blocks identical replay until the world moves.

I3. Mechanical execution repair is unique-candidate only, bounded to one retry, never invents content, never creates files, never loosens schemas. Same spirit as shape repair decision 3.

I4. Loaded actions are failure-scoped. Cross-tool actions require an explicit cooperation target published by the failed tool.

I5. Control-plane misses attach a live catalog (ids, statuses) as evidence and a correct action naming those ids.

I6. Host CLIs with a default remote/project identity use this clone's origin at runtime, not only at precommit.

I7. N+2: no growing prefix of recovery prose; bounded actions (existing `MAX_RECOVERY_ACTIONS`); one owner per layer; no rescan of all tools for observation kinds.

## Layers (smallest enforcing owner)

```
prepareArguments (path aliases)
  → validateToolArguments (shape repair, unchanged)
  → recovery admission (unchanged exact-op gate)
  → execute
  → classify outcome (NEW: duck-type + required errorKind)
  → mechanical execution repair if unique candidate (NEW, ≤1 retry)
  → if still failing:
       policy catalogue + FILTERED loaded actions + live evidence
  → tool-selection records outcome; optional recovery-intent hint
```

### L1. Classification (`packages/agent/src/agent-loop.ts` + tool boundary)

- Add `readToolExecutionError(error: unknown)` that accepts duck-typed `AgentToolExecutionError` (name + failureCode + errorKind + outputSignature). Use it instead of `instanceof`.
- Type/test: returned `{ isError: true }` without `errorKind` fails a focused coding-agent test for bash, tool_task, goal, task_steps, skill, memory.
- `tool-task.ts` catch: `errorKind: "operation_outcome"` (wait timeout, 404, failed job are completed waits).
- Policy refusals (`skill` exclude/load-excluded, `memory` insufficient_observations): `errorKind: "tool_failure"`, phase `policy`, `attemptMemory: "discard"` so they do not occupy retry identity. Catalogue rows, not ad-hoc strings in the gate.
- Verification/diagnostics: keep bash `createExitError` as `operation_outcome`. Prove with a test that a thrown exit_1 does not produce `[harness]` even when the error object is a plain `{ name, message, failureCode, errorKind, outputSignature }`.

### L2. Mechanical execution repair (`packages/ai` pure + agent one-shot)

New module `packages/ai/src/utils/tool-repair/execution-repair.ts` (no I/O). The agent supplies a `uniqueResolve` callback for existence/live-id checks so the module stays pure.

Named modes (registry entries, same table as shape repair):

| name | input | keep iff |
| ---- | ----- | -------- |
| `pathUniqueNormalize` | failed path | exactly one existing candidate among: space→`/`, collapse separators, NFC, `~`, alias expansion |
| `entityUniqueResolve` | failed selector/id | exactly one live entity (step, requirement, evidence) after ordinal/prefix/current rules |
| `sourceUniqueRematch` | `oldText` miss | exactly one match after newline + indent normalize against provided current source |
| `omittedUniqueCurrent` | required id omitted | exactly one open/current entity of that kind |

Agent applies at most one successful mode, re-executes once, stamps a one-line teach note (existing teach throttle). If not unique, bounce with the candidate list / live catalog.

Falsifier: two existing paths that both match a normalize rule → no repair. Two open requirements → no omitted fill.

### L3. Recovery routing (gate + file kinds + control-plane contracts)

Split file kinds:

- Keep `filesystem.file.exists` as observation (failed tool locate/ls/re-read only).
- Add `filesystem.file.missing.create` published only by tools that intend creation (bash/workspace missing-file diagnostics, not read).
- Keep `filesystem.workspace.mutated` for "fix contents then rerun command".
- Keep current-text / encoding / retarget kinds on the failed mutation tool.

Gate: match actions by `(authority, kind)` as today, but kinds no longer overload observe vs create. Raise guidance composition so policy line + failed-tool actions are not truncated away (policy already composed; stop stuffing inapplicable write-create into the 320-char budget).

Control-plane `failureRecovery` on `task_steps`, `goal`, `skill`, `memory`:

- `workflow.step.select` — evidence: open (and compacted tombstone) ids.
- `workflow.goal.requirement` / `workflow.goal.evidence` — evidence: live ids.
- `skill.eligible` — evidence: excluded vs missing.
- `memory.write.admitted` — next_action: do not retry the same USER write.

Compacted steps: bounded ordinal tombstone `{ id, status, contentPreview }` so `"7"` resolves to "step-7 completed/compacted; current is step-8" instead of "not found". Do not resurrect completed work as in_progress.

Goal `Unknown evidence` / missing requirementId: list live ids in the error text (same pattern as `resolveTaskStepSelector`). Unique omitted requirementId fills like increment.

### L4. Host identity and checker coverage

Runtime `gh` (bash git-filter / command family `gh`, and `tool_task` commands that invoke `gh`): apply origin pin or equivalent `-R origin-slug` using `scripts/github-origin.mjs` helpers. Precommit remains. Session-start pin is acceptable if it is the single owner; do not leave unattended `gh` on the parent.

Diagnostics "no files processed" / ignored paths: `operation_outcome` with a coverage notice (paths outside the checker's include). Do not MUST-ledger. Next_action: use a checker that covers the path, or skip.

Mutation format: after successful `edit`/`write` of files biome already includes, run biome format on those paths only (project formatter owner, not a bash retry). Ignored `scripts/**` stay untouched. This removes format-only `would have printed` loops without hiding real diagnostics.

### L5. Tool-selection recovery hint

After a classified failure, the next-turn hint may boost tools named by **applicable** loaded actions (read after edit miss, `get_goal` after unknown evidence). It must not boost `write` after a read locate miss. Record agreement as today. Kill switches unchanged.

## Oracle

A fixture replay of the 01a0a4cc error classes:

1. Thrown bash `exit_1` (plain duck-typed error object) keeps vitest/biome/git output; no `[harness]` MUST record; governor still refuses identical replay until another tool succeeds.
2. `tool_task` wait throw is `operation_outcome`; timeout/404 text remains; no MUST ledger; next_action names origin/workflow identity when `gh` is the command.
3. `read` of `/home mar/caudev/…existing-file.ts` unique-repairs to `/home/caudev/…` and succeeds; write-create is not in loaded actions.
4. Two existing spaced-vs-slash paths → no path repair.
5. `edit` oldText unique after indent normalize applies once with teach note; two matches → bounce with current evidence, no write-create.
6. `task_steps` `"7"` after compact names the tombstone and current id; identical retry is rejected; loaded action lists live ids.
7. `satisfy_requirement` without id with exactly one open requirement succeeds; with two, lists both ids.
8. Unknown evidence lists live evidence ids.
9. Skill load of an excluded name is policy/discard; identical retry does not increment kind_mistakes as an execution miss.
10. Memory USER insufficient_observations is policy/discard.
11. Biome ignored path is operation_outcome + coverage notice.
12. Runtime `gh` without TTY uses origin slug, not the parent repo id.

## Falsifier

- Any mode that invents file contents, requirement text, or oldText that is not a unique normalize of provided current source.
- `instanceof` remaining on the execution-error path.
- Per-tool special case for `workbench-controller.test.ts`, `ci.yml`, or `autonomous-execution`.
- Write-create attached to a read miss of an existing-looking path.
- Hiding real vitest assertion failures (they stay `isError` + `operation_outcome` + full output).
- Auto-creating files.
- Schema loosening.

## Tests (fail first)

- `packages/agent/test` duck-type execution error; missing errorKind rejected; operation_outcome not rewritten.
- `packages/ai` execution-repair unique/non-unique path, entity, rematch.
- `packages/coding-agent/test` recovery-gate action matching after kind split; task_steps tombstone; goal live catalog; tool_task catch kind; skill/memory policy discard; biome coverage notice; gh origin pin at runtime (fake git/gh); pathUniqueNormalize on spaced `/home …`.
- Negative controls in each file.

## Astra corrections (applied)

Independent review FAIL. Required changes in this implementation:

- Duck-type `AgentToolExecutionError`; do not rely on `instanceof`.
- `tool_task` catch and invalid task id stay `tool_failure`, with explicit `errorKind`. Do not blanket `operation_outcome` on wait throws.
- Split write create onto `filesystem.file.missing.create`. Read miss stays `filesystem.file.exists` so ls locate attaches and write create does not.
- Entity resolution stays in existing selectors. Compacted ordinals get an archive-aware diagnostic; no unique-fill of an explicit missing id onto an unrelated sole entity.
- No post-success biome format. No space-deleting path rewrite (`/home mar/caudev` is not `/home/caudev`).
- Runtime `gh` pin is session-start via `pinGithubOriginForSession`; do not rewrite explicit `-R` foreign repos.
- L5 tool-selection recovery hint is out of this pass.

## This pass (acceptance)

In scope now:

1. Duck-type `readAgentToolExecutionError` with no `instanceof`, snapshot fields, return undefined on inspection failure.
2. `tool_task` invalid id and wait catch: explicit `errorKind: tool_failure`. Failed wait records already returned by the controller stay `operation_outcome`.
3. Write create uses `filesystem.file.missing.create`; read miss stays `filesystem.file.exists` so ls locate attaches.
4. Goal live catalogs in the error text and `failureRecovery.getFailureEvidence`. Increment unused-evidence names the live evidence catalog. No unique-fill of an explicit missing id.
5. Compacted/missing ordinals: id is absent; archive counts are shown separately; historical status of that id is unknown; no redirect.
6. Runtime `gh` pin lives in `packages/coding-agent/src/core/github-origin-pin.ts` (shipped). Non-GitHub/no-git is `skipped`; GitHub lock/write errors are `failed`. Root sessions pin at start; child/worker sessions inherit. Already-pinned skips the extra git read. Session start does not throw. Precommit CLI remains `scripts/github-origin.mjs`.

Deferred (not this pass):

- Mechanical unique path rewrite and source rematch.
- Post-success biome format.
- L5 tool-selection recovery hint.
- Session-visible diagnostic event for a `failed` origin pin.
- Built-package import smoke outside the source checkout.
- Outcome-advice owner that appends loaded actions onto `operation_outcome` without a MUST ledger.

Session `01a0a4cc` counts remain historical inventory, not a numeric gate until a fixture replay exists.

## Implementation order

1. L1 classification (unlocks most of the 29 from the MUST ledger without hiding them).
2. L3 routing kind split + control-plane contracts + live catalogs + step tombstones.
3. L2 mechanical unique repair.
4. L4 gh origin + checker coverage + mutation format of included files.
5. L5 recovery hint.

Stop when oracles 1–12 pass and proportional package tests are green.

## Out of scope

- New argument-shape modes unless a log class is a schema bounce (none of the 29 were).
- Changing TDD so test failures are not `isError`.
- Weakening USER.md observation gates.
- Replacing the MUST protocol; it stays for true incomplete/protocol failures.
