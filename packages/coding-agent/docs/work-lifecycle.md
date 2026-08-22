# Five-step work lifecycle

This document is the canonical design for how Pi carries a request from first inspection to verified delivery. It defines five phases only, then maps each phase onto existing `goal`, `task_steps`, delegation, evidence, and approval owners. For tool syntax, read [Task steps](task-steps.md) and [Task worker presets](worker-profiles.md); this document does not duplicate those references.

## Confidence and scope

**Confirmed:** current Pi claims were checked against the source paths cited below. **External comparison:** Codex observations were checked against the adjacent `external/codex` checkout and are not claims about Pi. **Not checked:** provider-specific compliance beyond the deterministic prompt and gate tests, stochastic routing quality, and runtime performance under a large worker fleet.

## Core invariant

Pi uses this one five-phase spine:

1. **Survey**
2. **Contract**
3. **Plan/Route**
4. **Execute**
5. **Prove/Deliver**

The phase list is source-owned by `WORK_LIFECYCLE_PHASES`. Every root prompt receives the phase contract; the owner-specific line appears only when a goal or planning tool is active, and child workers keep their narrower contract (`packages/coding-agent/src/core/provider-prompt-contracts.ts:11-15`; `packages/coding-agent/src/core/system-prompt-builder.ts:261-277,316-333`). Chat-class models receive the same five phases in a 63-character compact form so their stable prompt remains inside the 2,048-character capability envelope (`packages/coding-agent/src/core/model-capability.ts:46-64`). Short or read-only work may collapse phases, but it must not invent a sixth phase or another workflow state machine.

State ownership stays singular:

- `goal` owns the desired outcome, acceptance requirements, and trusted evidence.
- `task_steps` owns the foreground execution plan.
- `delegate` and the orchestration runtime own worker identity, attempts, grants, results, and independent verifier lanes.
- the risk and policy gates own authorization decisions.
- the root session owns integration and the final acceptance decision.

The runtime already joins these owners through a read-only projection; it does not cross-write their stores (`packages/coding-agent/src/core/orchestration/work-state-projection.ts:111-167`; `packages/coding-agent/src/core/goals/goal-runtime-snapshot.ts:18-87,136-151`).

## 1. Survey

Start project work with bounded, read-only discovery. Read the relevant project instructions, entry points, nearby tests, affected contracts, and existing implementation owners. Stop discovery when the evidence is sufficient to state a delivery contract and its uncertainty; do not scan the whole repository by default.

Survey happens before project mutation and before final delivery classification. Pi's existing model router is intentionally not the delivery classifier: routing receives the expanded original prompt during request preparation, before request-model validation and tool execution (`packages/coding-agent/src/core/agent-session.ts:2602-2624`; `packages/coding-agent/src/core/model-router-controller.ts:438-464`; `packages/coding-agent/src/core/risk-classifier.ts:87-179`). Reusing that prompt-only classifier for project scope would make POC-versus-complete decisions without source evidence.

**Exit condition:** relevant project facts, affected surfaces, uncertainty, and consequential owner choices are known. Routine implementation choices remain with Pi.

## 2. Contract

Translate the request and Survey evidence into a project-relative outcome contract. Record that contract in the goal objective and requirements, not in task titles. Goal state already owns requirement status and evidence bindings (`packages/coding-agent/src/core/goals/goal-state.ts:34-128`), and the goal tool now tells the root to make delivery depth explicit after Survey (`packages/coding-agent/src/core/tools/goal.ts:428-442`).

Use these delivery meanings:

- **POC:** a bounded executable proof that establishes whether the requested capability works. Production integration is intentionally outside the contract unless explicitly named.
- **MVP:** the smallest usable project slice that proves the requested feature in its real context. Deliberately omitted integrations must be explicit.
- **Complete feature:** a production-ready feature integrated across every affected project surface. A demo, isolated helper, or passing happy-path test is not complete.

For a complete feature, inspect and include every applicable surface: public entry points and callers; types and wire contracts; configuration and defaults; persistence, migration, and compatibility; cancellation, failure, retry, and resume behavior; UI or CLI exposure; tests and production-shaped verification; documentation and changelog; obsolete-path cleanup. “Applicable” matters: the contract must not manufacture irrelevant work merely to fill a checklist.

**Exit condition:** acceptance criteria distinguish requested outcome from implementation method, name the delivery depth, cover applicable project integration, preserve authority boundaries, and identify what evidence can prove each criterion.

## 3. Plan/Route

Create the mutation plan in `task_steps`, link steps to goal requirements, and keep one step active. `task_steps` already enforces one active item and preserves notes/evidence (`packages/coding-agent/src/core/tasks/task-state.ts:358-400,431-488`); its tool contract now makes Plan/Route precede project mutation and forbids a second outcome state (`packages/coding-agent/src/core/tools/task-steps.ts:316-332`). Detailed plans may contain more than five checklist items—the five-item limit applies to lifecycle phases, not implementation decomposition.

Choose solo versus team execution adaptively. Long duration alone never mandates a team. Evaluate:

- risk and invariant sensitivity;
- uncertainty and missing expertise;
- urgency and available parallelism;
- reversibility and blast radius;
- test strength and verification cost;
- cognitive load and integration coupling.

Keep dependent, trivial, context-heavy, or interactive work local. Delegate separable discovery, implementation, tests, or specialist review when doing so improves speed or confidence. Require a different reviewer identity when the factors make implementation self-review insufficient. Worker profiles already support mandatory independent verification and resolve a dedicated verifier shipment (`packages/coding-agent/src/core/delegation/worker-delegation-controller.ts:710-734`).

**Exit condition:** ordered work, stable owners, dependencies, acceptance evidence, verification depth, and solo/team route are explicit before mutation.

## 4. Execute

Work the first open plan item. The root remains integration owner; a worker result is evidence, not accepted truth. Workers receive immutable authority and result contracts through the existing orchestration runtime rather than a lifecycle-specific executor (`packages/coding-agent/src/core/orchestration/contracts.ts:367-509`; `packages/coding-agent/src/core/orchestration/policy-gate.ts:10-30`).

Record changed files, focused tests, rejected hypotheses, and blockers on the relevant task and goal requirement. Wait event-driven at true dependencies. Worker terminals already pass through one durable notification coordinator and one foreground handoff path; matching active-goal completions wake the parent (`packages/coding-agent/src/core/background-lane-controller.ts:174-200`; `packages/coding-agent/src/core/foreground-terminal-handoff-controller.ts:197-205,341-429`). The goal continuation decision waits on bound in-flight workers and resumes once work can advance (`packages/coding-agent/src/core/goals/goal-continuation-controller.ts:284-353`).

A failed implementation or review does not create a new phase. Update Contract only if the requested outcome changed; otherwise return to Plan/Route or continue Execute with the new evidence.

**Exit condition:** planned mutations are integrated, no required work is silently deferred, and evidence is ready for independent acceptance.

## 5. Prove/Deliver

Verify from narrow to broad in proportion to risk: focused reproduction and negative control, adjacent tests, type/build/static gates, then production-shaped checks when the contract requires them. Independent review must inspect the integrated result, not only worker claims or exit codes. Goal completion already distinguishes proven requirements from open work, waits for cited background tasks, and requires an explicit completion transition (`packages/coding-agent/src/core/goals/goal-continuation-controller.ts:198-237`; `packages/coding-agent/src/core/goal-loop-controller.ts:88-199`).

When checks are green and the owner requested or authorized a checkpoint, create a local commit inside Prove/Deliver. Commit is not a sixth lifecycle state. The risk classifier now admits one plain local `git commit` as a reversible scoped write, while composed shell commands, history-rewriting commits, push, reset, clean, stash, rebase, release, deploy, and publish operations stay approval-gated (`packages/coding-agent/src/core/risk-classifier.ts:220-265`; `packages/coding-agent/src/core/autonomy/gates.ts:189-219`). A commit message containing words such as “release” does not turn a local checkpoint into publication.

`git push`, tags, releases, package publication, deployment, destructive operations, credential/authentication changes, settings/authority expansion, and other external side effects remain owner-gated. Approval produces authority for the requested operation; it is not proof that the feature is correct (`packages/coding-agent/src/core/orchestration/contracts.ts:486-509`; `packages/coding-agent/src/core/orchestration/policy-compiler.ts:161-186`).

**Exit condition:** every required criterion has trusted evidence, integrated review is clean, no active work remains, authorized local checkpointing is complete, and either delivery is complete or Pi is explicitly waiting at an external authorization boundary. Any failed criterion loops to Contract, Plan/Route, or Execute.

## Current-code audit

### Retained as authoritative

**Confirmed:** goal state, task state, delegated task runtime, worker lifecycle, foreground handoff, continuation, risk assessment, and approval compilation are live owners with focused tests. The goal/task/worker read model already links stable IDs without merging their mutation paths (`packages/coding-agent/src/core/orchestration/work-state-projection.ts:89-167`). Historical hardening of these owners is documented in [Goal/Task-Steps/Subagent Fix Cycle](goal-task-subagent-cycle-2026-07-19.md); this document links rather than restating that dated fix ledger.

### Rewired in this feature

**Confirmed:**

- one root-only lifecycle contract is always assembled, with goal/task/delegate ownership wording added only when the corresponding planning surface is available;
- goal and task tool guidance directs Contract and Plan/Route into their existing owners;
- delegation guidance makes team use adaptive rather than duration-triggered;
- plain local commits no longer hit the publication/destructive approval path;
- focused tests lock the five exact phases, root/child/tool-surface prompt gating, project-relative delivery wording, adaptive factors, and local-commit negative controls.

No lifecycle database, controller, event type, planner store, or delivery enum was added. Delivery completeness is contextual and belongs in acceptance requirements; a global enum could not determine which project surfaces are applicable after discovery.

### Deliberately not reused as delivery classification

**Confirmed:** `classifyModelRouterRoute(prompt)` and its `intent-classifier.ts` re-export remain model-cost/risk routing mechanisms. They run on prompt text before Survey and cannot safely decide project delivery depth. The orchestration event store remains the delegated execution owner; mirroring root lifecycle phases into it would duplicate goal/task state.

### Residual limits

**Confirmed limitation:** adaptive routing and the decision to request an independent reviewer are semantic decisions made by the root under the lifecycle contract. The host deterministically enforces worker authority and a profile's required verifier once selected, but it does not infer project risk after Survey or auto-spawn reviewers for solo work.

**Confirmed limitation:** automatic local checkpointing means the root invokes a plain `git commit` after green evidence. Pi does not run an ambient auto-commit daemon, because that could capture unrelated owner changes without a proven patch boundary.

**Not checked:** prompt conformance cannot prove every provider follows the lifecycle under all context-pressure conditions. Deterministic prompt-shape tests and completion gates reduce that risk; evidence-gated review remains necessary.

## Codex mechanisms considered

**External comparison, confirmed against the adjacent checkout:** Codex's Thread Store exposes one raw history append API, one metadata update API, and a preferred `LiveThread` path for active persistence (`../../external/codex/codex-rs/thread-store/README.md:3-30`). That supports Pi's one-owner-per-invariant decision; it does not justify copying Codex's storage types.

Codex review launches a one-shot subagent with an explicit review prompt, disables collaboration features inside that reviewer, and marks it as `SubAgentSource::Review` (`../../external/codex/codex-rs/core/src/tasks/review.rs:103-140`). Pi retains the same useful separation—implementation evidence is reviewed by a distinct identity when warranted—through its existing verifier shipment instead of adding a second review subsystem.

Codex approval handling is tool/operation scoped rather than a generic “commit phase”: the tool orchestrator computes an execution approval requirement, requests approval when needed, then attempts the tool under the selected sandbox (`../../external/codex/codex-rs/core/src/tools/orchestrator.rs:154-233`). Pi follows the same separation: lifecycle acceptance and execution authority remain different decisions. No Codex rollout or thread-store code is copied.

## Verification map

- Prompt lifecycle and tool-surface gating: `packages/coding-agent/test/system-prompt-builder-tool-selection.test.ts`.
- Stable compact base prompt: `packages/coding-agent/test/system-prompt.test.ts`.
- Local commit and approval negative controls: `packages/coding-agent/test/autonomy-risk-assessment.test.ts`.
- Existing goal/task/delegate behavior: the focused suites referenced by [Task steps](task-steps.md) and [Goal/Task-Steps/Subagent Fix Cycle](goal-task-subagent-cycle-2026-07-19.md).

## Documentation scope note

Covered in depth: lifecycle semantics, delivery-depth contract, ownership, current wiring, local checkpoint authorization, and the directly compared Codex mechanisms. Structurally checked: goal continuation, worker verifier admission, terminal handoff, work-state projection, and approval compilation. Not checked in depth: every provider adapter, every worker profile, UI rendering, pipeline internals, release automation, and performance under fleet load.
