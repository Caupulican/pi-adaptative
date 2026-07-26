import { isPlainRecord } from "../util/value-guards.ts";

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "usage_limited"
	| "budget_limited"
	| "completed"
	| "cancelled";
export type RequirementStatus = "open" | "satisfied" | "blocked";
export type GoalEvidenceKind = "file" | "test" | "tool" | "user" | "finding" | "worker";

export const MAX_GOAL_OBJECTIVE_LENGTH = 4_000;
export const MAX_GOAL_EVENT_HISTORY = 128;

/** One shared lifecycle classification for tools, runtime, persistence, and UI. */
export function isGoalExecutionActive(status: GoalStatus): boolean {
	return status === "active";
}

export function isGoalResumableStatus(status: GoalStatus): boolean {
	return status === "paused" || status === "blocked" || status === "usage_limited";
}

export function isGoalTerminalStatus(status: GoalStatus): boolean {
	return status === "completed" || status === "cancelled" || status === "budget_limited";
}

export function isGoalUnfinishedStatus(status: GoalStatus): boolean {
	return status !== "completed" && status !== "cancelled";
}

export interface GoalState {
	goalId: string;
	userGoal: string;
	status: GoalStatus;
	/** Monotonic state revision used by compare-and-append persistence. Legacy snapshots start at 0. */
	revision?: number;
	/** Monotonic meaningful-progress revision used by the continuation stall gate. */
	progressRevision?: number;
	/** Optional owner-requested token ceiling. Charged usage is uncached input plus output. */
	tokenBudget?: number;
	/** Exact usage attributed to submitted goal-continuation turns. */
	tokensUsed?: number;
	requirements: readonly Requirement[];
	evidence: readonly GoalEvidenceRef[];
	events: readonly GoalEvent[];
	createdAt: string;
	updatedAt: string;
	lastProgressAt: string;
	stallTurns: number;
	blockedReason?: string;
	/**
	 * Cumulative continuation turns submitted for this goal across EVERY `continueGoalLoop`
	 * invocation for its lifetime (idle-driven auto-continues and manual continues alike) —
	 * durable via goal-state persistence, so it survives process restarts and idle cycles.
	 * Optional because snapshots persisted before this field existed carry no value; treat
	 * `undefined` as `0` everywhere it is read (see `applyGoalEvent`'s `record_continuation_budget`
	 * case and `goal-loop-controller.ts`'s budget check).
	 */
	continuationTurnsUsed?: number;
	/**
	 * Cumulative ACTIVE wall-clock milliseconds spent running continuation passes for this goal —
	 * the sum of each individual pass's own await duration, NOT wall-clock time elapsed between
	 * passes or during idle gaps. Same backward-compat/undefined-as-0 note as `continuationTurnsUsed`.
	 */
	continuationWallClockMs?: number;
	/**
	 * Cumulative USD attributed to this goal's own continuation passes, derived from the session's
	 * own model spend (`getCostSummary().ownCost` at the persistence dep) — deliberately excludes
	 * worker/subagent spend, which is tracked and budgeted separately. Same backward-compat note.
	 */
	continuationSpendUsd?: number;
	/**
	 * Cumulative USD attributed to WORKER/SUBAGENT spend for this goal's lanes (in-process worker
	 * usage via `addSpawnedUsage`, out-of-process tmux-worker usage via the advisory
	 * `reportSpawnedUsage` claim) — the counterpart this goal's OWN model spend excludes (see
	 * {@link continuationSpendUsd}). Populated by the runtime that sums lane spend by goalId; this
	 * field is only the durable slot. Same backward-compat/undefined-as-0 note as the other
	 * continuation budget fields. Advisory for out-of-process (tmux) workers — never a hard cap
	 * across the process boundary.
	 */
	continuationWorkerSpendUsd?: number;
	/** Durable acceptance override; avoids depending on an unbounded historical event scan. */
	acceptanceOverride?: boolean;
}

export interface Requirement {
	id: string;
	text: string;
	status: RequirementStatus;
	evidenceIds: readonly string[];
	blockedReason?: string;
	createdAt: string;
	updatedAt: string;
	/**
	 * LaneId of a worker dispatched against this requirement (set by the `dispatch_worker` event).
	 * Recording a binding never satisfies the requirement by itself -- the worker's own completion
	 * later populates `"worker"`-kind evidence and prompts an explicit `satisfy_requirement` pass.
	 */
	boundLaneId?: string;
	/**
	 * ISO timestamp of the moment `boundLaneId` was most recently bound to a REAL lane -- the clock
	 * the never-hang wait-timeout (`evaluateGoalContinuation`'s `worker_wait_timeout` reasonCode)
	 * reads to detect a worker that has hung past `maxWorkerWaitMs`. Stamped ONLY when a
	 * `dispatch_worker` event carries a lane id; a declined dispatch (no lane) leaves this field
	 * untouched, so no clock starts for a worker that never actually launched.
	 */
	boundAt?: string;
}

export interface GoalEvidenceRef {
	id: string;
	kind: GoalEvidenceKind;
	summary: string;
	uri?: string;
	/**
	 * Whether `uri` was checked against session records ("tool" evidence, a toolCallId) or the
	 * filesystem ("file" evidence, a path) at add_evidence time. `true`/`false` only when the
	 * ref was checkable; `undefined` when the evidence kind carries no checkable ref (e.g.
	 * "user"/"finding"/"test", or a "tool"/"file" entry with no `uri`).
	 */
	verified?: boolean;
	createdAt: string;
}

export type GoalEvent =
	| { type: "edit_goal"; userGoal: string; tokenBudget?: number; now: string }
	| { type: "add_requirement"; id: string; text: string; now: string }
	| { type: "satisfy_requirement"; id: string; evidenceIds: readonly string[]; now: string }
	| { type: "block_requirement"; id: string; blockedReason: string; now: string }
	| { type: "reopen_requirement"; id: string; now: string }
	| {
			type: "dispatch_worker";
			/** Requirement id the worker is bound to. */
			id: string;
			/** Instructions the worker was (or will be) dispatched with. */
			instructions: string;
			/**
			 * LaneId returned by the tool-layer dispatch side effect. Undefined when that side effect
			 * is unwired/stubbed -- the binding is then recorded with no lane target yet.
			 */
			laneId?: string;
			now: string;
	  }
	| {
			type: "add_evidence";
			id: string;
			kind: GoalEvidenceKind;
			summary: string;
			uri?: string;
			/** See {@link GoalEvidenceRef.verified}; computed by the tool layer before the event is applied. */
			verified?: boolean;
			now: string;
	  }
	| { type: "progress"; now: string }
	| { type: "no_progress"; now: string }
	| {
			type: "record_continuation_budget";
			/** Turns submitted in this pass (currently always 1 — the loop calls once per submitted pass). */
			turns: number;
			/** This pass's own active wall-clock duration, in milliseconds. */
			wallClockMs: number;
			/** Exact uncached input + output tokens produced after this pass's session-entry cursor. */
			tokens: number;
			/** Exact model spend produced after this pass's session-entry cursor. */
			spendUsd: number;
			now: string;
	  }
	| { type: "complete_goal"; acceptanceOverride?: boolean; now: string }
	| { type: "complete_goal_manually"; now: string }
	| { type: "block_goal"; reason: string; now: string }
	| { type: "pause_goal"; now: string }
	| { type: "resume_goal"; now: string }
	| { type: "system_stop_goal"; status: "blocked" | "usage_limited" | "budget_limited"; reason: string; now: string }
	| { type: "cancel_goal"; now: string };

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isGoalStatus(value: unknown): value is GoalStatus {
	return (
		value === "active" ||
		value === "paused" ||
		value === "blocked" ||
		value === "usage_limited" ||
		value === "budget_limited" ||
		value === "completed" ||
		value === "cancelled"
	);
}

function isRequirementStatus(value: unknown): value is RequirementStatus {
	return value === "open" || value === "satisfied" || value === "blocked";
}

function isGoalEvidenceKind(value: unknown): value is GoalEvidenceKind {
	return (
		value === "file" ||
		value === "test" ||
		value === "tool" ||
		value === "user" ||
		value === "finding" ||
		value === "worker"
	);
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || typeof record[key] === "string";
}

function hasOptionalBoolean(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || typeof record[key] === "boolean";
}

function hasOptionalFiniteNumber(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || (typeof record[key] === "number" && Number.isFinite(record[key]));
}

function isRequirement(value: unknown): value is Requirement {
	if (!isPlainRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		typeof value.text === "string" &&
		isRequirementStatus(value.status) &&
		isStringArray(value.evidenceIds) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		hasOptionalString(value, "blockedReason") &&
		hasOptionalString(value, "boundLaneId") &&
		hasOptionalString(value, "boundAt")
	);
}

function isGoalEvidenceRef(value: unknown): value is GoalEvidenceRef {
	if (!isPlainRecord(value)) return false;
	return (
		typeof value.id === "string" &&
		isGoalEvidenceKind(value.kind) &&
		typeof value.summary === "string" &&
		typeof value.createdAt === "string" &&
		hasOptionalString(value, "uri") &&
		hasOptionalBoolean(value, "verified")
	);
}

export function isGoalEvent(value: unknown): value is GoalEvent {
	if (!isPlainRecord(value) || typeof value.type !== "string" || typeof value.now !== "string") return false;
	switch (value.type) {
		case "edit_goal":
			return typeof value.userGoal === "string" && hasOptionalFiniteNumber(value, "tokenBudget");
		case "add_requirement":
			return typeof value.id === "string" && typeof value.text === "string";
		case "satisfy_requirement":
			return typeof value.id === "string" && isStringArray(value.evidenceIds);
		case "block_requirement":
			return typeof value.id === "string" && typeof value.blockedReason === "string";
		case "reopen_requirement":
			return typeof value.id === "string";
		case "dispatch_worker":
			return (
				typeof value.id === "string" && typeof value.instructions === "string" && hasOptionalString(value, "laneId")
			);
		case "add_evidence":
			return (
				typeof value.id === "string" &&
				isGoalEvidenceKind(value.kind) &&
				typeof value.summary === "string" &&
				hasOptionalString(value, "uri") &&
				hasOptionalBoolean(value, "verified")
			);
		case "progress":
		case "no_progress":
			return true;
		case "complete_goal":
			return hasOptionalBoolean(value, "acceptanceOverride");
		case "complete_goal_manually":
		case "pause_goal":
		case "resume_goal":
		case "cancel_goal":
			return true;
		case "block_goal":
			return typeof value.reason === "string";
		case "system_stop_goal":
			return (
				(value.status === "blocked" || value.status === "usage_limited" || value.status === "budget_limited") &&
				typeof value.reason === "string"
			);
		case "record_continuation_budget":
			return (
				typeof value.turns === "number" &&
				Number.isFinite(value.turns) &&
				typeof value.wallClockMs === "number" &&
				Number.isFinite(value.wallClockMs) &&
				typeof value.tokens === "number" &&
				Number.isFinite(value.tokens) &&
				typeof value.spendUsd === "number" &&
				Number.isFinite(value.spendUsd)
			);
		default:
			return false;
	}
}

export function isGoalState(value: unknown): value is GoalState {
	if (!isPlainRecord(value)) return false;
	return (
		typeof value.goalId === "string" &&
		typeof value.userGoal === "string" &&
		isGoalStatus(value.status) &&
		hasOptionalFiniteNumber(value, "revision") &&
		hasOptionalFiniteNumber(value, "progressRevision") &&
		hasOptionalFiniteNumber(value, "tokenBudget") &&
		hasOptionalFiniteNumber(value, "tokensUsed") &&
		Array.isArray(value.requirements) &&
		value.requirements.every(isRequirement) &&
		Array.isArray(value.evidence) &&
		value.evidence.every(isGoalEvidenceRef) &&
		Array.isArray(value.events) &&
		value.events.every(isGoalEvent) &&
		typeof value.createdAt === "string" &&
		typeof value.updatedAt === "string" &&
		typeof value.lastProgressAt === "string" &&
		typeof value.stallTurns === "number" &&
		Number.isFinite(value.stallTurns) &&
		hasOptionalString(value, "blockedReason") &&
		hasOptionalFiniteNumber(value, "continuationTurnsUsed") &&
		hasOptionalFiniteNumber(value, "continuationWallClockMs") &&
		hasOptionalFiniteNumber(value, "continuationSpendUsd") &&
		hasOptionalFiniteNumber(value, "continuationWorkerSpendUsd") &&
		hasOptionalBoolean(value, "acceptanceOverride")
	);
}

function cloneRequirement(requirement: Requirement): Requirement {
	return {
		...requirement,
		evidenceIds: [...requirement.evidenceIds],
	};
}

function cloneGoalEvidenceRef(evidence: GoalEvidenceRef): GoalEvidenceRef {
	return { ...evidence };
}

function cloneGoalEvent(event: GoalEvent): GoalEvent {
	if (event.type === "satisfy_requirement") {
		return { ...event, evidenceIds: [...event.evidenceIds] };
	}
	return { ...event };
}

export function cloneGoalEventForStorage(event: GoalEvent): GoalEvent {
	return cloneGoalEvent(event);
}

function cloneGoalState(state: GoalState): GoalState {
	return {
		...state,
		requirements: state.requirements.map(cloneRequirement),
		evidence: state.evidence.map(cloneGoalEvidenceRef),
		events: state.events.map(cloneGoalEvent),
	};
}

export function cloneGoalStateForStorage(state: GoalState): GoalState {
	return cloneGoalState(state);
}

export function createGoalState(args: {
	goalId: string;
	userGoal: string;
	now: string;
	tokenBudget?: number;
}): GoalState {
	return {
		goalId: args.goalId,
		userGoal: args.userGoal,
		status: "active",
		revision: 0,
		progressRevision: 0,
		tokensUsed: 0,
		...(args.tokenBudget !== undefined ? { tokenBudget: args.tokenBudget } : {}),
		requirements: [],
		evidence: [],
		events: [],
		createdAt: args.now,
		updatedAt: args.now,
		lastProgressAt: args.now,
		stallTurns: 0,
		continuationTurnsUsed: 0,
		continuationWallClockMs: 0,
		continuationSpendUsd: 0,
		continuationWorkerSpendUsd: 0,
	};
}

export function applyGoalEvent(state: GoalState, event: GoalEvent): GoalState {
	const newState: GoalState = {
		...state,
		revision: (state.revision ?? 0) + 1,
		requirements: state.requirements.map(cloneRequirement),
		evidence: state.evidence.map(cloneGoalEvidenceRef),
		events: [...state.events.map(cloneGoalEvent), cloneGoalEvent(event)].slice(-MAX_GOAL_EVENT_HISTORY),
		updatedAt: event.now,
	};

	switch (event.type) {
		case "edit_goal": {
			newState.userGoal = event.userGoal;
			if (event.tokenBudget !== undefined) newState.tokenBudget = event.tokenBudget;
			if (state.status === "completed") newState.status = "active";
			if (
				state.status === "budget_limited" &&
				event.tokenBudget !== undefined &&
				event.tokenBudget > (state.tokensUsed ?? 0)
			) {
				newState.status = "active";
			}
			if (newState.status === "active") newState.blockedReason = undefined;
			newState.progressRevision = (state.progressRevision ?? 0) + 1;
			break;
		}

		case "add_requirement": {
			const existingIndex = newState.requirements.findIndex((requirement) => requirement.id === event.id);
			const newRequirement: Requirement = {
				id: event.id,
				text: event.text,
				status: "open",
				evidenceIds: [],
				createdAt: existingIndex >= 0 ? newState.requirements[existingIndex].createdAt : event.now,
				updatedAt: event.now,
			};
			if (existingIndex >= 0) {
				const updatedRequirements = [...newState.requirements];
				updatedRequirements[existingIndex] = newRequirement;
				newState.requirements = updatedRequirements;
			} else {
				newState.requirements = [...newState.requirements, newRequirement];
			}
			newState.progressRevision = (state.progressRevision ?? 0) + 1;
			break;
		}

		case "satisfy_requirement": {
			const existingIndex = newState.requirements.findIndex((requirement) => requirement.id === event.id);
			if (existingIndex >= 0) {
				const requirement = newState.requirements[existingIndex];
				const updatedRequirements = [...newState.requirements];
				updatedRequirements[existingIndex] = {
					...requirement,
					status: "satisfied",
					evidenceIds: [...event.evidenceIds],
					updatedAt: event.now,
					blockedReason: undefined,
				};
				newState.requirements = updatedRequirements;
			}
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			newState.progressRevision = (state.progressRevision ?? 0) + 1;
			break;
		}

		case "block_requirement": {
			const existingIndex = newState.requirements.findIndex((requirement) => requirement.id === event.id);
			if (existingIndex >= 0) {
				const requirement = newState.requirements[existingIndex];
				const updatedRequirements = [...newState.requirements];
				updatedRequirements[existingIndex] = {
					...requirement,
					status: "blocked",
					blockedReason: event.blockedReason,
					updatedAt: event.now,
				};
				newState.requirements = updatedRequirements;
			}
			break;
		}

		case "reopen_requirement": {
			const existingIndex = newState.requirements.findIndex((requirement) => requirement.id === event.id);
			if (existingIndex >= 0) {
				const requirement = newState.requirements[existingIndex];
				const updatedRequirements = [...newState.requirements];
				updatedRequirements[existingIndex] = {
					...requirement,
					status: "open",
					blockedReason: undefined,
					updatedAt: event.now,
				};
				newState.requirements = updatedRequirements;
			}
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			break;
		}

		case "dispatch_worker": {
			// Records the requirement<->lane binding ONLY -- never satisfies the requirement and never
			// touches lastProgressAt/stallTurns. The worker's own completion later populates "worker"
			// evidence and prompts an explicit satisfy_requirement pass through the existing gate.
			const existingIndex = newState.requirements.findIndex((requirement) => requirement.id === event.id);
			if (existingIndex >= 0) {
				const requirement = newState.requirements[existingIndex];
				const updatedRequirements = [...newState.requirements];
				updatedRequirements[existingIndex] = {
					...requirement,
					boundLaneId: event.laneId,
					// Start (or keep) the wait-timeout clock ONLY when this dispatch actually bound a real
					// lane -- a declined dispatch (no laneId) preserves whatever boundAt was already there.
					boundAt: event.laneId ? event.now : requirement.boundAt,
					updatedAt: event.now,
				};
				newState.requirements = updatedRequirements;
			}
			break;
		}

		case "add_evidence": {
			const existingIndex = newState.evidence.findIndex((evidence) => evidence.id === event.id);
			const newEvidence: GoalEvidenceRef = {
				id: event.id,
				kind: event.kind,
				summary: event.summary,
				uri: event.uri,
				verified: event.verified,
				createdAt: existingIndex >= 0 ? newState.evidence[existingIndex].createdAt : event.now,
			};
			if (existingIndex >= 0) {
				const updatedEvidence = [...newState.evidence];
				updatedEvidence[existingIndex] = newEvidence;
				newState.evidence = updatedEvidence;
			} else {
				newState.evidence = [...newState.evidence, newEvidence];
			}
			if (event.kind === "user" || event.verified === true) {
				newState.progressRevision = (state.progressRevision ?? 0) + 1;
			}
			break;
		}

		case "progress": {
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			newState.progressRevision = (state.progressRevision ?? 0) + 1;
			break;
		}

		case "no_progress": {
			newState.stallTurns = state.stallTurns + 1;
			break;
		}

		case "record_continuation_budget": {
			newState.continuationTurnsUsed = (state.continuationTurnsUsed ?? 0) + event.turns;
			newState.continuationWallClockMs = (state.continuationWallClockMs ?? 0) + event.wallClockMs;
			newState.continuationSpendUsd = (state.continuationSpendUsd ?? 0) + Math.max(0, event.spendUsd);
			newState.tokensUsed = (state.tokensUsed ?? 0) + Math.max(0, event.tokens);
			break;
		}

		case "complete_goal": {
			const hasUnsatisfied = newState.requirements.some((requirement) => requirement.status !== "satisfied");
			if (!hasUnsatisfied) {
				newState.status = "completed";
				newState.blockedReason = undefined;
				newState.acceptanceOverride = event.acceptanceOverride;
			}
			break;
		}

		case "complete_goal_manually": {
			newState.status = "completed";
			newState.blockedReason = undefined;
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			newState.acceptanceOverride = true;
			break;
		}

		case "block_goal": {
			newState.status = "blocked";
			newState.blockedReason = event.reason;
			break;
		}

		case "pause_goal": {
			newState.status = "paused";
			newState.blockedReason = undefined;
			break;
		}

		case "resume_goal": {
			newState.status = "active";
			newState.blockedReason = undefined;
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			break;
		}

		case "system_stop_goal": {
			newState.status = event.status;
			newState.blockedReason = event.reason;
			break;
		}

		case "cancel_goal": {
			newState.status = "cancelled";
			newState.blockedReason = undefined;
			break;
		}
	}

	return newState;
}

export function shouldContinueGoalLoop(args: { state: GoalState; maxStallTurns: number; now: string }): boolean {
	if (!isGoalExecutionActive(args.state.status)) {
		return false;
	}
	if (args.state.stallTurns >= args.maxStallTurns) {
		return false;
	}
	return true;
}

export function serializeGoalState(state: GoalState): string {
	return JSON.stringify(cloneGoalState(state), null, 2);
}

export function parseGoalState(text: string): GoalState | undefined {
	try {
		const parsed: unknown = JSON.parse(text);
		if (!isGoalState(parsed)) return undefined;
		return cloneGoalState(parsed);
	} catch {
		return undefined;
	}
}
