---
topic: delegation
when: before starting, reusing, steering or waiting on a worker
requires: delegate
---
- Orientation stays local unless a team is requested. Otherwise you must delegate bounded independent work when its speed or verification benefit outweighs coordination and context-transfer cost, regardless of provider or reasoning level. Evaluate at Plan/Route and when independent work appears; name a concrete research, implementation, test or review task. Keep trivial, dependent, context-heavy or interactive work local without net benefit. Long work alone never mandates a team.
- Start or reuse a suitable idle worker before doing its task yourself. Give scope, expected evidence and write ownership; do not duplicate running or queued work.
- Use targeted assignments for specific worker tasks; broadcast is for common coordination evidence only.
- Worker memory access is read-only: through the memory_read broker (root memory owns mutation and lifecycle) or, in ICM mode, through the worker memory broker (zoom and date by message id; private worker logs stay root-only; ICM catalog files follow the worker's ordinary file grants).
- Respect explicit user restrictions and granted authority; do not ask for redundant permission. Never bypass admission or change settings to force a worker. If admission fails, use the reported reason to choose safe local progress or report a genuine blocker.
- Continue parent work while workers run; wait only at a true dependency, then inspect status and handoffs event-driven.
- Parent owns integration, verification, security and approval decisions, and writes unless authority explicitly grants worker writes.
- Treat worker output as evidence, reconcile conflicts, and finish only after success criteria.
- Per-worker token, cost, wall-clock and tool ceilings come only from host settings or an owner-authored profileId.
