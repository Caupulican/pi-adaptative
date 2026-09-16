# Honest work status, clocks, and tool accounting

Status: source implementation verified and independent challenge review green, 2026-09-16. Release acceptance is tracked separately by exact-commit GitHub workflow evidence and published artifacts. The contract below records the accepted design; local verification evidence and limits are recorded at the end.

## Outcome and scope

The operator must be able to distinguish work in progress, a known wait, a request for input, and completion—even when the parent is idle while workers or background tools continue. Display elapsed time honestly; never imply that an advancing clock proves progress or process liveness.

This design covers the activity lane, execution/work-plan/team presentation, foreground-to-background handoff, invocation counters, and the process-liveness recovery boundary. It preserves the Ctrl+J and color changes already present. It does not introduce a scheduler, durable execution database, new authority settings, provider telemetry, or a new polling service.

## 1. Confirmed baseline

Source reviewed on `7d2cad591` plus the uncommitted patch:

- [`ActivityLaneComponent`](../../packages/coding-agent/src/modes/interactive/components/activity-lane.ts) owns live display items, canonical projections, transient terminal rows and the elapsed ticker. Worker projection omits `LaneRecord.startedAt`; a solo worker can replace the parent subject with an untimed item.
- [`handleInteractiveEvent`](../../packages/coding-agent/src/modes/interactive/interactive-event-controller.ts) removes and rebuilds background-tool items on each `background_tools` notification. This resets timestamps for surviving tasks.
- [`LaneRecord`](../../packages/coding-agent/src/core/autonomy/lane-tracker.ts) already carries optional `startedAt` and `completedAt`. A running transition sets `startedAt`; no additional worker heartbeat is needed to show elapsed time.
- [`BackgroundToolTaskRecord`](../../packages/coding-agent/src/core/background-tool-task-controller.ts) stores handoff `startedAt` and `elapsedBeforeHandoffMs`. Its live view currently omits timing. Handoff time is not the beginning of the tool operation.
- [`RuntimeStatusController`](../../packages/coding-agent/src/modes/interactive/runtime-status-controller.ts) owns runtime label customization and custom loader behavior. Labels are presentation, not reliable execution-state evidence.
- [`ForegroundRecoveryController`](../../packages/coding-agent/src/core/foreground-recovery-controller.ts) already owns the submission lease/epoch and exposes activity subscriptions. Acquisition brackets asynchronous preparation, not just provider streaming. Reuse this owner to bracket the parent lifecycle.
- [`ActiveToolCallRegistry`](../../packages/coding-agent/src/modes/interactive/components/active-tool-call-registry.ts) owns active foreground call identities. [`ToolInvocationReport`](../../packages/agent/src/tool-invocation-report.ts) owns receipt identity/deduplication and categorized outcomes. Its `calls` count includes running and not-started receipts, not only completed executions.
- [`WorkbenchController`](../../packages/coding-agent/src/modes/interactive/workbench-controller.ts) starts workspace observation at `beginCycle`, but receipt-cycle rollover is deferred until `beginEvidence`. Previous evidence can remain visible into the next turn.
- [`process-liveness.ts`](../../packages/coding-agent/src/core/process-liveness.ts) now preserves unknown errors for valid PIDs, but optional/invalid PID still returns false. [`process-matrix/store.ts`](../../packages/coding-agent/src/core/process-matrix/store.ts) accepts nonpositive safe integers. [`runtime.ts`](../../packages/coding-agent/src/core/process-matrix/runtime.ts) uses a false boolean to enter dead-worker resume.

Reproduced during review: a worker row with no clock after 60 seconds; background task A showing 10 seconds after actually running 40 seconds; running and not-started receipts both contributing to `calls`; stored PID 0/-1 being accepted and classified false. Valid-PID EINVAL/ESRCH classification passed a separate production-path fault injection.

The baseline above records the original defects. The sections below specify the implementation contract.

## 2. Ownership: retain truth, centralize presentation

**Execution owners remain unchanged.** The agent event stream owns parent/tool lifecycle facts; the lane registry and durable lane projection own workers; the background controller owns detached tasks; receipt reporting owns execution outcomes. Task steps and goals are plans, not evidence that a process is working.

**`ActivityLaneComponent` remains the sole presentation-state and elapsed-refresh owner.** Refactor its existing reconciliation rather than adding a parallel `WorkTracker`. If a pure reducer is extracted for tests, it replaces the corresponding component logic; it must not retain a second state store or run a second timer.

**The event controller is an adapter.** It translates lifecycle events and snapshots to scoped updates. It must not implement its own clock, infer status from strings such as `Working...`, or clear unrelated owners' items.

**The renderer is pure.** Given a normalized snapshot, width and current time, it selects a bounded row. It cannot start/finish work, recover workers, probe processes, or read the transcript.

**Workbench is a projection.** It consumes the existing active-call registry and receipt report. Do not add another invocation ledger to make the header update.

## 3. Identity and reconciliation contract

Retain stable owner-qualified identity:

- Parent: session plus the existing foreground submission epoch. `runtime:turn` may remain the presentation key, but its clock is replaced only for a new submission, not by relabeling or a retry's `agent_start`.
- Foreground tool: session and `toolCallId`.
- Background tool: session and `taskId`, with its existing `toolCallId` link.
- Worker task: lane identity, not display name or retained specialist identity. Reusing a specialist for a new task must not inherit the previous task's clock.
- Retry/admission/compaction: scoped runtime overlays with their own lifecycle; they do not erase worker or background items.

For each complete source snapshot, reconcile IDs in one pass: update existing items, create new IDs, remove only IDs absent from that same source. A label, count, order, or metadata change preserves timing. Unchanged updates are render no-ops. Incremental events update only their identified item.

Snapshots must be scoped to the current session/controller generation. On session switch, dispose the old subscription and presentation state; ignore callbacks from that old generation. Existing producer sequencing remains authoritative—do not create a generic cross-process versioning protocol for this UI patch.

Foreground-to-background handoff is one invocation, not two. Use `toolCallId` to coalesce the overlap while the foreground end event and live-background snapshot arrive in either order. A foreground end receipt with execution=`running` ends the foreground presentation, not the background operation. Only the background owner can end that task.

## 4. Clocks: accurate origin, continuous display

1. Project valid worker `startedAt`; preserve its meaning across refreshes. Queued and running transitions are different phases: when the producer supplies a new running start, reset the phase clock once.
2. Add optional `startedAt` and `elapsedBeforeHandoffMs` fields to `BackgroundToolTaskLiveView`, projected from the existing record by its owner. Compute operation origin as handoff time minus validated pre-handoff elapsed duration. Do not overwrite historical record semantics or add new persistence writes.
3. For current-process events, anchor elapsed time to an injected monotonic clock. Convert a producer wall-clock timestamp to a nonnegative initial age once at activation, then add monotonic deltas. A wall-clock correction must not move an active displayed clock backwards.
4. If an older record has no trustworthy origin, retain a first-observed anchor and label it `observed 12s`, not `running 12s`. Reject malformed/nonfinite/negative durations; future timestamps must not produce negative elapsed time or silently claim a known start.
5. Ending a task freezes its duration. Terminal display expiry is independent of execution completion. A new task gets a new identity/phase clock.
6. One existing one-second ticker services visible timed active/waiting items, including canonical workers. Stop it when no timed activity remains and on disposal. No per-worker timers; no OS polling; no filesystem reads on ticks.

Elapsed means time in the named lifecycle/phase, not CPU time or proof of progress. This design deliberately does not add a fabricated `last progress` value for workers that publish no progress evidence.

## 5. State and display rules

Derive parent phase from explicit events and overlays, never from a customizable label. The parent-run clock is context, not an extra executable task in concurrency counts.

Expose a minimal read-only foreground activity snapshot through the existing session/UI adapter: session identity, submission epoch and busy/settled state from `ForegroundRecoveryController`. Its subscription establishes Preparing at lease acquisition and settlement at lease release. Existing routing/provider/tool/retry/compaction events refine the phase. This closes the gap before streaming begins without adding another lease or execution owner. An intermediate `agent_end` with retry pending is not submission completion; retry/compaction retain the total submission clock while their phase clocks are separate. Test cancellation during preparation and errors that never reach `agent_start`.

- **Working:** parent execution, a foreground invocation in flight, a running worker, or a running background task exists. A parent admission/retry wait does not hide independently running work.
- **Waiting:** no running work exists, but there is a known wait: provider admission, retry countdown, queued dependency/capacity, or an input request. State the reason. An input request says `Awaiting you`, not `Thinking`.
- **Paused:** no running work or concrete wait remains, but unfinished plan/goal state exists. A pending plan alone must not animate as work.
- **Done:** the parent has ended and all relevant execution owners report no active work; show the existing bounded terminal transient, then Ready or Paused as appropriate. Ending the parent while workers continue must not produce an overall Done claim.
- **Unknown:** a source cannot establish current activity or origin. Show uncertainty rather than treating it as either active progress or completion.

Primary row rules:

- A live foreground parent keeps its clock when tools/workers appear; a solo tool must not silently replace it with an untimed subject.
- If only background/worker work remains, display an explicit background-work subject and the oldest trustworthy active origin, labeled `oldest`, or an `observed` age if no origin is known. Counts are active entities, not retained idle specialist sessions.
- Running and waiting groups are separate. A parent wait is secondary while other work runs. When only waiting remains, the wait reason becomes primary.
- On narrow terminals, preserve state and one clock first; truncate/drop plan text and terminal-event decoration before those essentials. No minimum-width overflow from long labels or multibyte text.

Illustrative layouts, not fixed strings:

```text
Working 1m24s       2 tools · 2 agents       Step 2/5
Background work    2 tasks · oldest 2m10s
Working 34s        1 agent                  Parent awaiting provider
Awaiting you       observed 18s
Paused             2 plan steps remaining
Done 2m11s
```

Custom loader/working-visibility settings remain respected. The custom loader is an alternative rendering surface for the parent, not another lifecycle owner. Opting out of the parent indicator must not erase background execution truth or silently re-enable the parent indicator on routing completion.

## 6. Tool accounting: name what is actually measured

Do not present receipt `calls` as “completed tools.” Use explicit categories:

- **In flight:** foreground identities currently tracked by `ActiveToolCallRegistry`. This includes time awaiting admission/hooks; it is not proof that the operation has started.
- **Completed:** receipt `succeeded + negative`; operation errors remain completed operations.
- **Not started:** receipt `notStarted`. These requests did not execute and must never inflate Completed.
- **Unknown/unclassified:** disclose separately; missing receipts are not success.
- **Background:** session-scoped running tasks, deduplicated across handoff by `toolCallId`. Keep this scope separate from current-turn outcome counts.

Routing, argument repair and harness-internal substeps do not create extra invocation identities. Same-identity updates refine an outcome without increasing call count. A late background terminal receipt stays associated with its original invocation/cycle; it must not inflate the new turn.

Define one receipt cycle as one foreground submission epoch. Advance it once when the foreground owner acquires a new submission, before preparation; do not reset it on retries, compaction or repeated `agent_start` within that submission. Remove delayed `beginEvidence` ownership of that boundary. Previous previews may remain until replacement, but label them `Previous turn`; current-turn counters start from zero immediately. Do not silently reset the invocation's background identity or its original cycle binding. Historical evidence without an epoch remains historical/unknown rather than being assigned to the current submission.

Reuse `ToolInvocationReport` for receipt accounting; expose a small read-only active-count projection from the existing active registry rather than maintaining another counter. If a total observed-receipt count is retained, label it literally and preserve the report's partial/saturation disclosure.

## 7. Liveness: separate observation from authority

Do not globally reinterpret optional-PID boolean callers. “No PID supplied” can legitimately mean “no configured process” in reload, admission or auto-learn code. It must not mean an owner was proven dead.

Use the existing three-valued process-tree observation as the single OS classification owner: `alive | dead | unknown`; only ESRCH produces `dead`. Add an injectable probe seam there if needed for deterministic tests, instead of maintaining a second error classifier in coding-agent code. Invalid/nonpositive/non-safe PIDs must not be sent to signal-zero group semantics; strict observation returns unknown without probing.

At the process-matrix boundary:

- Validate persisted required and optional PID fields as positive safe integers when present, including parent and pane PIDs. Missing required identity is invalid. Reject malformed records from actionable recovery input; do not auto-delete or repair them into a valid identity.
- Migrate authority-sensitive supervisor/runtime decisions from a generic boolean to explicit observations. Unknown means defer; dead authorizes the existing dead-path only after the existing session/task/claim checks; alive permits the existing live-path only after its existing ownership checks.
- Apply this to orphan detection, reconciliation, adoption/directive acceptance and dead-worker resume, not merely one `if` statement. Audit all `ProcessMatrixRuntimeConfig` and supervisor dependency callers/test harnesses as one migration. No silent fallback to a legacy boolean in recovery.
- Keep existing claim/CAS checks. A liveness result is not a lease, cleanup proof, or protection against PID reuse. No new repeated probing on successful foreground tool calls.

Alternative rejected: only adding `pid > 0` to one store field. That plugs one input but leaves the ambiguous authority API and malformed optional parent fields. Alternative rejected: returning true for every absent optional PID globally, which can change unrelated caller behavior.

## 8. Presentation compatibility

Keep the existing `shift+enter` and `ctrl+j` default bindings, legacy LF handling, Kitty CSI-u tests, and user keybinding precedence. Add live terminal acceptance coverage rather than changing the input parser again without evidence.

Execution labels and ordinary output retain conversation `toolTitle`/`toolOutput`; diffs/errors retain semantic colors. Plan/team item text uses theme text; headings and status glyphs retain status colors. Edge stays hidden from the inspector while authorization enforcement and existing grants remain unchanged. Hiding a section is not granting new authority.

No stored session-schema rewrite is required for UI timing: new live-view fields are additive, and historical unknown timing is explicit. Strict malformed-PID rejection is a compatibility boundary and needs diagnostic coverage.

## 9. Performance and implementation route

### Budget

Preserve the existing one-second refresh cadence. Work per actual source update is linear in that source's current entries; per render/tick is bounded to active presentation state, never full transcript history. Keep existing bounded terminal retention and receipt budget. No per-token full snapshot rebuild, history serialization, new polling, per-entity interval, or extra successful-tool filesystem operation.

Before merging, compare the same baseline and candidate event/render fixtures: 0, 1, 8 and 32 active entities, plus a long historical transcript with the same active set. Assert one ticker, no idle ticks, no filesystem/probe calls from rendering, unchanged-update no-op behavior, and bounded retained state. Measure repeated-run latency/allocation deltas; investigate any sustained regression rather than inventing an unmeasured millisecond budget.

### Route and write ownership

1. **Characterization first:** add failing deterministic cases below; preserve the previous fixes and their tests. Record failures for the intended reason.
2. **Independent backend patch:** process observation seam, PID validation, process-matrix authority callers and tests. No TUI writes.
3. **TUI lifecycle integration owner:** foreground-owner activity projection through the session adapter, background live-view timing, keyed reconciliation, clock normalization, parent phase/aggregate selection and one ticker. One owner handles activity/event/runtime-status integration to prevent competing state machines.
4. **Parallel input/presentation verification:** Ctrl+J, text tokens, hidden Edge and narrow-width acceptance; no overlapping activity/event implementation writes.
5. **Dependent workbench patch:** explicit receipt categories, active-registry projection, real cycle boundary and late-background behavior after lifecycle semantics are fixed.
6. **Integration gate:** focused suites, TypeScript, repository checks, build/import checks, rendered/interactive acceptance, performance comparison, diff review and documentation cleanup. Fix the known Biome formatting failure. No commit until an explicit follow-up authorizes one.

Retire remove-all/recreate background handling, label-string state inference and delayed receipt-cycle rollover as their replacements land. Do not keep compatibility branches that reintroduce two owners of the same invariant.

## 10. Acceptance gates

Use injected clocks, deterministic events and barriers; no sleep-based race tests. Each group includes a negative control.

1. **Worker continuity:** one/multiple workers with parent active/ended; queued-to-running; specialist reused for a new lane; no start timestamp; repeated unchanged snapshot. Assert visible state/age and one ticker. Control: only a pending plan or retained idle specialist creates no Working state.
2. **Background continuity:** A at t=0, B added at t=30, inspect at t=40: A remains 40s, B is 10s. Preserve pre-handoff duration. Exercise foreground-end/live-view ordering both ways, removal, completion and session switch. Control: a genuinely new task gets a new clock.
3. **Runtime phases:** lease acquisition/preparation before routing or agent start; preparation failure/cancellation without agent start; routing before/after agent start; thinking/text deltas; retry/admission wait; compaction; cancellation; awaiting input; parent end while children run; custom loader and visibility. Retry within the same submission retains the total clock and receipt cycle. Control: a label change alone cannot start, stop or restart work.
4. **Clock integrity:** wall-clock forward/backward jumps; missing/future/invalid timestamps; terminal freeze; disposal. Control: unknown origin is labeled observed, never silently known.
5. **Accounting:** concurrent in-flight foreground calls; not-started denial; completed error; running handoff; duplicate/conflicting receipt; background result in next turn; partial report. Control: routing and same-identity updates add no calls/completions; historical previews do not masquerade as current counts.
6. **Liveness authority:** ESRCH, EPERM, EINVAL, no-code errors; zero/negative/fractional/unsafe/missing PID; malformed optional parent/pane fields; stale claim; mismatched session/task. Assert no takeover/write/resume for unknown or invalid input. Control: valid ESRCH with valid ownership can use the existing recovery path, while valid live entries retain the live path.
7. **Rendering/input:** representative dark/light themes, narrow widths, long and multibyte labels, color-token assertions, CSI-u/legacy newline and normal Enter submission. Control: no Edge inspector section and no change in authorization decisions.
8. **Performance:** baseline/candidate fixtures and resource assertions from section 9; verify no work continues after disposal.

The completed implementation must pass source-configured coding-agent tests and the TUI node:test route, TypeScript, the full repository check, and a production-shaped build/interactive smoke check. The prior review passed 221 coding-agent and 248 TUI tests plus TypeScript, but failed repository formatting; that is baseline evidence, not acceptance of this proposed implementation. Root-config tests also encountered stale agent dist exports, so verify source alias routing and built-package imports separately.

## Delivery boundary

No provider requests, release build, full local test suite, or publication are part of the local validation recorded here. Publication requires the repository's separate release gates.

### Hosting-terminal termination regression

Repeated workspace-observation replacement or disposal after a failed Git spawn reproduced caller-process-group SIGTERM. Node's native `execFile` AbortSignal handler called `ChildProcess.kill()` before a successful spawn, while its native handle had no positive PID. The same focused workbench tests previously terminated with exit 143.

Workspace queries now omit the native signal option and use the shared successful-spawn-fenced abort binding. Deterministic detached fixtures reject any attempt to kill an invalid handle; settled failures are negative controls, and a real owned child proves successful cancellation still works. Process-tree termination also rejects self, ancestors, and protected process groups, and test entrypoints remove inherited Herdr/worker ownership context.

This is a confirmed signalling defect matching the observed termination. It does not establish which Herdr component received the original signal: the saved session contains no explicit Herdr shutdown command, and no original signal trace or OOM evidence was recovered. Numeric PID reuse and native macOS process ancestry remain separate validation limits.

### Windows process-cleanup verification

Native Windows probes confirmed that a complete process snapshot can retain a creator PID whose process has exited. The ancestry reader now distinguishes that historical absence from an observation failure and protects every recorded ancestor PID. A current snapshot cannot reconstruct surviving historical ancestors above that break.

Concurrent Windows probes reproduced ancestry-query timeouts. The final five-second bound passed 16 concurrent observations in two batches alongside compilation, and both native termination APIs cleaned up owned child/grandchild trees with child-exit and named-pipe-close evidence. However, [CI run 35111952439](https://github.com/Caupulican/pi-adaptative/actions/runs/35111952439) confirmed that the five-second observation can still time out alongside the parallel CPU and large-file tests. This is a remaining cleanup-availability limitation: failed observation refuses termination and can leave owned work running; it never authorizes an unverified signal.

The unchanged native adapter control runs in a mandatory isolated CI phase on both platforms. Deterministic timeout, malformed-observation, and no-signal tests remain in the parallel suite. Workflow regressions enforce that exclusion from the parallel phase requires the isolated phase, and release proof requires that phase to pass. These gates prove native cleanup when observation succeeds and safe refusal when it fails; they do not prove cleanup availability under arbitrary contention.

### Performance evidence

The same baseline/candidate activity fixtures used 0, 1, 8, and 32 entities, with 10,000 retained historical messages. Repeating unchanged snapshots produced 7,200 render requests in the baseline and zero in the candidate. Active-parent render medians varied between runs; the measured delta at 32 entities was approximately 7–10 microseconds. Detached rendering added approximately 31–44 microseconds to display the previously absent state and elapsed clocks. These measurements show bounded additional display work, not a general speed improvement.

V8 sampled allocation per render at 0/1/8/32 entities was approximately 164/6,429/20,785/26,363 bytes before and 192/6,994/20,781/26,935 bytes after. Timing and sampling are environment-dependent; deterministic tests separately cover one ticker, unchanged-update no-ops, disposal, bounded terminal retention, and rendering independent of transcript history.

### Interactive acceptance

The production source CLI started through its runtime snapshot/supervisor in a dedicated disposable tmux server, with isolated agent/session directories and no inherited Herdr/worker authority. The project trust prompt was answered with session-only refusal. Ctrl+J retained `first line` and `second line` together in the actual editor; Ctrl+C cleared the input and Ctrl+D exited with code 0. No provider prompt was submitted. Earlier captures that reached only the trust prompt were not counted as editor acceptance. Native provider execution, live Windows/macOS terminal behavior, and a packaged release build remain untested here.

The two changed process-reliability modules were separately emitted by TypeScript 7 using the agent package's build configuration into a disposable package fixture. Native Node imported their new exports through the unchanged package manifest's default `process-tree` entry, without `pi-source`; invalid-PID observation and protected-self termination controls passed. This verifies the changed compiled import boundary without rebuilding or overwriting the installed/live package artifacts.

### Independent challenge review

The independent reviewer reproduced and required fixes for cross-session clock inheritance, input classification with a hidden parent, custom-loader gaps before lease settlement, foreground/background admission collisions, and external waits being erased by parent lifecycle or visibility changes. Each received a focused regression and negative control. Parent-owned runtime filtering now has one predicate; independently owned waits survive until their own end event.

An asynchronous event continuation across session navigation was investigated as a candidate, but a reachable overlap was not established. The tests prove stale callbacks invoked after rebinding are fenced; they do not claim to exhaustively cover every already-running asynchronous callback during navigation.

### Final verification

- Independent final focused rerun: 81 tests across seven files passed. A separate 96-combination display matrix produced 384 renders at widths 20/40/100/180 without the checked state, ownership, timing, or overflow violations.
- Focused process-matrix/liveness coverage: 137 tests across 12 files passed. Separate process-target, ancestry, owned-child cancellation, terminal evidence, and isolated failed-spawn regressions passed. Foreground recovery/supersession checks passed 25 tests.
- TUI input regressions passed 245 tests. The live source-terminal and isolated compiled-import checks above passed.
- `npm run check` exited 0, including TypeScript, browser smoke, coordinator boundaries, installer/binary regressions, and the production clone gate. A final whole-root Biome check covered 2,487 files with no fixes or findings. npm emitted an existing environment-level `globalignorefile` configuration warning; repository checks did not emit source warnings.
- Clone coverage verified 1,036 eligible files out of 1,045 owned files, with explicit exclusions and size headroom checked; 1,004 files entered the 50-token detection pass, and zero production clones were reported. Largest owned source: 4,755 lines / 189,328 bytes. Ownership review also removed duplicate shell termination and liveness classification paths.
- `git diff --check` passed. This local verification preceded commit and release; it performed no installation, full local test suite, or provider API call.
