# System One Recovery State

> Recovery work log. Current source wins over the bundle when they disagree.

## Identity

- Recovery bundle: v1.1
- Bundle reviewed head: `565098ec453b69495322aa3cd4207ac8aac0fa5c`
- Broken release baseline: `2b6de7054bcdb130bc90347707cbb3ba87b9bb05`
- Current branch: `main`
- Current HEAD: `565098ec453b69495322aa3cd4207ac8aac0fa5c` (pre-repair; recovery commit follows)
- Last updated: 2026-09-20
- Agent/run identifier: grok-goal-5b3e99df1a5e

## Working tree

```text
(clean at census; recovery edits in progress after this file)
```

## Newer commits reconciled

- none after `565098ec453b69495322aa3cd4207ac8aac0fa5c`

Post-release commits that remain and must not be reset:

- `b0d1093e7` — tool-gate `replan` refuses one call, not the turn
- `565098ec4` — relevance question omitted when there is no real step/goal
- `67690389f` / `7e0aa5cd4` — idle is not a running stage; READY/dormant projection
- `76a89fbea` — owned-child termination by handle

## Jev confirmation (this run)

Live `typesafe-review` against HEAD `565098ec`, model `jev-1.13.0`, min-confidence 0.90. Evidence: `{SCRATCH}/jev-evidence/*.report.txt`.

| Packet | Gate | Answers (all required Choice = yes) |
|---|---|---|
| `tool-gate-jev` | passed | `runStageValidation` awaits `this.adapter.evaluate` (1.00); `validateToolGate` runs stage `"tool_gate"` (0.97); `beforeToolCall` awaits `validateToolGate` (1.00); `outcome === "block"` returns `block: true` (0.98); adapter awaits `this.reviewer.evaluate` (1.00) |
| `required-policy-wiring` | passed | `DEFAULT_STEERING_POLICY.mode` is `system_one_required` (1.00); `certificate_required: true` (1.00); `fail_open: false` (1.00); SDK constructs `TypeSafeReviewer` (1.00); SDK plane gets `DEFAULT_STEERING_POLICY` (1.00); plane builds `TypeSafeSystemOneDecisionEngine(deps.adapter, model)` (1.00) |
| `route-jev-004` | passed | `requireCertificate("JEV-004", ...)` (1.00); no-router path awaits `decisionEngine.evaluate` (0.98); router path awaits `evaluateOrFallback` (1.00) |
| `preflight-postflight-consumption` | passed | preflight throws only when `route === "block"` (0.97); postflight awaits `validatePostflight` without reading the return (1.00) |
| `default-policy-synthetic` | passed | default `allowedProvenances` includes `synthetic_self_report` (1.00) |

### What that means

Jev **is** the active semantic gate on the production tool-admission path and on the default steering-plane path (TypeSafe reviewer + `TypeSafeSystemOneDecisionEngine` + `system_one_required`). It is **invoked but not fully in control** on foreground preflight (non-`block` routes ignored) and postflight (return discarded). A supplied `DecisionEngineRouter` can still select `synthetic_self_report`. Those last three are the recovery blockers, not a finding that Jev is unused.

## Ownership map

| Responsibility | Canonical owner | Production producer | Production consumer | Durable? | Jev-owned? | Status |
|---|---|---|---|---|---|---|
| Goal/objective truth | GoalState + DurableTaskRuntime via SessionObjectiveRuntime | `GoalSessionController.saveState`, `synchronizeGoalState` | `ObjectiveExecutionController.reconcileObjective` | yes (session + orchestration store) | no (facts) | live |
| System One ExecutionStore | hydrated projection of the row above | `projectCanonicalTruth` + `hydrateFromCanonical` before every stage | `SystemOneController` stages + completion | in-memory projection; reconstructs from durable goal/runtime/verification | no | B1 FIXED |
| Route decision | ObjectiveExecutionController + composeObjectiveRoute | JEV-004 via SteeringPlane when bound; decisions router if injected; System One control directives | `runLoop` executors | ledger route rows | yes (JEV-004) | live; B10 synthetic reject in required mode |
| Tool semantic gate | SystemOneController.validateToolGate | `adapter.evaluate` / Jev | ToolGateController.beforeToolCall (block/replan refuse the call) | tool_events in store | yes | live; replan is `refused` |
| Tool terminal outcome | afterToolCall `recordToolTerminal` | tool runner | ExecutionStore tool_events + postflight last_action | transcript durable; store updated in-process | no (facts) | B5 FIXED |
| Evidence | Goal evidence + DurableTaskRuntime evidence + verification obligations | goal events, task runtime, VerificationObligationTracker | CompletionCoordinator on runtime; SystemOne completion on hydrated store | yes (goal + orchestration + session messages) | mixed | B1/B6 FIXED |
| Verification | VerificationObligationTracker | bash/test host | hydrated as ExecutionStore.verification; G-TEST/G-VERIFY | session messages | no | WO-04 FIXED |
| Dedup | SemanticResponsibilityController + SteeringPlane JEV-041.. | steering certificates | mutation/completion | certificates | yes | live owner; SystemOneController.validateDuplicateLogic is a duplicate stage pack |
| Completion | CompletionCoordinator + SteeringPlane JEV-024/025/026; SystemOneController.executeCompletionTransaction as semanticEvaluator | agent-session bind | ObjectiveExecutionController completion_candidate | certificates + delivery bundle | yes (required profile) | B6 OPEN if store empty |
| Operator projection | SessionOperatorProjection | goal, route, health, lanes | POV bar / decision graph | ledger + session | projection only | B11 live contract |
| Decision ledger | SQLite decision ledger | evaluation observer | graph, route history | yes | records Jev | live |
| Exact predicate authority | deterministic code | gates, budgets, compile/test | policy before Jev | n/a | no | live |
| Bounded semantic authority | System One / Jev | TypeSafeSystemOneDecisionEngine + stage packs | steering + tool gate | certificates / decisions | yes | live on default path; B10 custom router |
| Open-ended cognition | root/worker LLM | model router | executors | transcript | no | live |
| Required semantic fallback policy | no generic LLM | evaluateFresh provenance check | throws SystemOneSteeringUnavailableError on synthetic_self_report | n/a | yes | B10 FIXED at plane boundary; default router policy still lists synthetic for optional mode |

## Work orders

| WO | Status | Commit(s) | Verification | Jev evidence | Notes |
|---|---|---|---|---|---|
| WO-00 | VERIFIED | (this recovery commit) | census | gate-confirm packets | this file |
| WO-01 | VERIFIED | (this recovery commit) | recovery-wo09 hydrate + completion | hydrate-and-control | canonical projection |
| WO-02 | VERIFIED | (this recovery commit) | preflight retrieve + composeObjectiveRoute | preflight/postflight + hydrate-and-control | directives feed composeObjectiveRoute |
| WO-03 | VERIFIED | (this recovery commit) | replan refused + sibling + afterToolCall | replan-refused | call_id correlation |
| WO-04 | VERIFIED | (this recovery commit) | G-OBJ/G-TEST/G-VERIFY | hydrate-and-control | |
| WO-05 | VERIFIED | (this recovery commit) | ownership table | | dead packs documented; postflight owner bound |
| WO-06 | VERIFIED | (this recovery commit) | primary missing controller test | primary_rejects_missing_controller | |
| WO-07 | VERIFIED | (this recovery commit) | synthetic reject test | required-rejects-synthetic | |
| WO-08 | VERIFIED | (this recovery commit) | resume reconstructs requirements | hydrate-and-control | hydrate from durable goal, not persisted store |
| WO-09 | VERIFIED | (this recovery commit) | wo09-run1.log + wo09-run2.log both 88 passed | | |
| WO-AUTH | VERIFIED | (this recovery commit) | synthetic reject | required-rejects-synthetic | mechanical `none` still allowed |
| WO-TUI | VERIFIED | (this recovery commit) | operator-pov-bar + session-operator-projection-control | existing CONTROL/JEV tests | backend fields unchanged; JEV degraded already shown |
| WO-10 | FIXED_UNVERIFIED | | npm run check exit 0; milestone gates exit 0 | | GitHub ci.yml on the recovery SHA is not available until push |

## Findings B1–B11 vs current source

| ID | Status | Notes |
|---|---|---|
| B1 | FIXED | `setTruthSource` + `hydrateFromCanonical` before every stage |
| B2 | SUPERSEDED | Stage packs remain for tests/hooks; production owners documented (SteeringPlane JEV-001..003 / 041 / 025 / stall+JEV-004) |
| B3 | FIXED | non-allow preflight skips the turn; postflight notes a directive composeObjectiveRoute consumes |
| B4 | FIXED | replan stored as `refused` (Jev 1.00) |
| B5 | FIXED | `recordToolTerminal` on afterToolCall by `call_id` |
| B6 | FIXED | completion hydrates first; empty/live-without-criteria fail G-OBJ |
| B7 | FIXED | `withPrimaryOrLegacy` rejects missing ObjectiveExecutionController; SDK throws the same after bind |
| B8 | FIXED | `validateObjectivePostflight` bound; skips a second Jev call when a foreground directive is already pending |
| B9 | FIXED | resume hydrates from durable goal/runtime/verification, not the empty constructor store |
| B10 | FIXED | evaluateFresh throws on synthetic_self_report in `system_one_required` (Jev 1.00). DefaultDecisionEnginePolicy still lists synthetic for optional/advisory routers |
| B11 | FIXED | existing POV/graph tests still pass; CONTROL/JEV fields unchanged |

## Discovered blockers not in original review

- none yet

## Decisions

- 2026-09-20 — Do not reset to `2b6de7054`. Preserve `b0d1093e` / `565098ec` / idle / process-tree fixes.
- 2026-09-20 — ExecutionStore remains a hydrated projection, not a second authority. Canonical truth is GoalState + DurableTaskRuntime + verification obligations.
- 2026-09-20 — Dead SystemOneController stage packs (intake/claim/duplicate/patch/drift) are not blindly wired; production owners are SteeringPlane JEV-001..003 / JEV-041 / JEV-025 / stall+JEV-004. Preflight/tool-gate/postflight/completion stay on SystemOneController and must become executable.
- 2026-09-20 — Jev is the active tool-admission and default steering-plane gate (confirmed). Recovery makes preflight/postflight and required-mode provenance match that.

## Last verified command results

- command: `typesafe-review run .../jev-gate-confirm/packets` then `.../jev-repair-confirm/packets`
- result: 8/8 packets `gate_passed`, model `jev-1.13.0`, all required Choices `yes` at confidence >= 0.97 (repair packets all 1.00)
- command: targeted vitest twice (`wo09-run1.log`, `wo09-run2.log`) — 88 passed / 88 passed
- command: `npm run check` — exit 0
- command: `check:release-readiness`, `check:contract-doctrine`, `check:clones`, `check:coordinator-boundaries` — all exit 0
- commit: pending local recovery commit; GitHub `ci.yml` not run (no push)

## Resume next action

Push the recovery commit when the owner authorizes it, then require `ci.yml` success on that exact SHA (including Windows cancellation jobs). Do not treat local full vitest as a substitute.

## TUI visibility status

| Surface | Canonical source | Must show | Current status | Evidence |
|---|---|---|---|---|
| Team / Decider | semantic plane health + projection | System One/Jev evaluation + control | present | workbench.md / semantic-plane-health.ts |
| Team / Executors | lanes + foreground | root/workers/specialists + models | present | operator projection |
| Team / Routing | route provenance | actual chooser, never invented Jev attribution | present | formatRouteValue |
| POV bar | canonical projection/router/semantic health/cost | CONTROL, ACTOR, ROUTE, JEV, status | present | operator-pov-bar.ts |
| Decision graph | projection + ledger + routes + checks | stages, loop, evidence, checks, next | present | decision-graph-model.ts |
| Execution previews | receipts + Jev evaluations | actor/model/verdict/reasons | present | ledger previews |
