/**
 * The closed tables the edge reads about the harness's own action tools (`edge-policy.ts`): the actions that hand a run's
 * work to another agent, the ones that only read, and the ones that only set up the run's own bounded wait. A run carrying
 * a third party's words, or opened from an owner channel, takes an action of these tools by what the tables say of it.
 */
import { WATCH_TOOL_NAME } from "../routines/routine-tool-names.ts";

/** Tool actions that hand the run's work to another agent: its authority would leave with it. */
export const DELEGATION_ACTIONS: Readonly<Record<string, ReadonlySet<string | undefined>>> = {
	delegate: new Set([undefined, "start", "send", "broadcast", "follow_up", "resume"]),
	pi_collaboration: new Set(["fire_task", "send_followup", "launch_workspace", "answer_question"]),
	goal: new Set(["dispatch_worker"]),
};
/**
 * The closed table of actions a run carrying a third party's words may take on the harness's own action tools: the
 * ones that only read. Every other action of these tools, and any action of a tool not listed here, is the owner's
 * (`ownerOnlyToolCallReason`), except the delegation launches above, which are prepared like outward actions.
 */
export const THIRD_PARTY_READ_ONLY_ACTIONS: ReadonlyMap<string, ReadonlySet<string | undefined>> = new Map([
	[
		"delegate",
		new Set([
			"tasks",
			"list",
			"transcript",
			"wait",
			"wait_many",
			"inbox",
			"inbox_wait",
			"status",
			"review",
			"profile_inspect",
			"events",
		]),
	],
	[
		"pi_collaboration",
		new Set([
			"status",
			"setup_help",
			"workspace_plan",
			"job_status",
			"list_jobs",
			"list_variables",
			"list_templates",
			"show_template",
		]),
	],
	["goal", new Set(["get"])],
	["routine", new Set(["list", "get"])],
	["proactivity", new Set(["view"])],
	["repo_read", new Set(["status", "log", "diff", "show", "blame", "ls-files", "rev-parse"])],
	["decision_ledger_read", new Set(["sessions", "stages", "evaluations", "failures", "replay"])],
	["secret_store", new Set(["status", "list"])],
	["task_automation", new Set(["status", "spec", "validate"])],
	["worktree_sync", new Set(["status", "git_status", "git_diff"])],
	["pipeline", new Set(["list", "status"])],
	["task_directory", new Set(["status"])],
	["task_steps", new Set(["list"])],
	["task_events", new Set(["events"])],
	["bot_message", new Set(["list"])],
	["runtime_update", new Set(["status"])],
	["improvement_loop", new Set(["status"])],
	["skill", new Set(["search", "read"])],
	// Advisory judgments and reads; `resolve_uncertainty` records a disposition, so it stays the owner's.
	["systemone", new Set(["status", "evaluate", "review", "vision", "evidence", "uncertainties", "locate"])],
]);

/**
 * Actions that arm, read or stop the run's own wait (`core/watches/`): a watch is bounded by numbers alone (one-shot, a
 * deadline within a day, eight per session), its check is admitted as the call it would make, and its plan comes back
 * fenced as data when a third party's words armed it. Any run takes them, as it takes a read.
 */
export const OWN_WAIT_ACTIONS: ReadonlyMap<string, ReadonlySet<string | undefined>> = new Map([
	[WATCH_TOOL_NAME, new Set(["arm", "list", "get", "cancel"])],
]);
