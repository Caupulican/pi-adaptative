import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	addTaskStep,
	clearTaskSteps,
	compactTaskSteps,
	createTaskStepsState,
	findOpenDuplicateStep,
	formatTaskSteps,
	hasUnverifiedCompletedStep,
	MAX_TASK_STEPS,
	resolveTaskStepSelector,
	setTaskSteps,
	type TaskStep,
	type TaskStepInput,
	type TaskStepsState,
	updateTaskStep,
} from "../tasks/task-state.ts";

const statusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("blocked"),
	Type.Literal("cancelled"),
]);

const prioritySchema = Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]);

const stepInputSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: 2_000, description: "Imperative task step text." }),
		activeForm: Type.Optional(
			Type.String({ minLength: 1, maxLength: 2_000, description: "Short present-progress label for active UI." }),
		),
		status: Type.Optional(statusSchema),
		priority: Type.Optional(prioritySchema),
		owner: Type.Optional(Type.String({ maxLength: 200 })),
		note: Type.Optional(Type.String({ maxLength: 4_000 })),
		evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 32 })),
	},
	{ additionalProperties: false },
);

const taskStepsSchema = Type.Object(
	{
		action: Type.Union(
			[
				Type.Literal("set"),
				Type.Literal("add"),
				Type.Literal("update"),
				Type.Literal("list"),
				Type.Literal("clear"),
				Type.Literal("compact"),
				Type.Literal("intake"),
			],
			{ description: "Checklist action. Use list to read without mutation." },
		),
		steps: Type.Optional(
			Type.Array(stepInputSchema, {
				maxItems: MAX_TASK_STEPS,
				description: "Complete replacement list for set/intake. Intake preserves every supplied item in order.",
			}),
		),
		id: Type.Optional(
			Type.String({
				description: "For update: current/active, exact step id, unique id prefix, or unique content selector.",
			}),
		),
		content: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
		activeForm: Type.Optional(Type.String({ maxLength: 2_000 })),
		status: Type.Optional(statusSchema),
		priority: Type.Optional(prioritySchema),
		owner: Type.Optional(Type.String({ maxLength: 200 })),
		note: Type.Optional(Type.String({ maxLength: 4_000 })),
		evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 32 })),
		clearCompleted: Type.Optional(
			Type.Boolean({ description: "For list: compact completed and cancelled steps before rendering." }),
		),
		showCompleted: Type.Optional(Type.Boolean({ description: "Include completed and cancelled steps in output." })),
		maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_STEPS })),
	},
	{ additionalProperties: false },
);

export type TaskStepsToolInput = Static<typeof taskStepsSchema>;
export type TaskStepsAction = TaskStepsToolInput["action"];

export interface TaskStepsToolDetails {
	action: TaskStepsAction;
	applied: boolean;
	error?: string;
	state?: TaskStepsState;
	stepCount?: number;
	openStepCount?: number;
	verificationNudgeNeeded?: boolean;
	showCompleted?: boolean;
	/** Set when `add` was a no-op because an open step already carries this content. */
	duplicateOfStepId?: string;
	/** Step ids silently demoted to pending because another step became active in this call. */
	demotedStepIds?: readonly string[];
}

export interface TaskStepsToolDependencies {
	getTaskStepsState: () => TaskStepsState | undefined;
	saveTaskStepsState: (state: TaskStepsState) => void;
	now?: () => string;
}

function toTaskStepInput(input: TaskStepsToolInput): TaskStepInput {
	return {
		content: input.content ?? "",
		activeForm: input.activeForm,
		status: input.status,
		priority: input.priority,
		owner: input.owner,
		note: input.note,
		evidence: input.evidence,
	};
}

function counts(
	state: TaskStepsState,
): Pick<TaskStepsToolDetails, "stepCount" | "openStepCount" | "verificationNudgeNeeded"> {
	const openStepCount = state.steps.filter(
		(step) => step.status !== "completed" && step.status !== "cancelled",
	).length;
	return {
		stepCount: state.steps.length,
		openStepCount,
		verificationNudgeNeeded: hasUnverifiedCompletedStep(state),
	};
}

/** Ids (from `resultSteps`, index-aligned with `inputs`) whose status was set explicitly by the caller. */
function explicitStatusStepIds(inputs: readonly TaskStepInput[], resultSteps: readonly TaskStep[]): Set<string> {
	const ids = new Set<string>();
	inputs.forEach((stepInput, index) => {
		if (stepInput.status !== undefined) {
			const id = resultSteps[index]?.id;
			if (id) ids.add(id);
		}
	});
	return ids;
}

/**
 * Steps that were in_progress before this call and are pending after, excluding any step whose
 * new status was set explicitly by the caller (an explicit change is not a "silent" demotion).
 */
function computeDemotedStepIds(
	before: TaskStepsState,
	after: TaskStepsState,
	excludeIds: ReadonlySet<string>,
): string[] {
	const beforeActiveIds = new Set(before.steps.filter((step) => step.status === "in_progress").map((step) => step.id));
	return after.steps
		.filter((step) => beforeActiveIds.has(step.id) && step.status === "pending" && !excludeIds.has(step.id))
		.map((step) => step.id);
}

function errorResult(action: TaskStepsAction, error: string, state?: TaskStepsState) {
	return {
		content: [{ type: "text" as const, text: `task_steps ${action} failed: ${error}` }],
		details: { action, applied: false, error, state, ...(state ? counts(state) : {}) } satisfies TaskStepsToolDetails,
	};
}

export function createTaskStepsToolDefinition(deps: TaskStepsToolDependencies): ToolDefinition {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		name: "task_steps",
		label: "Task Steps",
		description:
			"Maintain the current session's native ordered checklist for multi-step work. Supports pending, in_progress, completed, blocked, and cancelled steps with notes and evidence. State is isolated to and persisted with the active session; use native goal for durable outcome requirements and native delegate/delegate_status for background workers.",
		promptSnippet: "Track and drain multi-step work with a native session checklist.",
		promptGuidelines: [
			"Use task_steps for complex work, explicit task-tracking requests, and harness/self-improvement work; keep exactly one step in_progress while actively working.",
			"Always address the first open task step before unrelated work: start it, complete/block/cancel it with evidence, ask one clarifying question, or explicitly defer or reorder it.",
			"Mark steps completed as soon as evidence is gathered, and attach concise evidence or a blocker reason through update.",
			"Use action=intake with a complete steps array when preserving a raw multi-item dump; retain every item and do not silently drop entries.",
			"Drain task_steps before final responses: leave no stale in_progress step, and explicitly discuss or defer remaining pending or blocked work.",
			"Use goal for the durable goal ledger and delegate/delegate_status for worker lanes; do not emulate background execution inside task_steps.",
		],
		parameters: taskStepsSchema,
		async execute(_toolCallId, input: TaskStepsToolInput) {
			const timestamp = now();
			const current = deps.getTaskStepsState();
			const before = current ?? createTaskStepsState(timestamp);
			let state = before;
			let duplicateStepId: string | undefined;
			let demotedStepIds: readonly string[] = [];
			try {
				switch (input.action) {
					case "set":
						if (!input.steps) return errorResult(input.action, "set requires steps[].", current);
						state = setTaskSteps(state, input.steps, timestamp);
						demotedStepIds = computeDemotedStepIds(
							before,
							state,
							explicitStatusStepIds(input.steps, state.steps),
						);
						break;
					case "intake":
						if (!input.steps)
							return errorResult(input.action, "intake requires a complete steps[] list.", current);
						state = setTaskSteps(state, input.steps, timestamp);
						demotedStepIds = computeDemotedStepIds(
							before,
							state,
							explicitStatusStepIds(input.steps, state.steps),
						);
						break;
					case "add":
						state = addTaskStep(state, toTaskStepInput(input), timestamp);
						if (state === before) {
							// The reducer returned the unchanged state: an open step already carries this
							// content, so nothing was created. Name the existing step in the response.
							duplicateStepId = findOpenDuplicateStep(before.steps, input.content ?? "")?.id;
						}
						break;
					case "update": {
						if (!input.id?.trim())
							return errorResult(input.action, "update requires id or a unique selector.", current);
						const selected = resolveTaskStepSelector(before.steps, input.id);
						state = updateTaskStep(
							state,
							input.id,
							{
								content: input.content,
								activeForm: input.activeForm,
								status: input.status,
								priority: input.priority,
								owner: input.owner,
								note: input.note,
								evidence: input.evidence,
							},
							timestamp,
						);
						// Exclude the explicitly targeted step: its own status change was requested by
						// the caller, so it is never a "silent" demotion even if it moved to pending.
						demotedStepIds = computeDemotedStepIds(before, state, new Set([selected.id]));
						break;
					}
					case "clear":
						state = clearTaskSteps(state, timestamp);
						break;
					case "compact":
						state = compactTaskSteps(state, timestamp);
						break;
					case "list":
						if (input.clearCompleted) state = compactTaskSteps(state, timestamp);
						break;
				}

				const isNoopDuplicateAdd = input.action === "add" && state === before;
				const mutated = (input.action !== "list" || input.clearCompleted === true) && !isNoopDuplicateAdd;
				if (mutated) deps.saveTaskStepsState(state);

				const stateCounts = counts(state);
				const noticeLines: string[] = [];
				if (duplicateStepId) {
					noticeLines.push(
						`Duplicate open step ignored; existing ${duplicateStepId} already tracks this content.`,
					);
				}
				if (demotedStepIds.length > 0) {
					noticeLines.push(`Demoted to pending because another step became active: ${demotedStepIds.join(", ")}.`);
				}
				if (stateCounts.verificationNudgeNeeded) {
					noticeLines.push(
						"Reminder: a completed step has no evidence attached; attach evidence via update before treating it as verified.",
					);
				}
				const notices = noticeLines.length > 0 ? `\n${noticeLines.join("\n")}` : "";

				const headerAction =
					input.action === "list"
						? ""
						: `task_steps ${input.action} ${duplicateStepId ? "ignored (duplicate)" : "recorded"}.\n`;
				return {
					content: [
						{
							type: "text" as const,
							text: `${headerAction}${formatTaskSteps(state, {
								includeTerminal: input.showCompleted,
								maxItems: input.maxItems,
							})}${notices}`,
						},
					],
					details: {
						action: input.action,
						applied: true,
						state,
						...stateCounts,
						showCompleted: input.showCompleted,
						duplicateOfStepId: duplicateStepId,
						demotedStepIds: demotedStepIds.length > 0 ? demotedStepIds : undefined,
					} satisfies TaskStepsToolDetails,
				};
			} catch (error) {
				return errorResult(input.action, error instanceof Error ? error.message : String(error), current);
			}
		},
	};
}
