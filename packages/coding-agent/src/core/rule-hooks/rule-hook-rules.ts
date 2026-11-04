import { getCwdRelativePath, resolvePath } from "../../utils/paths.ts";
import type { RuleHookCall, RuleHookSource } from "./rule-hook-catalog.ts";

/** The `action` of a tool call's arguments, when it names one. */
function callAction(args: unknown): unknown {
	return args && typeof args === "object" && !Array.isArray(args) ? (args as { action?: unknown }).action : undefined;
}

/** `read`, `edit` and `write` name their file in `path` (core/tools/read.ts, edit.ts, write.ts). */
function callTouchesPackageRoot(call: RuleHookCall): boolean {
	if (!call.args || typeof call.args !== "object") return false;
	const path = (call.args as { path?: unknown }).path;
	if (typeof path !== "string" || path.trim().length === 0) return false;
	return getCwdRelativePath(resolvePath(path, call.cwd), call.packageRoot) !== undefined;
}

/**
 * The standing rules the host delivers when a trigger tool call succeeds. A trigger is the tool names plus an
 * optional predicate over the call arguments; the schemas it reads are cited per rule.
 */
export const RULE_HOOKS: readonly RuleHookSource[] = [
	{
		topic: "work-lifecycle",
		// create_goal and update_goal: core/tools/goal.ts (createGoalSchema, updateGoalSchema). goal: `action` start
		// (goalSchema). task_steps: every action of taskStepsSchema (core/tools/task-steps.ts). delegate: `action` is
		// an optional string that defaults to start (core/tools/delegate.ts); only dispatching or steering a worker
		// is routing, so start, follow_up and an absent action trigger.
		trigger: {
			kind: "tool-call",
			tools: ["create_goal", "goal", "task_steps", "delegate"],
			matches: (call) => {
				if (call.toolName === "goal") return callAction(call.args) === "start";
				if (call.toolName === "delegate") {
					const action = callAction(call.args);
					return action === undefined || action === "start" || action === "follow_up";
				}
				return true;
			},
		},
		rootOnly: true,
		body: `- Phases: Survey → Contract → Plan/Route → Execute → Prove/Deliver; scale them to the outcome.
- Owners: goal outcome/contract, task_steps plan, delegate workers, evidence acceptance; no parallel workflow state.
- Survey: bounded and read-only first.
- Contract: project-relative. POC/MVP proves the requested capability; complete means full project integration across affected interfaces, callers, configuration, tests, documentation, compatibility/migration and cleanup.
- Plan before mutation. Scale solo/team routing, independent review and verification to risk, uncertainty, urgency, reversibility, invariant sensitivity, test strength/cost and cognitive load; loop until accepted.
- Deliver: a local commit follows green checks; publish under active owner grants and release conditions.
Delegation routing:
- Delegate when the speed or verification benefit outweighs coordination and context-transfer cost, at any provider or reasoning level; long work alone never mandates a team. Orientation stays local unless a team is requested.
- Worker memory access is read-only: through the memory_read broker (root memory owns mutation and lifecycle) or, in ICM mode, through the worker memory broker (zoom and date by message id; private worker logs stay root-only; ICM catalog files follow the worker's ordinary file grants).
- Respect explicit user restrictions and granted authority; do not ask for redundant permission. Never bypass admission or change settings to force a worker; on an admission failure use the reported reason to choose safe local progress or report a genuine blocker.
- Context-heavy or interactive work stays local. The parent writes unless authority explicitly grants worker writes.
- Per-worker token, cost, wall-clock and tool ceilings come only from host settings or an owner-authored profileId.`,
	},
	{
		topic: "noticed-items",
		// Delivered by the goal tool's completion preflight, before a completion is accepted (core/tools/goal.ts):
		// goal `complete`, goal `increment` with nothing left to satisfy and update_goal `complete` all reach that one
		// place, so no tool predicate exists.
		trigger: { kind: "preflight" },
		body: `Noticed items are defects, risks, or odd or noisy output beyond the ask.
- An item is relevant when it affects the delivery, surfaced in your own proof runs, or sits in what you touched. When in doubt, it is relevant.
- Fix the root cause of each relevant item unasked and prove the fix. Disclose only unrelated items, with the reason.
- Before declaring done, re-read your proof output for warnings you skipped.
- Never call work done or complete a goal while a relevant item is unresolved.`,
	},
	{
		topic: "harness-docs",
		// read, edit and write take the file in `path` (core/tools/read.ts, edit.ts, write.ts); the first one that
		// lands inside the harness package tells the model where the harness documentation lives.
		trigger: { kind: "tool-call", tools: ["read", "edit", "write"], matches: callTouchesPackageRoot },
		body: ({ packageRoot }) =>
			`- Harness docs: README.md, \`docs/\` and \`examples/\` under ${packageRoot}.\n- For work on this harness, read the ones the task needs fully; follow links.`,
	},
];
