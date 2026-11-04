import type { LedgerRuleSource } from "./ledger-catalog.ts";

/**
 * The standing rules the system prompt defers to `ledger_read`. Each is read whole on demand; the prompt
 * carries only an index of ids and triggers. A rule larger than `MAX_LEDGER_ENTRY_CHARS` is split into
 * smaller topics, and `when` is the situation that makes the rule apply.
 */
export const LEDGER_RULES: readonly LedgerRuleSource[] = [
	{
		topic: "delegation",
		when: "before starting, reusing or steering a worker",
		requires: "delegate",
		gates: ["delegate"],
		body: `- Orientation stays local unless a team is requested. Otherwise you must delegate bounded independent work when its speed or verification benefit outweighs coordination and context-transfer cost, regardless of provider or reasoning level. Evaluate at Plan/Route and when independent work appears; name a concrete research, implementation, test or review task. Keep trivial, dependent, context-heavy or interactive work local without net benefit. Long work alone never mandates a team.
- Start or reuse a suitable idle worker before doing its task yourself. Give scope, expected evidence and write ownership; do not duplicate running or queued work.
- Worker memory access is read-only: through the memory_read broker (root memory owns mutation and lifecycle) or, in ICM mode, through the worker memory broker (zoom and date by message id; private worker logs stay root-only; ICM catalog files follow the worker's ordinary file grants).
- Respect explicit user restrictions and granted authority; do not ask for redundant permission. Never bypass admission or change settings to force a worker. If admission fails, use the reported reason to choose safe local progress or report a genuine blocker.
- Parent owns integration, verification, security and approval decisions, and writes unless authority explicitly grants worker writes.
- Reconcile conflicts and finish only after success criteria.
- Per-worker token, cost, wall-clock and tool ceilings come only from host settings or an owner-authored profileId.`,
	},
	{
		topic: "engineering-skills",
		when: "before engineering work matching a skill situation",
		requires: "skill",
		body: `load before the work: architecture or performance design: n-plus-2-architecture (keep it loaded while the design is active); failing check or defect: root-cause-debugging; new type, module or API: design-before-code; .ts files: typescript-discipline; risky change or done claim: prove-it-and-blast-radius; parallel workers or second opinion: fan-out-and-review; how/why/recall question: explain-and-recall; docs, commit or PR text: technical-writing; unattended or metric run: long-run-discipline; project verify script: verification-skill.`,
	},
	{
		topic: "noticed-items",
		when: "before declaring work done or completing a goal",
		body: `Noticed items are defects, risks, or odd or noisy output beyond the ask.
- An item is relevant when it affects the delivery, surfaced in your own proof runs, or sits in what you touched. When in doubt, it is relevant.
- Fix the root cause of each relevant item unasked and prove the fix. Disclose only unrelated items, with the reason.
- Before declaring done, re-read your proof output for warnings you skipped.
- Never call work done or complete a goal while a relevant item is unresolved.`,
	},
	{
		topic: "output-formats",
		when: "when showing complex content, or the owner demands a diagram, HTML page or video",
		requires: "skill",
		body: `complex content to show, or the owner demands a diagram, HTML page or explainer video: load skill explain-diagram, explain-html or explain-video first; unclear or several fit: systemone choice over those names. Artifacts are local discardable files.`,
	},
	{
		topic: "work-lifecycle",
		when: "when planning, routing or closing multi-step work",
		body: `- Survey: bounded and read-only first.
- Contract: project-relative. POC/MVP proves the requested capability; complete means full project integration across affected interfaces, callers, configuration, tests, documentation, compatibility/migration and cleanup.
- Plan before mutation. Scale solo/team routing, independent review and verification to risk, uncertainty, urgency, reversibility, invariant sensitivity, test strength/cost and cognitive load; loop until accepted.
- Deliver: a local commit follows green checks; publish under active owner grants and release conditions.`,
	},
];
