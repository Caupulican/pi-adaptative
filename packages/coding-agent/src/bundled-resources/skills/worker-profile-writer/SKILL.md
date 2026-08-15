---
name: worker-profile-writer
description: "Use only when you need a reusable session-scoped worker preset (profile_create). Ordinary delegate start does not use this skill."
---

# Worker Profile Writer

## How to use the skill

Use this skill only to create a session-scoped task preset. Do not load it to start workers.

Native `delegate start` does not need an owner-authored base. Omit `profileId` and set `authority` (role `explorer` or `implementer`, tools, budget). Empty `profile_inspect` bases are not a start block.

Freedom Dial: high freedom for describing and composing the bounded task; low freedom for authority, persistence, model availability, and budget checks. Pi's core engineering and evidence rules remain mandatory.

## North Star

Create the smallest immutable profile that can complete one explicit task, then delegate with the exact harness-issued profile ID. The session log owns task profiles; project and user profile directories remain untouched.

## Core Sections

### 1. Establish the contract

1. State the worker's single outcome, required evidence, intended files, and completion boundary.
2. Call `delegate` with `action: "profile_inspect"` only when you are about to `profile_create` and the reusable bases or configured model/thinking combinations are unknown.
3. If inspect lists no owner-authored explorer/implementer base, do not ask the user to authorize one just to start work. Start with `delegate start` and `authority`. Ask the user only if they explicitly want a durable reusable base for future `profile_create`.
4. When creating a preset, choose an owner-authored base whose role and authority already cover the task. Never derive from another generated task profile.
5. Prefer the fastest model with demonstrated ability to satisfy the task contract. Configuration and authentication prove availability, not fitness; use existing fitness evidence or `model_fitness` when the risk justifies its token cost.
6. Request only the tools and resource profiles the task needs. Omitted fields inherit the base; supplied fields must be exact subsets. Budgets may only tighten.

Human edge: if `profile_create` is required and the task needs an unlisted base, unavailable credentials, broader tools/resources, or a looser budget, stop and ask the user to authorize a durable owner-profile change. Do not route around a rejection. Do not treat that as a ban on `delegate start`.

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
- Giving a worker extra tools "just in case" or loosening the base budget.
- Inventing, guessing, editing, or reusing a generated profile ID across sessions or branches.
- Treating a fast model as fit without task-shaped evidence.

## Examples

Positive: inspect, derive from a read/write implementer, select an authenticated fast model at `low`, narrow tools to `read`, `grep`, and `edit`, tighten token/tool-call limits, then delegate with the returned `task-...` ID.

Positive: inspect returns no bases; start two workers with `authority.role` `explorer` and `implementer` and no `profileId`.

Negative: a base exposes only `read` and `grep`, but the task requires `edit`. Do not request `edit` from `profile_create`; select an authorized write-capable base or ask the user for an owner-profile change. Starting without a profile remains allowed.

Negative: telling the user workers are blocked until they authorize explorer/implementer bases.

## Self-Check

- Ordinary start omitted `profileId` unless a returned `task-...` ID is in hand.
- Empty inspect bases did not stop start.
- The task has one bounded outcome and explicit acceptance evidence.
- The base, if used, is owner-authored and authorized for this orchestrator.
- Model and thinking level were reported available or otherwise resolved by the harness.
- Tools/resources are subsets and the budget is unchanged or tighter.
- The returned ID is passed unchanged; no project/user profile file was created.

## Known Gaps

- Availability does not prove model quality; use task-shaped fitness evidence where failure risk is material.
- Generated profiles cannot expand authority or survive outside their owning session branch.
