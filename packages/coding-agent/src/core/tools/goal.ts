import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import type { GoalEvidenceKind, GoalState } from "../goals/goal-state.ts";
import { applyGoalAction, type GoalAction, type GoalActionName, summarizeGoalState } from "../goals/goal-tool-core.ts";

const goalSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("start"),
				Type.Literal("add_requirement"),
				Type.Literal("satisfy_requirement"),
				Type.Literal("block_requirement"),
				Type.Literal("add_evidence"),
				Type.Literal("progress"),
				Type.Literal("no_progress"),
				Type.Literal("complete"),
				Type.Literal("block_goal"),
				Type.Literal("cancel"),
			],
			{ description: "Ledger action to record." },
		),
		goalId: Type.Optional(Type.String({ description: "Stable goal id. Required for action 'start'." })),
		userGoal: Type.Optional(Type.String({ description: "The goal statement. Required for action 'start'." })),
		requirementId: Type.Optional(
			Type.String({
				description: "Requirement id for add_requirement/satisfy_requirement/block_requirement.",
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
			"Record and update the durable goal ledger for the current task. Maintains a structured goal with requirements, evidence, and progress so long tasks can be resumed and continued. Start a goal, add requirements, attach evidence, mark requirements satisfied or blocked, and mark progress. This is the producer that drives /goal-continue; without recorded goal state, continuation has nothing to act on.",
		promptSnippet: "Record goal, requirements, evidence, and progress in the durable goal ledger.",
		promptGuidelines: [
			"At the start of a multi-step task, call goal with action 'start' to record the user goal, then add the concrete requirements with 'add_requirement'.",
			"As you make progress, record evidence with 'add_evidence' and mark requirements satisfied with 'satisfy_requirement', citing the evidence ids.",
			"Use 'progress' when you advance without satisfying a specific requirement, and 'no_progress' when a turn yields nothing, so stall detection works.",
			"Mark the goal 'complete' only when every requirement is satisfied; use 'block_goal' or 'block_requirement' with a reason when you are stuck and need the user.",
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

			const current = deps.getGoalState();
			const result = applyGoalAction(current, mapped, now());
			if (!result.ok) {
				return {
					content: [{ type: "text" as const, text: `goal ${input.action} failed: ${result.error}` }],
					details: { action: input.action, applied: false, error: result.error, state: current },
				};
			}

			deps.saveGoalState(result.state);
			return {
				content: [
					{ type: "text" as const, text: `goal ${input.action} recorded.\n${summarizeGoalState(result.state)}` },
				],
				details: { action: input.action, applied: true, state: result.state },
			};
		},
	};
}
