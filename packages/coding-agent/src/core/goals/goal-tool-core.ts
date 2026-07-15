import {
	applyGoalEvent,
	createGoalState,
	type GoalEvent,
	type GoalEvidenceKind,
	type GoalState,
} from "./goal-state.ts";

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
	| { action: "start"; goalId: string; userGoal: string }
	| { action: "add_requirement"; requirementId: string; text: string }
	| { action: "satisfy_requirement"; requirementId: string; evidenceIds?: readonly string[] }
	| { action: "block_requirement"; requirementId: string; reason: string }
	| { action: "reopen_requirement"; requirementId: string }
	| { action: "add_evidence"; evidenceId: string; kind: GoalEvidenceKind; summary: string; uri?: string }
	| { action: "progress" }
	| { action: "no_progress" }
	| { action: "complete" }
	| { action: "block_goal"; reason: string }
	| { action: "resume_goal" }
	| { action: "cancel" };

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
export function applyGoalAction(current: GoalState | undefined, action: GoalAction, now: string): GoalActionResult {
	if (action.action === "start") {
		const goalId = action.goalId.trim();
		const userGoal = action.userGoal.trim();
		if (!goalId) return { ok: false, error: "start requires a non-empty goalId." };
		if (!userGoal) return { ok: false, error: "start requires a non-empty userGoal." };
		if (current && current.status === "active" && current.goalId !== goalId) {
			return {
				ok: false,
				error: `An active goal '${current.goalId}' already exists. Complete, block, or cancel it before starting '${goalId}'.`,
			};
		}
		return { ok: true, state: createGoalState({ goalId, userGoal, now }) };
	}

	if (!current) {
		return { ok: false, error: "No active goal. Use action 'start' before recording goal updates." };
	}

	if (action.action === "resume_goal") {
		if (current.status !== "blocked") {
			return {
				ok: false,
				error: `Goal '${current.goalId}' is ${current.status}; only blocked goals can be resumed.`,
			};
		}
		return { ok: true, state: applyGoalEvent(current, { type: "resume_goal", now }) };
	}

	if (current.status !== "active") {
		if (current.status === "blocked" && action.action === "cancel") {
			return { ok: true, state: applyGoalEvent(current, { type: "cancel_goal", now }) };
		}
		const recovery =
			current.status === "blocked"
				? "Resume it with action 'resume_goal', cancel it, or start a replacement goal."
				: "Start a new goal before recording updates.";
		return {
			ok: false,
			error: `Goal '${current.goalId}' is ${current.status}. ${recovery}`,
		};
	}

	const event = toGoalEvent(current, action, now);
	if (!event.ok) return event;
	return { ok: true, state: applyGoalEvent(current, event.event) };
}

type ToGoalEventResult = { ok: true; event: GoalEvent } | GoalActionFailure;

function toGoalEvent(state: GoalState, action: GoalAction, now: string): ToGoalEventResult {
	switch (action.action) {
		case "add_requirement": {
			const id = action.requirementId.trim();
			const text = action.text.trim();
			if (!id) return { ok: false, error: "add_requirement requires a non-empty requirementId." };
			if (!text) return { ok: false, error: "add_requirement requires non-empty text." };
			if (requirementExists(state, id)) {
				return { ok: false, error: `Requirement '${id}' already exists.` };
			}
			return { ok: true, event: { type: "add_requirement", id, text, now } };
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
		case "add_evidence": {
			const id = action.evidenceId.trim();
			const summary = action.summary.trim();
			if (!id) return { ok: false, error: "add_evidence requires a non-empty evidenceId." };
			if (!summary) return { ok: false, error: "add_evidence requires a non-empty summary." };
			if (evidenceExists(state, id)) {
				return { ok: false, error: `Evidence '${id}' already exists.` };
			}
			return {
				ok: true,
				event: { type: "add_evidence", id, kind: action.kind, summary, uri: action.uri?.trim() || undefined, now },
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
			return { ok: true, event: { type: "complete_goal", now } };
		}
		case "block_goal": {
			const reason = action.reason.trim();
			if (!reason) return { ok: false, error: "block_goal requires a non-empty reason." };
			return { ok: true, event: { type: "block_goal", reason, now } };
		}
		case "resume_goal":
			return { ok: true, event: { type: "resume_goal", now } };
		case "cancel":
			return { ok: true, event: { type: "cancel_goal", now } };
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
export function summarizeGoalState(state: GoalState): string {
	const open = state.requirements.filter((requirement) => requirement.status === "open").length;
	const satisfied = state.requirements.filter((requirement) => requirement.status === "satisfied").length;
	const blocked = state.requirements.filter((requirement) => requirement.status === "blocked").length;
	const lines = [
		`Goal '${state.goalId}' (${state.status}): ${state.userGoal}`,
		`Requirements: ${state.requirements.length} total — ${open} open, ${satisfied} satisfied, ${blocked} blocked.`,
		`Evidence: ${state.evidence.length}. Stall turns: ${state.stallTurns}.`,
	];
	if (state.blockedReason) lines.push(`Blocked reason: ${state.blockedReason}`);
	return lines.join("\n");
}
