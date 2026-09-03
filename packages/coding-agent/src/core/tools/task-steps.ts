import { type Static, Type } from "typebox";
import type { ToolDefinition } from "../extensions/types.ts";
import { advanceTaskSteps } from "../pipelines/increment.ts";
import { MAX_PIPELINE_STAGE_ID_LENGTH } from "../pipelines/types.ts";
import {
	addTaskStep,
	clearTaskSteps,
	compactTaskSteps,
	createTaskStepsState,
	findNextPendingStep,
	findOpenDuplicateStep,
	formatTaskSteps,
	hasUnverifiedCompletedStep,
	MAX_TASK_STEP_PIPELINE_RUN_ID_LENGTH,
	MAX_TASK_STEPS,
	normalizeTaskStepPipelineLink,
	resolveTaskStepSelector,
	setTaskSteps,
	type TaskStep,
	type TaskStepInput,
	TaskStepsError,
	type TaskStepsState,
	type TaskStepUpdate,
	updateTaskStep,
} from "../tasks/task-state.ts";
import {
	emptyOrchestrationCall,
	OrchestrationPanelComponent,
	type OrchestrationPanelModel,
	taskStepPanelRow,
} from "./orchestration-panel.ts";

const statusSchema = Type.Union([
	Type.Literal("pending"),
	Type.Literal("in_progress"),
	Type.Literal("completed"),
	Type.Literal("blocked"),
	Type.Literal("cancelled"),
]);

const prioritySchema = Type.Union([Type.Literal("low"), Type.Literal("normal"), Type.Literal("high")]);

function optionalTaskStepFields(requirementIdsDescription: string) {
	return {
		status: Type.Optional(statusSchema),
		priority: Type.Optional(prioritySchema),
		owner: Type.Optional(Type.String({ maxLength: 200 })),
		requirementIds: Type.Optional(
			Type.Array(Type.String({ minLength: 1, maxLength: 200 }), {
				maxItems: 32,
				description: requirementIdsDescription,
			}),
		),
		pipelineRunId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_TASK_STEP_PIPELINE_RUN_ID_LENGTH,
				description: "Active pipeline run id this step advances. Supply together with pipelineStageId.",
			}),
		),
		pipelineStageId: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: MAX_PIPELINE_STAGE_ID_LENGTH,
				description: "Stage id in pipelineRunId this step advances. Supply both ids together.",
			}),
		),
		clearPipelineLink: Type.Optional(
			Type.Boolean({
				description: "Remove both pipeline ids. Cannot be combined with pipelineRunId/pipelineStageId.",
			}),
		),
		note: Type.Optional(Type.String({ maxLength: 4_000 })),
		evidence: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 2_000 }), { maxItems: 32 })),
	};
}

const stepInputSchema = Type.Object(
	{
		content: Type.String({ minLength: 1, maxLength: 2_000, description: "Imperative task step text." }),
		activeForm: Type.Optional(
			Type.String({ minLength: 1, maxLength: 2_000, description: "Short present-progress label for active UI." }),
		),
		...optionalTaskStepFields("Goal requirement ids this foreground step advances."),
	},
	{ additionalProperties: false },
);

const replacementStepsSchema = Type.Array(stepInputSchema, {
	maxItems: MAX_TASK_STEPS,
	description: "Complete replacement list for set/intake. Intake preserves every supplied item in order.",
});

const taskStepsSchema = Type.Union([
	Type.Object({ action: Type.Literal("set"), steps: replacementStepsSchema }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("intake"), steps: replacementStepsSchema }, { additionalProperties: false }),
	Type.Object(
		{
			action: Type.Literal("add"),
			content: Type.String({ minLength: 1, maxLength: 2_000 }),
			activeForm: Type.Optional(Type.String({ maxLength: 2_000 })),
			...optionalTaskStepFields("Goal requirement ids this foreground step advances; [] clears existing links."),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("update"),
			id: Type.Optional(
				Type.String({
					minLength: 1,
					pattern: "\\S",
					description:
						"Exact step id, unique id prefix, unique content selector, or 'current'/'active'. Omit to target the active (in_progress) step -- the harness resolves it, no lookup needed.",
				}),
			),
			content: Type.Optional(Type.String({ minLength: 1, maxLength: 2_000 })),
			activeForm: Type.Optional(Type.String({ maxLength: 2_000 })),
			...optionalTaskStepFields("Goal requirement ids this foreground step advances; [] clears existing links."),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			action: Type.Literal("list"),
			clearCompleted: Type.Optional(
				Type.Boolean({ description: "Compact completed and cancelled steps before rendering." }),
			),
			showCompleted: Type.Optional(
				Type.Boolean({ description: "Include completed and cancelled steps in output." }),
			),
			maxItems: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_TASK_STEPS })),
		},
		{ additionalProperties: false },
	),
	Type.Object({ action: Type.Literal("clear") }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("compact") }, { additionalProperties: false }),
	Type.Object({ action: Type.Literal("advance") }, { additionalProperties: false }),
]);

/**
 * The runtime receives already-schema-validated calls, but it deliberately uses this broad view
 * before its action switch. The TypeBox union above remains the single admission contract.
 */
export type TaskStepsToolInput = Static<typeof taskStepsSchema> &
	Partial<TaskStepUpdate> & {
		steps?: TaskStepInput[];
		id?: string;
		showCompleted?: boolean;
		clearCompleted?: boolean;
		maxItems?: number;
	};
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
	/** Set when completing the active step auto-started this pending step (no `advance` call needed). */
	autoPromotedStepId?: string;
}

export interface TaskStepsToolDependencies {
	getTaskStepsState: () => TaskStepsState | undefined;
	saveTaskStepsState: (state: TaskStepsState) => void;
	getActivePipelineScope?: () => { runId: string; stageIds: readonly string[] } | undefined;
	now?: () => string;
}

function toTaskStepUpdate(input: TaskStepsToolInput): TaskStepUpdate {
	return {
		content: input.content,
		activeForm: input.activeForm,
		status: input.status,
		priority: input.priority,
		owner: input.owner,
		requirementIds: input.requirementIds,
		pipelineRunId: input.pipelineRunId,
		pipelineStageId: input.pipelineStageId,
		clearPipelineLink: input.clearPipelineLink,
		note: input.note,
		evidence: input.evidence,
	};
}

function toTaskStepInput(input: TaskStepsToolInput): TaskStepInput {
	return { ...toTaskStepUpdate(input), content: input.content ?? "" };
}

function validatePipelineLink(
	deps: TaskStepsToolDependencies,
	pipelineRunId: string | undefined,
	pipelineStageId: string | undefined,
	clearPipelineLink = false,
): void {
	const { pipelineRunId: runId, pipelineStageId: stageId } = normalizeTaskStepPipelineLink(
		pipelineRunId,
		pipelineStageId,
		clearPipelineLink,
	);
	if (!runId || !stageId) return;
	const active = deps.getActivePipelineScope?.();
	if (!active) throw new TaskStepsError("Task step pipeline linkage requires an active pipeline run.");
	if (runId !== active.runId) {
		throw new TaskStepsError(`Task step pipelineRunId must match active run '${active.runId}'.`);
	}
	if (!active.stageIds.includes(stageId)) {
		throw new TaskStepsError(`Task step pipelineStageId '${stageId}' is not in active run '${active.runId}'.`);
	}
}

function validatePipelineInputs(deps: TaskStepsToolDependencies, inputs: readonly TaskStepInput[]): void {
	for (const input of inputs) {
		validatePipelineLink(deps, input.pipelineRunId, input.pipelineStageId, input.clearPipelineLink);
	}
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
		isError: true as const,
	};
}

function taskStepsPanelModel(details: TaskStepsToolDetails, expanded: boolean): OrchestrationPanelModel {
	const state = details.state;
	if (!state) {
		return {
			label: "task steps",
			action: details.action,
			status: details.error ? "error" : "idle",
			emptyText: details.error ?? "No checklist state.",
		};
	}
	const active = state.steps.filter((step) => step.status === "in_progress");
	const blocked = state.steps.filter((step) => step.status === "blocked");
	const pending = state.steps.filter((step) => step.status === "pending");
	const completed = state.steps.filter((step) => step.status === "completed");
	const cancelled = state.steps.filter((step) => step.status === "cancelled");
	const open = [...active, ...blocked, ...pending];
	const terminal = details.showCompleted ? [...completed, ...cancelled] : [];
	const candidates = [...open, ...terminal];
	const limit = expanded ? 24 : 8;
	const rows = candidates.slice(0, limit).map(taskStepPanelRow);
	const archivedDone = state.archive.completed + state.archive.cancelled;
	const done = completed.length + state.archive.completed;
	const summary = [
		active.length ? `${active.length} working` : undefined,
		`${open.length} open`,
		`${done} done`,
		blocked.length ? `${blocked.length} blocked` : undefined,
		archivedDone ? `${archivedDone} archived` : undefined,
	].filter((value): value is string => value !== undefined);
	const notices = [];
	if (!details.showCompleted && completed.length + cancelled.length > 0) {
		notices.push({
			status: "info" as const,
			text: `${completed.length + cancelled.length} finished step${completed.length + cancelled.length === 1 ? "" : "s"} hidden`,
		});
	}
	if (details.duplicateOfStepId) {
		notices.push({ status: "info" as const, text: "Duplicate open step ignored." });
	}
	if (details.autoPromotedStepId) {
		notices.push({ status: "info" as const, text: `Auto-started next step: ${details.autoPromotedStepId}.` });
	}
	if (details.demotedStepIds?.length) {
		notices.push({
			status: "info" as const,
			text: `${details.demotedStepIds.length} previous working step${details.demotedStepIds.length === 1 ? "" : "s"} returned to pending.`,
		});
	}
	if (details.verificationNudgeNeeded) {
		notices.push({ status: "warning" as const, text: "Completed work still needs attached evidence." });
	}
	const status = details.error
		? "error"
		: blocked.length > 0
			? "warning"
			: active.length > 0
				? "running"
				: open.length === 0 && state.steps.length > 0
					? "success"
					: "idle";
	return {
		label: "task steps",
		action: details.action,
		status,
		summary,
		rows,
		notices,
		emptyText: state.steps.length === 0 ? "No tracked steps." : "All open steps are done.",
		hiddenRowCount: Math.max(0, candidates.length - rows.length),
	};
}

export function createTaskStepsToolDefinition(deps: TaskStepsToolDependencies): ToolDefinition {
	const now = deps.now ?? (() => new Date().toISOString());
	return {
		name: "task_steps",
		label: "Task Steps",
		description:
			"Track the session's ordered multi-step checklist with status, notes, and evidence. Use goal for durable outcomes and delegate for workers.",
		promptSnippet: "Track multi-step session work.",
		promptGuidelines: [
			"Use for multi-step work; keep one in_progress step.",
			"For project changes, establish Plan/Route before first mutation and link steps to the goal contract; task_steps owns execution detail, never a second outcome state.",
			"Batch transitions; work the first open step; record evidence/blockers; skip unchanged narration.",
			"intake keeps every item; link goal requirementIds.",
			"update's id is optional: omit it to target the active step. Completing the active step auto-starts the next pending one.",
			"advance completes current, then starts next pending.",
			"Attach completed tool_task IDs as evidence; goal completion rejects every open step.",
			"Before final, resolve or defer open work. goal owns outcomes; delegate owns workers.",
		],
		parameters: taskStepsSchema,
		// INVESTIGATED, not assumed (turn-economics remediation, TASK 6): this tool previously
		// declared `executionMode: "sequential"`, which gives a tool call its own barrier group and
		// guarantees it never shares a batch with any other tool call (see `partitionToolCalls` in
		// `packages/agent/src/agent-loop.ts`). In two weeks of real logs every one of 4,326 calls ran
		// with zero other tools in flight, and control-plane-only turns like this one cost 17.9 hours
		// of wall clock. The barrier is NOT required for this tool's correctness, and removing it does
		// not introduce a race:
		//
		// - `execute()` below performs one read-modify-write against `TaskStepsState`:
		//   `getTaskStepsState()` -> a pure reducer (`setTaskSteps`/`addTaskStep`/`updateTaskStep`/
		//   `clearTaskSteps`/`compactTaskSteps`/`advanceTaskSteps`) -> `saveTaskStepsState()`. Every
		//   function in that chain, all the way down to the session-log append/read it ultimately
		//   calls, is FULLY SYNCHRONOUS -- there is no `await` anywhere between the read and the
		//   write.
		// - `validatePipelineLink` similarly consults `getActivePipelineScope()` synchronously; the
		//   only writer of that scope is the `pipeline` tool, which keeps its own
		//   `executionMode: "sequential"` (pipeline.ts), so it can never mutate concurrently with this
		//   call regardless of this tool's own barrier status.
		// - JS is single-threaded: "concurrent" tool execution here is cooperative interleaving at
		//   `await` boundaries only, never true simultaneous execution. A synchronous stretch of code
		//   (this tool's entire critical section) cannot be interrupted mid-way by anything else, no
		//   matter how many other tools are "in flight" in the same parallel pool
		//   (`pooledExecuteToolCalls`) -- including a second `task_steps` call in the same batch: the
		//   pool's refill loop invokes each prepared call's `execute()` in emission order without an
		//   intervening await, so one call's fully-synchronous critical section always finishes before
		//   the next one's begins.
		//
		// This is an IMPLICIT invariant, not a structural guarantee: if `execute()`, any reducer it
		// calls, `getTaskStepsState`/`saveTaskStepsState`, or `getActivePipelineScope` ever gains a
		// real `await` in the future, this reasoning silently stops applying and the barrier would
		// need to come back. `test/task-steps-tool-concurrency.test.ts` exercises this tool alongside
		// a sibling that genuinely yields mid-execution, and with two `task_steps` calls in one batch,
		// as a regression guard -- it will not catch a future async leak on its own, so treat this
		// comment as the authoritative reason, and restore `executionMode: "sequential"` on the day
		// any part of that chain becomes genuinely asynchronous.
		renderShell: "self",
		renderCall() {
			return emptyOrchestrationCall();
		},
		renderResult(result, { expanded, isPartial }, theme) {
			if (isPartial) return emptyOrchestrationCall();
			const details = result.details as TaskStepsToolDetails | undefined;
			if (!details) {
				return new OrchestrationPanelComponent(theme, {
					label: "task steps",
					status: "error",
					emptyText: "No task-step details were returned.",
				});
			}
			if (!expanded && details.applied) return emptyOrchestrationCall();
			return new OrchestrationPanelComponent(theme, taskStepsPanelModel(details, expanded), expanded);
		},
		async execute(_toolCallId, input: TaskStepsToolInput) {
			const timestamp = now();
			const current = deps.getTaskStepsState();
			const before = current ?? createTaskStepsState(timestamp);
			let state = before;
			let duplicateStepId: string | undefined;
			let demotedStepIds: readonly string[] = [];
			let autoPromotedStepId: string | undefined;
			try {
				const selectorNotes: string[] = [];
				switch (input.action) {
					case "set":
					case "intake": {
						const steps = input.steps;
						if (!steps) {
							const error =
								input.action === "set" ? "set requires steps[]." : "intake requires a complete steps[] list.";
							return errorResult(input.action, error, current);
						}
						validatePipelineInputs(deps, steps);
						state = setTaskSteps(state, steps, timestamp);
						demotedStepIds = computeDemotedStepIds(before, state, explicitStatusStepIds(steps, state.steps));
						break;
					}
					case "add":
						validatePipelineLink(deps, input.pipelineRunId, input.pipelineStageId, input.clearPipelineLink);
						state = addTaskStep(state, toTaskStepInput(input), timestamp);
						if (state === before) {
							// The reducer returned the unchanged state: an open step already carries this
							// content, so nothing was created. Name the existing step in the response.
							duplicateStepId = findOpenDuplicateStep(before.steps, input.content ?? "")?.id;
						}
						break;
					case "update": {
						// Omitted id targets the active step. Reuses resolveTaskStepSelector's own
						// "current"/"active" resolution (including its "no in_progress step" error naming
						// the open steps) instead of duplicating that logic here.
						const selector = input.id?.trim() || "current";
						const selected = resolveTaskStepSelector(before.steps, selector, (note) => selectorNotes.push(note));
						if (
							input.pipelineRunId !== undefined ||
							input.pipelineStageId !== undefined ||
							input.clearPipelineLink === true
						) {
							const clearingPipelineLink = input.clearPipelineLink === true;
							validatePipelineLink(
								deps,
								clearingPipelineLink ? input.pipelineRunId : (input.pipelineRunId ?? selected.pipelineRunId),
								clearingPipelineLink
									? input.pipelineStageId
									: (input.pipelineStageId ?? selected.pipelineStageId),
								clearingPipelineLink,
							);
						}
						state = updateTaskStep(state, selector, toTaskStepUpdate(input), timestamp);
						// Completing the step that WAS active advances the cursor automatically -- the
						// harness manages the step, so the model does not need a separate `advance` call
						// for the common case. Guarded to the step that was in_progress before this call,
						// so completing an unrelated pending/blocked step never disturbs the real cursor.
						if (selected.status === "in_progress" && input.status === "completed") {
							const promoted = findNextPendingStep(state.steps, selected.id);
							if (promoted) {
								state = updateTaskStep(state, promoted.id, { status: "in_progress" }, timestamp);
								autoPromotedStepId = promoted.id;
							}
						}
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
					case "advance": {
						const advanced = advanceTaskSteps(before, timestamp);
						state = advanced.state;
						break;
					}
					case "list":
						if (input.clearCompleted) state = compactTaskSteps(state, timestamp);
						break;
				}

				const isNoopDuplicateAdd = input.action === "add" && state === before;
				const mutated = (input.action !== "list" || input.clearCompleted === true) && !isNoopDuplicateAdd;
				if (mutated) deps.saveTaskStepsState(state);

				const stateCounts = counts(state);
				const noticeLines: string[] = [...selectorNotes];
				if (duplicateStepId) {
					noticeLines.push(
						`Duplicate open step ignored; existing ${duplicateStepId} already tracks this content.`,
					);
				}
				if (demotedStepIds.length > 0) {
					noticeLines.push(`Demoted to pending because another step became active: ${demotedStepIds.join(", ")}.`);
				}
				if (autoPromotedStepId) {
					noticeLines.push(`Auto-started next pending step: ${autoPromotedStepId}.`);
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
						autoPromotedStepId,
					} satisfies TaskStepsToolDetails,
				};
			} catch (error) {
				return errorResult(input.action, error instanceof Error ? error.message : String(error), current);
			}
		},
	};
}
