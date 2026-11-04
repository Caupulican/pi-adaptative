import { getCwdRelativePath, resolvePath } from "../../utils/paths.ts";
import type { RuleHookCall, RuleHookSource, RuleHookTrigger } from "./rule-hook-catalog.ts";

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
 * The root's work triggers, shared by the rules that arrive with the first piece of planned work. create_goal:
 * core/tools/goal.ts (createGoalSchema). goal: `action` start (goalSchema).
 * task_steps: every action of taskStepsSchema (core/tools/task-steps.ts). delegate: `action` is an optional string
 * that defaults to start (core/tools/delegate.ts); only dispatching or steering a worker is routing, so start,
 * follow_up and an absent action trigger. Each rule is delivered once per context under its own id.
 */
const ROOT_WORK_TRIGGER: RuleHookTrigger = {
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
};

/**
 * The standing rules the host delivers when a trigger tool call succeeds. A trigger is the tool names plus an
 * optional predicate over the call arguments; the schemas it reads are cited per rule.
 */
export const RULE_HOOKS: readonly RuleHookSource[] = [
	{
		topic: "work-lifecycle",
		trigger: ROOT_WORK_TRIGGER,
		rootOnly: true,
		body: `- Phases: Survey → Contract → Plan/Route → Execute → Prove/Deliver; scale them to the outcome.
- Owners: goal outcome/contract, task_steps plan, delegate workers, evidence acceptance; no parallel workflow state.
- Survey: bounded and read-only first.
- Contract: project-relative. POC/MVP proves the requested capability; complete means full project integration across affected interfaces, callers, configuration, tests, documentation, compatibility/migration and cleanup.
- Plan before mutation. Scale solo/team routing, independent review and verification to risk, uncertainty, urgency, reversibility, invariant sensitivity, test strength/cost and cognitive load; loop until accepted.
- Deliver: a local commit follows green checks; publish under active owner grants and release conditions.`,
	},
	{
		topic: "delegation",
		trigger: ROOT_WORK_TRIGGER,
		rootOnly: true,
		// One owner per rule: the root prompt's director role holds the identity and the decision to delegate, the delegate
		// tool text holds the mechanics (reuse, event-driven handoffs, never poll, forkTurns default none, parallelWork,
		// slices, race, interrupt/cancel/retire), and this holds the policy for how to delegate well.
		body: `- Delegate when the work is independent, bounded and parallelizable, a read- or context-heavy exploration, a disjoint write scope, or a separate review. The benefit must exceed coordination plus context-transfer cost, at any provider or reasoning level; long work alone never mandates a team. Also local: interactive work, a couple of tool calls.
- Split by independence and write ownership: no two workers write the same files (overlapping write scopes wait for each other); slice so each result verifies alone; fan out only as wide as the work is independent. Workers cannot delegate: never chain.
- Reuse: one specialist per role; retire a worker when its line of work is done.
- Right-size each worker: readOnly unless it must write; only the tools and paths it needs; the cheapest model and thinkingLevel that can do the task (exploration cheap, design and review strong). Token, cost and wall-clock ceilings come only from host settings or an owner-authored profileId.
- Brief once, completely: objective, scope and paths, constraints, output shape, evidence required, stop condition. Pass references (paths, ids, requirement ids), not pasted content; no drip of clarifications.
- Start independent workers in the same turn; maxConcurrent (default 5) queues the rest.
- Review in proportion: spot-check cheap claims against files, diffs and check commands; verify risky ones with an independent verifier (a fresh readOnly worker). Send back the specific delta; never redo the work yourself.
- Steer early: follow_up with a targeted message at the first drift, interrupt when off track, cancel when obsolete. A blocked report is your decision: decide, follow up once, never re-dispatch the identical task.
- Cost: do not spawn for work smaller than its coordination; batch related questions to one worker. Respect explicit user restrictions and granted authority. On an admission failure use the reported reason and continue locally or report the blocker; never change settings to force a worker.
- Worker memory is read-only (memory_read broker; root memory owns mutation).
- Integrate: merge results, resolve overlaps, run the final checks, then deliver.`,
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
