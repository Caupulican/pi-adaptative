# Objective Execution Current Ownership Map

Baseline commit: `5d5abc5dfa4a30a70697b0172cc893004df2fcfb`
Date: 2026-09-19

## 1. Architectural Truth Owners

| Subsystem | Source Location | Responsibility & Invariants |
|---|---|---|
| **Execution Truth** | `packages/coding-agent/src/core/orchestration/task-runtime.ts` (`DurableTaskRuntime`) | Owns objectives, tasks, attempts, worker assignments, capability grants, leases/fencing, checkpoints, dependencies, budgets, and durable execution events. Mechanical execution authority. |
| **Integrity & Epistemic Truth** | `packages/coding-agent/src/core/system-one/controller.ts`, `execution-state.ts` (`SystemOneController`, `ExecutionState`) | Owns observations, claims, hypotheses, evidence freshness, changes, verification gates, semantic validation, policy packs, canary redaction, and atomic completion transactions. |
| **Loop Execution (Target)** | `packages/coding-agent/src/core/objective-execution/objective-execution-controller.ts` (`ObjectiveExecutionController`) | Deterministic loop owner. Owns reconciliation, route composition, dispatch/wait/replan/repair, completion transaction invocation, and explicit terminal reasons. |
| **Semantic Referee** | `packages/coding-agent/src/core/system-one/` (`TypeSafeSystemOneDriver`, `jev-1.13.0`) | Semantic referee for decomposed questions (`work_remaining`, `missing_work_class`, `independent_worker_required`, `capability_escalation_required`, `external_blocker_present`, `semantic_progress`, `context_stale`, `strategy_repetition`). Does NOT own loop scheduling, terminal authority, or provider/model selection. |
| **Model Selection** | `packages/coding-agent/src/core/autonomy/model-router.ts`, `capability-gateway.ts` | Selects exact provider and model within configured policy. Jev selects work class, Pi selects who executes. |
| **Worker Cognition** | `packages/coding-agent/src/core/orchestration/worker-execution-contract.ts`, `worker-delegation-controller.ts` | Bounded worker execution, leases, and contracts. Worker can only propose `completion_candidate` and never terminalize. |
| **Legacy Continuation (Phased Out)** | `packages/coding-agent/src/core/goal-loop-controller.ts`, `goals/goal-session-controller.ts` (`GoalLoopController`, `GoalState`) | Legacy prompt-continuation loop. Non-authoritative in `objective_shadow` and `objective_primary` modes; bridged by `GoalCompatibilityAdapter`. |

## 2. Invariant Rules & Boundaries

1. **No Fourth State Machine**: The `ObjectiveExecutionController` persists only minimal loop metadata (cycle id, last route, stall fingerprint, active repair batch, terminal reason). It does NOT create a parallel objective/task/evidence database.
2. **Authority Hierarchy**:
   `deterministic code / policy > mechanical evidence > semantic validation > worker assertion`
3. **Model Selection Independence**: Jev evaluates semantic work class; the existing model router and capability gateway select the concrete worker model.
4. **Terminal Gating**: `complete` is not a standard route; it is only committed via `SystemOneController.executeCompletionTransaction`.
5. **Worker Boundary**: Workers propose `completion_candidate`; only the harness commits completion.
6. **Rollout Modes**:
   - `legacy_goal`: Original `GoalLoopController` active.
   - `objective_shadow`: `GoalLoopController` active; `ObjectiveExecutionController` computes route in shadow mode and records disagreement telemetry.
   - `objective_primary`: `ObjectiveExecutionController` drives continuation; legacy goal tools route through `GoalCompatibilityAdapter`.
