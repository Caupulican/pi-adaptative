import { stat as fsStat } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { GoalEvidenceKind, GoalState } from "../goals/goal-state.ts";
import {
	applyGoalAction,
	type GoalAction,
	type GoalActionName,
	type OpenTaskStepRef,
	summarizeGoalState,
} from "../goals/goal-tool-core.ts";
import { resolveToCwd } from "./path-utils.ts";

const goalSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("start"),
				Type.Literal("add_requirement"),
				Type.Literal("satisfy_requirement"),
				Type.Literal("block_requirement"),
				Type.Literal("reopen_requirement"),
				Type.Literal("add_evidence"),
				Type.Literal("progress"),
				Type.Literal("no_progress"),
				Type.Literal("complete"),
				Type.Literal("block_goal"),
				Type.Literal("resume_goal"),
				Type.Literal("cancel"),
			],
			{ description: "Ledger action to record." },
		),
		goalId: Type.Optional(Type.String({ description: "Stable goal id. Required for action 'start'." })),
		userGoal: Type.Optional(Type.String({ description: "The goal statement. Required for action 'start'." })),
		requirementId: Type.Optional(
			Type.String({
				description: "Requirement id for add_requirement/satisfy_requirement/block_requirement/reopen_requirement.",
			}),
		),
		text: Type.Optional(Type.String({ description: "Requirement text. Required for add_requirement." })),
		evidenceId: Type.Optional(Type.String({ description: "Evidence id. Required for add_evidence." })),
		evidenceIds: Type.Optional(
			Type.Array(Type.String(), {
				description: "Evidence ids supporting a satisfy_requirement action. Each must already be recorded.",
			}),
		),
		kind: Type.Optional(
			Type.Union(
				[
					Type.Literal("file"),
					Type.Literal("test"),
					Type.Literal("tool"),
					Type.Literal("user"),
					Type.Literal("finding"),
				],
				{ description: "Evidence kind. Required for add_evidence." },
			),
		),
		summary: Type.Optional(Type.String({ description: "Evidence summary. Required for add_evidence." })),
		uri: Type.Optional(Type.String({ description: "Optional evidence locator (path/URL)." })),
		reason: Type.Optional(Type.String({ description: "Reason for block_requirement or block_goal." })),
	},
	{ additionalProperties: false },
);

export type GoalToolInput = Static<typeof goalSchema>;

export interface GoalToolDetails {
	action: GoalActionName;
	applied: boolean;
	error?: string;
	state?: GoalState;
}

export interface GoalToolDependencies {
	/** Read the latest persisted goal state for the active session. */
	getGoalState: () => GoalState | undefined;
	/** Persist a new goal state snapshot to the active session. */
	saveGoalState: (state: GoalState) => void;
	/** Clock injection for deterministic tests. */
	now?: () => string;
	/**
	 * Check whether `toolCallId` exists in this session's records, for validating kind:"tool"
	 * evidence refs at add_evidence time. When not wired, a "tool" ref cannot be proven and is
	 * recorded as `verified: false` rather than assumed true.
	 */
	hasToolCallId?: (toolCallId: string) => boolean;
	/** Working directory for resolving kind:"file" evidence ref paths. Defaults to `process.cwd()`. */
	cwd?: () => string;
	/**
	 * Gate agent-facing 'complete' on verified/user evidence backing. Defaults to `true` (on)
	 * when omitted -- the conservative default; set to a function returning `false` to opt out.
	 */
	requireVerifiedEvidenceForCompletion?: () => boolean;
	/**
	 * Read-only open (non-terminal) task_steps steps on the active branch, for the goal⇄task
	 * cross-visibility nudge in the tool response. When omitted, `summarizeGoalState` gets
	 * no task-step context and simply emits no nudge -- goal-tool-core stays pure and never reads
	 * task state itself; this is the only place that supplies it.
	 */
	getOpenTaskSteps?: () => readonly OpenTaskStepRef[];
}

/**
 * Validate an evidence ref's `uri` against session records ("tool") or the filesystem ("file").
 * Returns `undefined` for kinds/refs that carry nothing checkable (e.g. "user"/"finding"/"test",
 * or a missing `uri`) -- absence of a ref is not the same as a ref that failed to verify.
 */
async function resolveEvidenceVerified(
	kind: GoalEvidenceKind,
	uri: string | undefined,
	deps: GoalToolDependencies,
): Promise<boolean | undefined> {
	const trimmedUri = uri?.trim();
	if (!trimmedUri) return undefined;
	if (kind === "tool") {
		return deps.hasToolCallId ? deps.hasToolCallId(trimmedUri) : false;
	}
	if (kind === "file") {
		const cwd = deps.cwd?.() ?? process.cwd();
		try {
			const stats = await fsStat(resolveToCwd(trimmedUri, cwd));
			return stats.isFile();
		} catch {
			return false;
		}
	}
	return undefined;
}

function toGoalAction(input: GoalToolInput): GoalAction | { error: string } {
	switch (input.action) {
		case "start":
			return { action: "start", goalId: input.goalId ?? "", userGoal: input.userGoal ?? "" };
		case "add_requirement":
			return { action: "add_requirement", requirementId: input.requirementId ?? "", text: input.text ?? "" };
		case "satisfy_requirement":
			return {
				action: "satisfy_requirement",
				requirementId: input.requirementId ?? "",
				evidenceIds: input.evidenceIds,
			};
		case "block_requirement":
			return {
				action: "block_requirement",
				requirementId: input.requirementId ?? "",
				reason: input.reason ?? "",
			};
		case "reopen_requirement":
			return { action: "reopen_requirement", requirementId: input.requirementId ?? "" };
		case "add_evidence": {
			if (input.kind === undefined) {
				return { error: "add_evidence requires a kind." };
			}
			const kind: GoalEvidenceKind = input.kind;
			return {
				action: "add_evidence",
				evidenceId: input.evidenceId ?? "",
				kind,
				summary: input.summary ?? "",
				uri: input.uri,
			};
		}
		case "progress":
			return { action: "progress" };
		case "no_progress":
			return { action: "no_progress" };
		case "complete":
			return { action: "complete" };
		case "block_goal":
			return { action: "block_goal", reason: input.reason ?? "" };
		case "resume_goal":
			return { action: "resume_goal" };
		case "cancel":
			return { action: "cancel" };
		default:
			return { error: "Unknown goal action." };
	}
}

export function createGoalToolDefinition(deps: GoalToolDependencies): ToolDefinition {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		name: "goal",
		label: "goal",
		description:
			"Record and update the durable goal ledger for the current task. Maintains a structured goal with requirements, evidence, and progress so long tasks can be resumed and continued. Start a goal, add requirements, attach evidence, mark requirements satisfied or blocked, reopen resolved blockers, resume blocked goals, and mark progress. This is the producer that drives /goal-continue; without recorded goal state, continuation has nothing to act on.",
		promptSnippet: "Record goal, requirements, evidence, and progress in the durable goal ledger.",
		promptGuidelines: [
			"At the start of a multi-step task, call goal with action 'start' to record the user goal, then add the concrete requirements with 'add_requirement'.",
			"As you make progress, record evidence with 'add_evidence' and mark requirements satisfied with 'satisfy_requirement', citing the evidence ids.",
			"For 'add_evidence', kind 'tool' expects a real toolCallId in 'uri' and kind 'file' expects a real path; both are checked and recorded as verified or not. Kinds 'user'/'finding'/'test' carry no checkable ref.",
			"Use 'progress' when you advance without satisfying a specific requirement, and 'no_progress' when a turn yields nothing, so stall detection works.",
			"When the user resolves a blocker, use 'resume_goal' and 'reopen_requirement' as needed; do not strand the old ledger or start a duplicate goal.",
			"Mark the goal 'complete' only when every requirement is satisfied; completion normally also requires at least one satisfied requirement backed by verified 'tool'/'file' evidence or kind 'user' evidence. Use 'block_goal' or 'block_requirement' with a reason when you are stuck and need the user. A blocked goal can still be resumed or cancelled.",
		],
		parameters: goalSchema,
		async execute(
			_toolCallId,
			input: GoalToolInput,
		): Promise<{
			content: Array<{ type: "text"; text: string }>;
			details: GoalToolDetails;
		}> {
			const mapped = toGoalAction(input);
			if ("error" in mapped) {
				return {
					content: [{ type: "text" as const, text: `goal ${input.action} failed: ${mapped.error}` }],
					details: { action: input.action, applied: false, error: mapped.error },
				};
			}

			let action: GoalAction = mapped;
			if (action.action === "add_evidence") {
				const verified = await resolveEvidenceVerified(action.kind, action.uri, deps);
				action = { ...action, verified };
			}

			const current = deps.getGoalState();
			const result = applyGoalAction(current, action, now(), {
				requireVerifiedEvidenceForCompletion: deps.requireVerifiedEvidenceForCompletion?.() ?? true,
			});
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `goal ${input.action} failed: ${result.error}` }],
					details: { action: input.action, applied: false, error: result.error, state: current },
				};
			}

			deps.saveGoalState(result.state);
			const summary = summarizeGoalState(result.state, { action, openTaskSteps: deps.getOpenTaskSteps?.() });
			return {
				content: [{ type: "text" as const, text: `goal ${input.action} recorded.\n${summary}` }],
				details: { action: input.action, applied: true, state: result.state },
			};
		},
	};
}
