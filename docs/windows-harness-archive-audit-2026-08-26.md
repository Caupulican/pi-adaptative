# Windows harness archive audit — 2026-08-26

## Verdict

**Confirmed:** baseline `main` at `b01790942d0a4a0ddae04dbc136db0777d99b7c2` fixes several failure modes present in the archived Windows runtime evidence. The strongest released confirmation is the v0.97.6 goal-hydration repair: the archive contains the exact repeated `get_goal`/`task_steps` loop that the projection logic and regression tests prevent.

**Working-tree repair confirmed:** the archive also exposed a deterministic v0.97.7 defect in which a cited failed or canceled `tool_task` permanently blocked goal completion. The current uncommitted repair separates terminal settlement from evidence validity: only running tasks block liveness, while failed/canceled results remain invalid as proof.

No claim below relies only on a version transition. Each resolved classification requires archived evidence plus current source and a focused passing regression. Native Windows execution remains a residual gap where explicitly stated; final-tree repository validation is recorded below. No commit, release, or publication is claimed.

## Scope and evidence handling

- Source archive: `C:\Users\Caupulican\Downloads\.pi.7z`
- SHA-256: `fef1d0dc5303726dc697c2765ac3738b0942ebd653718149c6b10f4867b70247`
- Archive integrity: 7-Zip test passed; 8,177 files, 443 directories, 546,975,366 uncompressed bytes; no encrypted entries or unsafe traversal paths.
- Selectively extracted evidence: sessions, recovery/failure telemetry, orchestration state, background-task state, and tool-output artifacts. Authentication, settings, trust, memory, caches, and unrelated files were excluded.
- Session coverage: 59 JSONL files, 75,833 records, 329,375,759 bytes, from `2026-07-23T00:23:25.443Z` through `2026-08-26T11:30:22.536Z`; zero JSON parse errors.
- Telemetry coverage: 900 valid failure-corpus records and 761 valid tool-recovery records; zero JSON parse errors.
- Evidence index: `/tmp/pi-windows-audit-20260826-b017909/coverage-summary.json`.

Archive-relative JSONL line numbers are 1-based. Chat and tool payloads were parsed structurally; this report does not reproduce credentials, private text, or raw arguments.

## Confirmed resolved or materially improved

### 1. Repeated goal hydration on every continuation — fixed in v0.97.6

**Archived symptom — confirmed.** In `.pi/agent/sessions/--D%3A%5C--/2026-08-26T00-26-35-028Z_01a03b76-2a94-7ba8-adfa-e29eb6c7cdcd.jsonl`, a goal-completion failure at line 14242 is followed by 29 redundant hydration calls between lines 14244 and 14499: 15 `get_goal` calls and 14 `task_steps` calls, despite earlier successful hydration results. The loop consumed turns without changing authoritative state.

**Current owner — confirmed.** `packages/coding-agent/src/core/goals/compact-goal-context.ts:51-59` now scans successful hydration results after the latest continuation trigger. Lines 84-87 request only still-missing tools and explicitly prohibit repeating a successful call in current context. `packages/coding-agent/src/core/provider-request-context-controller.ts:48-75` captures that projection before context GC and supplies it to the final transient goal context.

**Regression — passed.** `packages/coding-agent/test/goal-prompt-untrusted-wrap.test.ts:106-210` covers failed hydration, partial successful hydration, complete hydration, and preservation through provider-context scrubbing. Focused result: 6/6 tests passed.

**Classification:** fixed with high confidence. This addresses the repeated hydration loop, not the independent terminal-task completion deadlock below.

### 2. Stringified `edit.edits` arguments — fixed by shared validate-then-repair

**Archived symptom — confirmed.** `.pi/agent/sessions/--D%3A%5C--/2026-08-23T17-27-31-092Z_01a02fa9-c813-798e-8ca6-588d43b975ed.jsonl:1027-1029` contains two duplicated `edit` calls whose top-level arguments are objects but whose `edits` field is a JSON string. Both calls were bounced as invalid.

**Current owner — confirmed.** The current shared repair registry handles JSON-string values where the schema requires arrays/objects; the edit tool deliberately leaves this shape to that shared layer (`packages/coding-agent/test/edit-tool-legacy-input.test.ts:104-127`) rather than adding a tool-specific coercion.

**Regression — passed.** `packages/ai/test/tool-repair.test.ts`: 21/21 passed. `packages/coding-agent/test/edit-tool-legacy-input.test.ts`: 8/8 passed.

**Classification:** fixed with high confidence for the archived argument shape.

### 3. Windows Bash grammar/routing failures — materially improved; native confirmation incomplete

**Archived symptom — confirmed.** Recovery telemetry contains recurring Windows router rejections for pipelines, control flow, unsupported `grep`/`find`/`ls` forms, nested shell invocation, and POSIX scripts. These are concentrated in older sessions and use diagnostics from pre-current router generations.

**Current owner — confirmed.** `packages/coding-agent/src/core/tools/shell-contract-router.ts:321-396` routes complex/state-mutating Bash forms to the bundled Python engine when enabled. `packages/coding-agent/src/core/settings-manager.ts:334,3705` confirms the engine defaults on; explicit `false` restores the PowerShell-only floor.

**Regression — passed with one platform skip.** `shell-contract-router.test.ts`, `windows-shell-engine.test.ts`, and `windows-shell-integration.test.ts`: 39 passed, 1 skipped. The skipped case is native-platform dependent.

**Classification:** materially fixed at source/test level. Native Windows field confirmation remains incomplete because this audit ran the current tests on Linux rather than replaying the exact archive workload inside Windows v0.97.7.

### 4. Transient Windows release-activation locks — current fix verified, archive match inconclusive

**Current owner — confirmed.** v0.97.7 commit `290e5e73d` adds bounded retries around transient Windows activation locks in `install.ps1` and a focused offline installer regression.

**Regression — passed.** `node --test scripts/install-standalone-windows.test.mjs`: 9/9 passed, including “retries transient release activation locks and fails closed when exhausted.”

**Archived match — inconclusive.** The sessions contain Windows file-lock errors in application/project workflows, but no exact archived standalone release-activation failure was independently isolated. Therefore this is code/test confirmation, not field confirmation from this archive.

## Confirmed defect and working-tree repair

### Cited terminal `tool_task` permanently blocked goal completion

**Severity:** high reliability defect; deterministic in v0.97.7; fixed in the current uncommitted working tree.

**Archived evidence — confirmed.** In `.pi/agent/sessions/--D%3A%5C--/2026-08-26T00-26-35-028Z_01a03b76-2a94-7ba8-adfa-e29eb6c7cdcd.jsonl`, `tool-task-6` and `tool-task-7` are recorded terminal `failed` at lines 14129-14130. Goal completion is then refused repeatedly from line 14242 through line 14509. Additional waits and cancels do not change those terminal records.

**Original mechanism — confirmed.** Baseline `packages/coding-agent/src/core/goals/goal-tool-core.ts` added every cited task whose status was not exactly `completed` to the blocking set. The diagnostic instructed another wait even when the task was already terminal. Goal evidence had no removal transition, so citing a failed/canceled task created a permanent deadlock.

**Independent baseline reproduction — failed as expected.** `/tmp/pi-windows-audit-20260826-b017909/repro-cited-terminal-task.mts` builds a goal with a separately proven requirement plus unrelated cited failed-task evidence. Baseline HEAD refuses completion for `status: "failed"`; negative controls complete when the same record is `completed` or absent. Reproduction output SHA-256: `5ed1af583ec3e480daf206d9c74a6bf11cdb984c8d63be257baed56abfc3a0f0`.

**Authoritative repair — confirmed.** `packages/coding-agent/src/core/goals/goal-tool-core.ts:493-508` now combines goal-owned running tasks with `collectCitedRunningToolTaskIds(...)`. `packages/coding-agent/src/core/background-tool-task-controller.ts:69-88` keeps the two predicates separate: completed-only evidence acceptance and running-only liveness. Running cited and uncited goal-owned tasks still block; failed/canceled terminal tasks settle without becoming verified evidence. The completion diagnostic and goal tool guidance now state that rule.

**Regression — passed.** `packages/coding-agent/test/goal-tool-core.test.ts:349-422` covers a cited running blocker plus failed/canceled terminal settlement. `packages/coding-agent/test/goal-evidence-verification.test.ts` independently covers running, failed, canceled, completed, and absent evidence states. The focused three-file goal suite passed 91 tests; the integrated eight-file goal/resource/settings suite passed 348 tests.

**Invariant retained:** active work may block completion; an already observed terminal result must not be represented as work another wait can finish. Evidence acceptance remains independent from task liveness.

## Unresolved or inconclusive observations

### Provider and transport failures

The archive has 131 aborted and 121 error assistant terminals. Confirmed clusters include empty streams, stream stalls, WebSocket disconnects, rate limits, and two early provider rejections of a reserved function name. These events are operational evidence, not proof that each is a harness defect: many can originate in provider service or network state. No equivalent controlled replay was available, so they remain unclassified individually.

### Telemetry does not establish recovery effectiveness by itself

The failure corpus contains 740 tool-execution records, 21 tool-validation records, and 139 provider/API records. Recovery events contain the 740 tool-execution and 21 validation records, but no provider/API recovery lifecycle. All 21 recorded validation events were `bounced`; the archive therefore does not itself demonstrate repaired execution, even though current focused repair tests pass. Current source behavior must remain the oracle, not aggregate historical counts.

### Historical tool failures contain substantial expected operational noise

Of 900 corpus records, 281 are `exit_1`, 102 are timeouts, and many are ordinary missing-file, rejected-operation, authorization-boundary, or stale-edit outcomes. They should not be interpreted as 900 harness defects. Current `operation_outcome` semantics separate completed negative operations from harness failures, but the archive spans older schema versions: only 103 of 1,652 errored session tool results carry `errorKind: "operation_outcome"`; 1,549 predate or omit the field. Historical counts are therefore not comparable to current behavior without version stratification.

## Rejected candidates

- **“Every nonzero command is a harness bug” — rejected.** Most are expected application/tool outcomes.
- **“Every provider error is fixed by current retry logic” — rejected.** No controlled provider replay proves that claim.
- **“v0.97.5 to v0.97.7 movement proves semantic repair” — rejected.** Version movement is only provenance; source and focused tests supply the evidence above.
- **“The v0.97.6 hydration fix alone resolves the entire goal loop” — rejected.** It removes redundant hydration turns; the separate terminal-task deadlock required the working-tree repair above.

## Validation matrix

- Archive integrity: passed (`7z t`).
- JSONL structural parse: 59/59 session files, 900/900 failure records, 761/761 recovery records; zero parse errors.
- Goal hydration regression: 6/6 passed.
- Shared tool repair regression: 21/21 passed.
- Edit legacy/repair boundary: 8/8 passed.
- Windows shell router/engine/integration: 39 passed, 1 native-platform skip.
- Windows standalone installer: 9/9 passed.
- Baseline failed-terminal-task reproduction: defect reproduced; two negative controls passed.
- Working-tree goal regressions: 3 files, 91 tests passed.
- Integrated goal/resource/settings regressions: 8 files, 348 tests passed.
- Final-tree root gate: exact `npm run check` passed, including Biome over 1,888 files, harness/release/dependency/toolchain checks, TypeScript no-emit, and browser smoke.
- Final-tree workspace suite: exact `npm test` passed all 4 packages; 10,282 total, 9,525 passed, 757 skipped, 0 failed.
- Final-tree hygiene: `git diff --check` exited 0; changed paths were limited to the intended source, tests, documentation, and changelog.

Native Windows v0.97.7 workload replay has not yet run. No source archive content was executed.

## Prioritized action

1. Replay a bounded representative Windows shell workload under native v0.97.7 to close the one platform gap.
2. Add provider/API recovery lifecycle persistence if recovery effectiveness must be measured from field corpora.
3. Keep historical telemetry version-stratified; do not compare pre-`operation_outcome` error totals directly with current releases.
