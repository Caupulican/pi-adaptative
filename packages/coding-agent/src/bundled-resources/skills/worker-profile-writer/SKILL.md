---
name: worker-profile-writer
description: "Use only when you need a reusable session-scoped worker preset (profile_create). Ordinary delegate start does not use this skill."
---

# Worker Profile Writer

## How to use the skill

Use this skill only to create a session-scoped task preset. Do not load it to start workers.

Native `delegate start` does not need an owner-authored base. Omit `profileId` to inherit the foreground model, live reasoning level, compatible tools, and machine scope. Use only the optional top-level `model`, `thinkingLevel`, `path`, and `toolNames` fields to narrow or focus that inheritance. Empty `profile_inspect` bases are not a start block. Never add a budget or authority object: the host compiles grants and owns ceilings. Every generated profile inherits the base budget unchanged.

Freedom Dial: high freedom for describing and composing the bounded task; low freedom for authority, persistence, model availability, and budget checks. Pi's core engineering and evidence rules remain mandatory.

## North Star

Create the smallest immutable profile that can complete one explicit task, then delegate with the exact harness-issued profile ID. The session log owns task profiles; project and user profile directories remain untouched.

## Core Sections

### 1. Establish the contract

1. State the worker's single outcome, required evidence, intended files, and completion boundary.
2. Call `delegate` with `action: "profile_inspect"` only when you are about to `profile_create` and reusable owner bases or configured model/thinking combinations are unknown. Inspection is optional.
3. If no owner-authored base is selected, `profile_create` derives its base directly from the foreground inheritance. Do not ask the user to authorize a base just to start work or create a preset.
4. When an owner-authored base is useful, choose one whose authority already covers the task. Never derive from another generated task profile.
5. Prefer the fastest model with demonstrated ability to satisfy the task contract. Configuration and authentication prove availability, not fitness; use existing fitness evidence or `model_fitness` when the risk justifies its token cost.
6. Request only the model, thinking level, one workspace path, and exact tool subset the task needs. Omitted fields inherit the base. Resources and budget always remain host-owned and inherited.

Human edge: if an explicitly requested reusable preset needs unavailable credentials, tools outside its inherited surface, or a different budget, report the exact rejection and ask for an owner-profile change. Do not route around a rejection. Ordinary inherited `delegate start` remains available unless the host reports a real admission block.

### 2. Execute and verify

1. Call `delegate` with `action: "profile_create"`; never supply or invent a profile ID.
2. Confirm `created: true`, the expected base, and the reported changed fields.
3. Pass the returned `profileId` unchanged to one bounded `delegate` task with explicit acceptance criteria.
4. Wait for the terminal handoff, retrieve once with `delegate { action: "status", laneId }`, independently verify worker claims.
5. Treat rejection before persistence as a successful safety boundary. Change the approach or request authority; do not retry the same expansion with different wording.

## Anti-Patterns

- Blocking `delegate start` because `profile_inspect` listed no bases.
- Writing one-off profile JSON, settings, reports, or dependencies into the repository.
- Selecting a model or thinking level that `inspect` did not report as available.
- Giving a worker extra tools "just in case", authoring resource/capability arrays, or attempting a per-dispatch budget.
- Inventing, guessing, editing, or reusing a generated profile ID across sessions or branches.
- Treating a fast model as fit without task-shaped evidence.

## Examples

Positive: omit inspect and base, derive from foreground inheritance, select an authenticated fast model at `low`, narrow tools to `read`, `grep`, and `edit`, inherit host resources and budget unchanged, then delegate with the returned `task-...` ID.

Positive: start two workers with self-contained instructions and no `profileId`; omit overrides when both should inherit the foreground model, reasoning, tools, and machine scope.

Negative: a base exposes only `read` and `grep`, but the task requires `edit`. Do not request `edit` from `profile_create`; select an authorized write-capable base or ask the user for an owner-profile change. Starting without a profile remains allowed.

Negative: telling the user workers are blocked until they authorize explorer/implementer bases.

## Self-Check

- Ordinary start omitted `profileId` unless a returned `task-...` ID is in hand.
- Empty inspect bases did not stop start.
- The task has one bounded outcome and explicit acceptance evidence.
- The base is foreground inheritance or an owner-authored profile authorized for this orchestrator.
- Model and thinking level were reported available or otherwise resolved by the harness.
- Tools are an exact subset; resources and budget remain inherited and host-owned.
- The returned ID is passed unchanged; no project/user profile file was created.

## Known Gaps

- Availability does not prove model quality; use task-shaped fitness evidence where failure risk is material.
- Generated profiles cannot expand authority or survive outside their owning session branch.
