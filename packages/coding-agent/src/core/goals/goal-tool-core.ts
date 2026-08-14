import { type BackgroundToolTaskRef, findBackgroundToolTask } from "../background-tool-task-controller.ts";
import { taskStepReferencesRequirement } from "../tasks/task-projection.ts";
import { getUnprovenGoalRequirementIds } from "./goal-acceptance.ts";
import { formatGoalRecord, projectGoalRecord } from "./goal-record.ts";
import {
	applyGoalEvent,
	createGoalState,
	type GoalEvent,
	type GoalEvidenceKind,
	type GoalState,
	isGoalExecutionActive,
	isGoalUnfinishedStatus,
	MAX_GOAL_OBJECTIVE_LENGTH,
} from "./goal-state.ts";

const MAX_GOAL_ID_LENGTH = 128;
const MAX_GOAL_REQUIREMENTS = 256;
const MAX_GOAL_EVIDENCE = 512;
const MAX_GOAL_LEDGER_TEXT_LENGTH = 4_000;
const MAX_GOAL_URI_LENGTH = 4_096;

/**
 * Agent-facing goal ledger actions.
 *
 * This is the producer half of the goal continuation pipeline: the agent records
 * what it is trying to achieve and how far it has gotten, and those records become
 * the {@link GoalState} snapshots that the runtime continuation consumer reads.
 *
 * Each action maps onto either {@link createGoalState} or a single
 * {@link GoalEvent}, so the durable state model stays the single source of truth.
 */
export type GoalAction =
	| { action: "start"; goalId: string; userGoal: string; tokenBudget?: number }
	| { action: "add_requirement"; requirementId: string; text: string; dependencies?: readonly string[] }
	| { action: "satisfy_requirement"; requirementId: string; evidenceIds?: readonly string[] }
	| { action: "block_requirement"; requirementId: string; reason: string }
	| { action: "reopen_requirement"; requirementId: string }
	| {
			action: "dispatch_worker";
			requirementId: string;
			instructions: string;
			/**
			 * LaneId returned by the tool layer's dispatch side effect (calling the real worker/tmux
			 * dispatch). Computed by the tool layer -- which has session/runtime access -- and merged
			 * onto the action before it reaches this pure reducer, exactly like `add_evidence`'s
			 * `verified` field. Undefined when the dispatch side effect is unwired/stubbed.
			 */
			laneId?: string;
	  }
	| {
			action: "add_evidence";
			evidenceId: string;
			kind: GoalEvidenceKind;
			summary: string;
			uri?: string;
			/**
			 * Whether `uri` was checked against session records/the filesystem. Computed by the
			 * tool layer (which has session/filesystem access); `applyGoalAction` stays pure and
			 * only carries this value through into the recorded {@link GoalEvidenceRef}.
			 */
			verified?: boolean;
	  }
	| { action: "progress" }
	| { action: "no_progress" }
	| { action: "complete" }
	| { action: "block_goal"; reason: string };

export type GoalActionName = GoalAction["action"];

export interface GoalActionSuccess {
	ok: true;
	state: GoalState;
}

export interface GoalActionFailure {
	ok: false;
	error: string;
}

export type GoalActionResult = GoalActionSuccess | GoalActionFailure;

export interface ApplyGoalActionOptions {
	/**
	 * Gate agent-facing 'complete' on every satisfied requirement being backed by
	 * verified-ref evidence (kind 'tool'/'file' with `verified === true`) or kind 'user'
	 * evidence. Defaults to `true` (on) when omitted — the conservative default. Manual
	 * completion ({@link completeGoalManually}) is never subject to this gate.
	 */
	requireVerifiedEvidenceForCompletion?: boolean;
	/**
	 * Open (non-terminal) task_steps on this branch. Agent-facing complete refuses while any of
	 * these still reference a requirement of the goal being closed.
	 */
	openTaskSteps?: readonly OpenTaskStepRef[];
	/** Live background tool_task records used to re-check kind:"tool" evidence at complete time. */
	backgroundToolTasks?: readonly BackgroundToolTaskRef[];
}

function requirementExists(state: GoalState, requirementId: string): boolean {
	return state.requirements.some((requirement) => requirement.id === requirementId);
}

function evidenceExists(state: GoalState, evidenceId: string): boolean {
	return state.evidence.some((evidence) => evidence.id === evidenceId);
}

/**
 * Apply one agent-facing goal action to the current ledger state.
 *
 * Pure: takes the current state (or `undefined` when no goal exists yet) and the
 * action, and returns either the next state or a validation error. Performs no
 * I/O and never mutates its inputs.
 */
export function applyGoalAction(
	current: GoalState | undefined,
	action: GoalAction,
	now: string,
	options?: ApplyGoalActionOptions,
): GoalActionResult {
	if (action.action === "start") {
		const goalId = action.goalId.trim();
		const userGoal = action.userGoal.trim();
		if (!goalId) return { ok: false, error: "start requires a non-empty goalId." };
		if (!userGoal) return { ok: false, error: "start requires a non-empty userGoal." };
		if (goalId.length > MAX_GOAL_ID_LENGTH) {
			return { ok: false, error: `start goalId must be at most ${MAX_GOAL_ID_LENGTH} characters.` };
		}
		if (userGoal.length > MAX_GOAL_OBJECTIVE_LENGTH) {
			return { ok: false, error: `start userGoal must be at most ${MAX_GOAL_OBJECTIVE_LENGTH} characters.` };
		}
		if (action.tokenBudget !== undefined && (!Number.isSafeInteger(action.tokenBudget) || action.tokenBudget <= 0)) {
			return { ok: false, error: "start tokenBudget must be a positive integer when provided." };
		}
		if (current && isGoalUnfinishedStatus(current.status)) {
			return {
				ok: false,
				error: `An unfinished goal '${current.goalId}' already exists (${current.status}). Complete, clear, or explicitly replace it before starting '${goalId}'.`,
			};
		}
		return { ok: true, state: createGoalState({ goalId, userGoal, tokenBudget: action.tokenBudget, now }) };
	}

	if (!current) {
		return { ok: false, error: "No active goal. Use action 'start' before recording goal updates." };
	}

	if (!isGoalExecutionActive(current.status)) {
		return {
			ok: false,
			error: `Goal '${current.goalId}' is ${current.status}. Lifecycle changes are owner/system controlled; use the /goal controls.`,
		};
	}

	const event = toGoalEvent(current, action, now, options);
	if (!event.ok) return event;
	return { ok: true, state: applyGoalEvent(current, event.event) };
}

type ToGoalEventResult = { ok: true; event: GoalEvent } | GoalActionFailure;

function toGoalEvent(
	state: GoalState,
	action: GoalAction,
	now: string,
	options: ApplyGoalActionOptions | undefined,
): ToGoalEventResult {
	switch (action.action) {
		case "add_requirement": {
			const id = action.requirementId.trim();
			const text = action.text.trim();
			if (!id) return { ok: false, error: "add_requirement requires a non-empty requirementId." };
			if (!text) return { ok: false, error: "add_requirement requires non-empty text." };
			if (id.length > MAX_GOAL_ID_LENGTH) {
				return { ok: false, error: `requirementId must be at most ${MAX_GOAL_ID_LENGTH} characters.` };
			}
			if (text.length > MAX_GOAL_LEDGER_TEXT_LENGTH) {
				return { ok: false, error: `requirement text must be at most ${MAX_GOAL_LEDGER_TEXT_LENGTH} characters.` };
			}
			if (state.requirements.length >= MAX_GOAL_REQUIREMENTS) {
				return { ok: false, error: `Goal already has the maximum ${MAX_GOAL_REQUIREMENTS} requirements.` };
			}
			if (requirementExists(state, id)) {
				return { ok: false, error: `Requirement '${id}' already exists.` };
			}
			if (action.dependencies) {
				for (const depId of action.dependencies) {
					if (!requirementExists(state, depId) && depId !== id) {
						return { ok: false, error: `Dependency requirementId '${depId}' does not exist.` };
					}
				}
			}
			return { ok: true, event: { type: "add_requirement", id, text, dependencies: action.dependencies, now } };
		}
		case "satisfy_requirement": {
			const id = action.requirementId.trim();
			if (!id) return { ok: false, error: "satisfy_requirement requires a non-empty requirementId." };
			if (!requirementExists(state, id)) {
				return { ok: false, error: `Unknown requirement '${id}'.` };
			}
			const evidenceIds = action.evidenceIds ?? [];
			for (const evidenceId of evidenceIds) {
				if (!evidenceExists(state, evidenceId)) {
					return {
						ok: false,
						error: `Unknown evidence '${evidenceId}'. Record it with action 'add_evidence' first.`,
					};
				}
			}
			return { ok: true, event: { type: "satisfy_requirement", id, evidenceIds: [...evidenceIds], now } };
		}
		case "block_requirement": {
			const id = action.requirementId.trim();
			const reason = action.reason.trim();
			if (!id) return { ok: false, error: "block_requirement requires a non-empty requirementId." };
			if (!reason) return { ok: false, error: "block_requirement requires a non-empty reason." };
			if (!requirementExists(state, id)) {
				return { ok: false, error: `Unknown requirement '${id}'.` };
			}
			return { ok: true, event: { type: "block_requirement", id, blockedReason: reason, now } };
		}
		case "reopen_requirement": {
			const id = action.requirementId.trim();
			if (!id) return { ok: false, error: "reopen_requirement requires a non-empty requirementId." };
			const requirement = state.requirements.find((candidate) => candidate.id === id);
			if (!requirement) {
				return { ok: false, error: `Unknown requirement '${id}'.` };
			}
			if (requirement.status !== "blocked") {
				return {
					ok: false,
					error: `Requirement '${id}' is ${requirement.status}; only blocked requirements can be reopened.`,
				};
			}
			return { ok: true, event: { type: "reopen_requirement", id, now } };
		}
		case "dispatch_worker": {
			const id = action.requirementId.trim();
			const instructions = action.instructions.trim();
			if (!id) return { ok: false, error: "dispatch_worker requires a non-empty requirementId." };
			if (!instructions) return { ok: false, error: "dispatch_worker requires non-empty instructions." };
			const requirement = state.requirements.find((r) => r.id === id);
			if (!requirement) return { ok: false, error: `Requirement '${id}' does not exist.` };
			if (requirement.status !== "open") {
				return { ok: false, error: `Requirement '${id}' is not open (status: ${requirement.status}).` };
			}
			if (requirement.dependencies) {
				const unsatisfied = requirement.dependencies.filter((depId) => {
					const dep = state.requirements.find((r) => r.id === depId);
					return !dep || dep.status !== "satisfied";
				});
				if (unsatisfied.length > 0) {
					return {
						ok: false,
						error: `Cannot dispatch worker: dependencies not satisfied [${unsatisfied.join(", ")}].`,
					};
				}
			}
			return { ok: true, event: { type: "dispatch_worker", id, instructions, laneId: action.laneId, now } };
		}
		case "add_evidence": {
			const id = action.evidenceId.trim();
			const summary = action.summary.trim();
			if (!id) return { ok: false, error: "add_evidence requires a non-empty evidenceId." };
			if (!summary) return { ok: false, error: "add_evidence requires a non-empty summary." };
			if (id.length > MAX_GOAL_ID_LENGTH) {
				return { ok: false, error: `evidenceId must be at most ${MAX_GOAL_ID_LENGTH} characters.` };
			}
			if (summary.length > MAX_GOAL_LEDGER_TEXT_LENGTH) {
				return { ok: false, error: `evidence summary must be at most ${MAX_GOAL_LEDGER_TEXT_LENGTH} characters.` };
			}
			if ((action.uri?.trim().length ?? 0) > MAX_GOAL_URI_LENGTH) {
				return { ok: false, error: `evidence uri must be at most ${MAX_GOAL_URI_LENGTH} characters.` };
			}
			if (state.evidence.length >= MAX_GOAL_EVIDENCE) {
				return { ok: false, error: `Goal already has the maximum ${MAX_GOAL_EVIDENCE} evidence entries.` };
			}
			if (evidenceExists(state, id)) {
				return { ok: false, error: `Evidence '${id}' already exists.` };
			}
			return {
				ok: true,
				event: {
					type: "add_evidence",
					id,
					kind: action.kind,
					summary,
					uri: action.uri?.trim() || undefined,
					verified: action.verified,
					now,
				},
			};
		}
		case "progress":
			return { ok: true, event: { type: "progress", now } };
		case "no_progress":
			return { ok: true, event: { type: "no_progress", now } };
		case "complete": {
			const unsatisfied = state.requirements.filter((requirement) => requirement.status !== "satisfied");
			if (unsatisfied.length > 0) {
				return {
					ok: false,
					error: `Cannot complete goal: ${unsatisfied.length} requirement(s) not satisfied (${unsatisfied
						.map((requirement) => requirement.id)
						.join(", ")}).`,
				};
			}
			const requireVerifiedEvidence = options?.requireVerifiedEvidenceForCompletion ?? true;
			const linkedOpenSteps = findLinkedOpenTaskSteps(state, options?.openTaskSteps);
			if (linkedOpenSteps.length > 0) {
				return {
					ok: false,
					error: `Cannot complete goal: open task_steps still reference this goal (${linkedOpenSteps.join(", ")}). Update them via task_steps first.`,
				};
			}
			const pendingToolTasks = findNonterminalCitedToolTasks(state, options?.backgroundToolTasks);
			if (pendingToolTasks.length > 0) {
				return {
					ok: false,
					error: `Cannot complete goal: cited tool_task(s) are not complete (${pendingToolTasks.join(", ")}). Wait once via tool_task, then record the terminal result.`,
				};
			}
			const unprovenRequirementIds = getUnprovenGoalRequirementIds(state);
			if (requireVerifiedEvidence && unprovenRequirementIds.length > 0) {
				return {
					ok: false,
					error: `Cannot complete goal: requirement(s) lack verified evidence (${unprovenRequirementIds.join(", ")}). Record verified or user-confirmed evidence and cite it in satisfy_requirement.`,
				};
			}
			return {
				ok: true,
				event: { type: "complete_goal", acceptanceOverride: !requireVerifiedEvidence, now },
			};
		}
		case "block_goal": {
			const reason = action.reason.trim();
			if (!reason) return { ok: false, error: "block_goal requires a non-empty reason." };
			return { ok: true, event: { type: "block_goal", reason, now } };
		}
		default:
			return { ok: false, error: "Unknown goal action." };
	}
}

/**
 * Complete a goal on explicit user authority, even when requirements remain open or
 * blocked. Agent-facing `complete` stays evidence-gated; this path is reserved for
 * direct user lifecycle controls.
 */
export function completeGoalManually(current: GoalState | undefined, now: string): GoalActionResult {
	if (!current) {
		return { ok: false, error: "No goal exists to complete." };
	}
	if (current.status === "completed") {
		return { ok: false, error: `Goal '${current.goalId}' is already completed.` };
	}
	if (current.status === "cancelled") {
		return { ok: false, error: `Goal '${current.goalId}' is cancelled; start or override with a new goal.` };
	}
	return { ok: true, state: applyGoalEvent(current, { type: "complete_goal_manually", now }) };
}

/** Render a compact human-readable summary of the ledger after an action. */
export function summarizeGoalState(
	state: GoalState,
	options?: { action?: GoalAction; openTaskSteps?: readonly OpenTaskStepRef[] },
): string {
	const lines = [formatGoalRecord(projectGoalRecord(state))];
	if (state.requirements.length > 0) {
		const openIds = state.requirements
			.filter((requirement) => requirement.status === "open")
			.slice(0, 20)
			.map((requirement) => requirement.id);
		lines.push(
			`Legacy ledger: ${state.requirements.length} requirements, ${state.evidence.length} evidence${openIds.length > 0 ? `; open: ${openIds.join(", ")}` : ""}.`,
		);
	}
	if (options?.action) {
		lines.push(...buildGoalTaskCrossVisibilityNudges(options.action, state, options.openTaskSteps));
	}
	return lines.join("\n");
}

/**
 * Read-only goal⇄task cross-visibility (bounded slice — no shared state machine).
 *
 * `goal-tool-core` never reads or mutates task state itself (it stays pure); callers that DO
 * have access to the branch-scoped open task steps (e.g. via `buildGoalRuntimeSnapshot`) may
 * pass them through here to surface a nudge in the tool response when an open task_steps step is
 * explicitly linked to, or conservatively appears to reference, a requirement the agent just
 * satisfied or completed. Task state is never written from goal code — this only reads an
 * already-resolved, caller-supplied summary.
 */
export interface OpenTaskStepRef {
	id: string;
	content: string;
	requirementIds?: readonly string[];
	evidence?: readonly string[];
}

function findLinkedOpenTaskSteps(state: GoalState, openTaskSteps: readonly OpenTaskStepRef[] | undefined): string[] {
	if (!openTaskSteps || openTaskSteps.length === 0) return [];
	return openTaskSteps
		.filter((step) => state.requirements.some((requirement) => taskStepReferencesRequirement(step, requirement)))
		.map((step) => step.id);
}

function findNonterminalCitedToolTasks(
	state: GoalState,
	backgroundToolTasks: readonly BackgroundToolTaskRef[] | undefined,
): string[] {
	if (!backgroundToolTasks || backgroundToolTasks.length === 0) return [];
	const pending = new Set<string>();
	for (const evidence of state.evidence) {
		if (evidence.kind !== "tool" || !evidence.uri) continue;
		const task = findBackgroundToolTask(backgroundToolTasks, evidence.uri);
		if (task && task.status !== "completed") pending.add(task.taskId);
	}
	return [...pending];
}

/**
 * Nudge lines for open task steps that reference any of `requirementIds` (deduped per
 * requirement, one line naming every referencing step). Empty when there is nothing to say.
 */
export function findRequirementCrossReferenceNudges(
	state: GoalState,
	requirementIds: readonly string[],
	openTaskSteps: readonly OpenTaskStepRef[],
): string[] {
	if (openTaskSteps.length === 0 || requirementIds.length === 0) return [];
	const nudges: string[] = [];
	for (const requirementId of requirementIds) {
		const requirement = state.requirements.find((candidate) => candidate.id === requirementId);
		if (!requirement) continue;
		const referencing = openTaskSteps.filter((step) => taskStepReferencesRequirement(step, requirement));
		if (referencing.length === 0) continue;
		const stepList = referencing.map((step) => step.id).join(", ");
		nudges.push(
			`Note: open task step(s) ${stepList} appear to reference satisfied requirement '${requirement.id}' -- consider updating them via task_steps once covered.`,
		);
	}
	return nudges;
}

/**
 * After 'satisfy_requirement' or 'complete', nudge lines for linked open task steps. Returns `[]`
 * for every other action, or when
 * `openTaskSteps` was not supplied (the default -- backward compatible, no behavior change for
 * callers that do not pass task-step context).
 */
export function buildGoalTaskCrossVisibilityNudges(
	action: GoalAction,
	state: GoalState,
	openTaskSteps: readonly OpenTaskStepRef[] | undefined,
): string[] {
	if (!openTaskSteps || openTaskSteps.length === 0) return [];
	if (action.action === "satisfy_requirement") {
		return findRequirementCrossReferenceNudges(state, [action.requirementId.trim()], openTaskSteps);
	}
	if (action.action === "complete") {
		const satisfiedIds = state.requirements
			.filter((requirement) => requirement.status === "satisfied")
			.map((requirement) => requirement.id);
		return findRequirementCrossReferenceNudges(state, satisfiedIds, openTaskSteps);
	}
	return [];
}
