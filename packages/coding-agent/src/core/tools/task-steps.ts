import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import {
	addTaskStep,
	clearTaskSteps,
	compactTaskSteps,
	createTaskStepsState,
	formatTaskSteps,
	MAX_TASK_STEPS,
	setTaskSteps,
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
		verificationNudgeNeeded: state.steps.some((step) => step.status === "completed" && step.evidence.length === 0),
	};
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
			let state = current ?? createTaskStepsState(timestamp);
			try {
				switch (input.action) {
					case "set":
						if (!input.steps) return errorResult(input.action, "set requires steps[].", current);
						state = setTaskSteps(state, input.steps, timestamp);
						break;
					case "intake":
						if (!input.steps)
							return errorResult(input.action, "intake requires a complete steps[] list.", current);
						state = setTaskSteps(state, input.steps, timestamp);
						break;
					case "add":
						state = addTaskStep(state, toTaskStepInput(input), timestamp);
						break;
					case "update":
						if (!input.id?.trim())
							return errorResult(input.action, "update requires id or a unique selector.", current);
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
						break;
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

				const mutated = input.action !== "list" || input.clearCompleted === true;
				if (mutated) deps.saveTaskStepsState(state);
				return {
					content: [
						{
							type: "text" as const,
							text: `${input.action === "list" ? "" : `task_steps ${input.action} recorded.\n`}${formatTaskSteps(
								state,
								{
									includeTerminal: input.showCompleted,
									maxItems: input.maxItems,
								},
							)}`,
						},
					],
					details: {
						action: input.action,
						applied: true,
						state,
						...counts(state),
						showCompleted: input.showCompleted,
					} satisfies TaskStepsToolDetails,
				};
			} catch (error) {
				return errorResult(input.action, error instanceof Error ? error.message : String(error), current);
			}
		},
	};
}
