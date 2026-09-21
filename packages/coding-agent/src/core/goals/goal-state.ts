import { isPlainRecord } from "../util/value-guards.ts";
import { isTrustedGoalEvidence } from "./goal-acceptance.ts";

export type GoalStatus =
	| "active"
	| "paused"
	| "blocked"
	| "usage_limited"
	| "budget_limited"
	| "completed"
	| "cancelled";
export type RequirementStatus = "open" | "satisfied" | "blocked";
/**
 * What an owner clarification asked for. Mirrors `HumanInputCategory`; clarification is INFORMATION
 * and never authority, so no category here widens what the execution charter allows.
 */
export type GoalClarificationCategory = "information" | "ambiguous_requirement" | "blocked_by_user_decision";
export type GoalClarificationStatus = "pending" | "answered" | "cancelled";
export type GoalEvidenceKind = "file" | "test" | "tool" | "user" | "finding" | "worker";
export type GoalEvidenceOutcome = "succeeded" | "failed" | "canceled";

export const MAX_GOAL_OBJECTIVE_LENGTH = 4_000;
export const MAX_GOAL_EVENT_HISTORY = 128;
/** Durable bound on the objective's owner-clarification ledger. */
export const MAX_GOAL_CLARIFICATIONS = 16;
/** Bound on one clarification's recorded answer text; the exact answer stays in the human-input snapshot. */
export const MAX_GOAL_CLARIFICATION_ANSWER_LENGTH = 240;
/**
 * Upper bound of the durable runaway-signature allowance. A goal that has already consumed this many
 * distinct automatic recoveries since the last owner intervention gets no further automatic resume:
 * the collection refuses, it never evicts an older signature (eviction would reopen that loop).
 */
export const MAX_CONSUMED_RUNAWAY_SIGNATURES = 16;

/** A system stop reason produced by a bounded harness guard (runaway/stagnant tool loop). */
export function isRunawayStopReason(reason: string | undefined): boolean {
	return (
		typeof reason === "string" &&
		(reason.startsWith("runaway_tool_loop:") || reason.startsWith("stagnant_tool_cycle:"))
	);
}

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
	return !isGoalTerminalStatus(status);
}

export interface GoalState {
	goalId: string;
	userGoal: string;
	status: GoalStatus;
	/** Monotonic state revision used by compare-and-append persistence. Legacy snapshots start at 0. */
	revision?: number;
	/** Monotonic meaningful-progress revision used by the continuation stall gate. */
	progressRevision?: number;
	/** Optional owner-requested ceiling using the shared cache-discounted token-budget accounting. */
	tokenBudget?: number;
	/** Budget-counted usage attributed to all goal-owned foreground execution. */
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
	 * `undefined` as `0` everywhere it is read.
	 */
	continuationTurnsUsed?: number;
	/**
	 * Observed cumulative active milliseconds owned by foreground execution leases, including
	 * continuation passes and work after mid-run goal creation. Idle gaps and unrelated work are
	 * excluded. Same undefined-as-0 note as `continuationTurnsUsed`.
	 */
	continuationWallClockMs?: number;
	/**
	 * Observed cumulative USD attributed to this goal's own foreground provider responses. Deliberately
	 * excludes worker/subagent spend, which is reported separately. Same backward-compat note.
	 */
	continuationSpendUsd?: number;
	/**
	 * Observed cumulative USD attributed to WORKER/SUBAGENT spend for this goal's lanes (in-process worker
	 * usage via `addSpawnedUsage`, out-of-process tmux-worker usage via the advisory
	 * `reportSpawnedUsage` claim) — the counterpart this goal's OWN model spend excludes (see
	 * {@link continuationSpendUsd}). Populated by the runtime that sums lane spend by goalId; this
	 * field is only the durable slot. Same backward-compat/undefined-as-0 note as the other
	 * continuation accounting fields. This is advisory telemetry, not an implicit execution limit.
	 */
	continuationWorkerSpendUsd?: number;
	/** Durable acceptance override; avoids depending on an unbounded historical event scan. */
	acceptanceOverride?: boolean;
	/**
	 * Consecutive unrecovered system failure count. Reset only on trusted actual progress
	 * or explicit owner resume. Unverified progress, adding/reopening requirements, and alternating
	 * error strings do not reset this counter.
	 */
	systemFailureStreak?: number;
	/**
	 * Runaway/stagnant stop reasons that already received their one automatic recovery since the last
	 * owner intervention. Bounded by {@link MAX_CONSUMED_RUNAWAY_SIGNATURES}; only an owner resume
	 * clears it (automatic resumes, provider successes and evidence never do), so a signature that
	 * stops the run again stays blocked until the owner prompts, and alternating signatures cannot
	 * re-earn recovery.
	 */
	consumedRunawaySignatures?: readonly string[];
	/**
	 * Owner clarifications correlated to this objective, newest last and bounded by
	 * {@link MAX_GOAL_CLARIFICATIONS}. Durable so a clarification asked before a compaction or a
	 * restart is still known to the continuation that runs after it. Optional: snapshots persisted
	 * before clarification correlation existed carry none.
	 */
	clarifications?: readonly GoalClarification[];
}

/** One owner question correlated to this objective, and the owner's own answer to it. */
export interface GoalClarification {
	requestId: string;
	category: GoalClarificationCategory;
	/** Display text of what was asked (header + question), bounded at write time. */
	question: string;
	status: GoalClarificationStatus;
	requestedAt: string;
	answeredAt?: string;
	/** Bounded summary of the owner's answer; the exact answer lives in the human-input snapshot. */
	answerSummary?: string;
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
	 * IDs of other requirements that must be satisfied before this requirement can be worked on.
	 * Implementing this native graph tracking allows the orchestrator to automatically sequence subagent delegations.
	 */
	dependencies?: readonly string[];
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
	 * Whether the host checked the evidence's origin and kind-specific proof at add_evidence time.
	 * A model-selected kind never grants trust, including "user". Undefined denotes an unchecked ref.
	 */
	verified?: boolean;
	/** Host-observed operation outcome; verifying a failure receipt does not turn it into a success. */
	outcome?: GoalEvidenceOutcome;
	createdAt: string;
}

export type GoalEvent =
	| { type: "edit_goal"; userGoal: string; tokenBudget?: number; now: string }
	| { type: "add_requirement"; id: string; text: string; dependencies?: readonly string[]; now: string }
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
			outcome?: GoalEvidenceOutcome;
			now: string;
	  }
	| { type: "progress"; now: string }
	| { type: "no_progress"; now: string }
	| {
			type: "clarification_requested";
			/** Human-input request id; the correlation key between the ledger and the durable question. */
			requestId: string;
			category: GoalClarificationCategory;
			question: string;
			/** Why the arbitration let this ask through (a System One reason code), never a verdict. */
			detail?: string;
			now: string;
	  }
	| {
			type: "clarification_answered";
			requestId: string;
			answerSummary: string;
			cancelled?: boolean;
			now: string;
	  }
	| {
			type: "record_continuation_budget";
			/** Turns submitted in this pass (currently always 1 — the loop calls once per submitted pass). */
			turns: number;
			/** This pass's own active wall-clock duration, in milliseconds. */
			wallClockMs: number;
			/** Budget-counted provider usage; cache reads use the shared lean-budget weight. */
			tokens: number;
			/** Exact model spend attributed to the goal-owned execution. */
			spendUsd: number;
			/** Host-observed outcome of the submitted continuation turn; `rerouted` is System One's own cancel. */
			outcome?: "completed" | "interrupted" | "rerouted" | "errored";
			/** Authoritative turn ordinal captured before pass submission to prevent replay. */
			completionTurn?: number;
			now: string;
	  }
	| { type: "complete_goal"; acceptanceOverride?: boolean; now: string }
	| { type: "complete_goal_manually"; now: string }
	| { type: "block_goal"; reason: string; now: string }
	| { type: "pause_goal"; now: string }
	| { type: "resume_goal"; source?: "owner" | "system"; now: string }
	| { type: "system_stop_goal"; status: "blocked" | "usage_limited" | "budget_limited"; reason: string; now: string }
	| { type: "cancel_goal"; now: string };

function isStringArray(value: unknown): value is readonly string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function hasOptionalStringArray(record: Record<string, unknown>, key: string): boolean {
	return record[key] === undefined || isStringArray(record[key]);
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

function isGoalClarificationCategory(value: unknown): value is GoalClarificationCategory {
	return value === "information" || value === "ambiguous_requirement" || value === "blocked_by_user_decision";
}

function isGoalClarificationStatus(value: unknown): value is GoalClarificationStatus {
	return value === "pending" || value === "answered" || value === "cancelled";
}

function isGoalClarification(value: unknown): value is GoalClarification {
	if (!isPlainRecord(value)) return false;
	return (
		typeof value.requestId === "string" &&
		isGoalClarificationCategory(value.category) &&
		typeof value.question === "string" &&
		isGoalClarificationStatus(value.status) &&
		typeof value.requestedAt === "string" &&
		hasOptionalString(value, "answeredAt") &&
		hasOptionalString(value, "answerSummary")
	);
}

function isValidGoalClarifications(value: unknown): boolean {
	if (value === undefined) return true;
	return Array.isArray(value) && value.length <= MAX_GOAL_CLARIFICATIONS && value.every(isGoalClarification);
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

function hasOptionalEvidenceOutcome(record: Record<string, unknown>): boolean {
	return (
		record.outcome === undefined ||
		record.outcome === "succeeded" ||
		record.outcome === "failed" ||
		record.outcome === "canceled"
	);
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
		hasOptionalStringArray(value, "dependencies") &&
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
		hasOptionalBoolean(value, "verified") &&
		hasOptionalEvidenceOutcome(value)
	);
}

export function isGoalEvent(value: unknown): value is GoalEvent {
	if (!isPlainRecord(value) || typeof value.type !== "string" || typeof value.now !== "string") return false;
	switch (value.type) {
		case "edit_goal":
			return typeof value.userGoal === "string" && hasOptionalFiniteNumber(value, "tokenBudget");
		case "add_requirement":
			return (
				typeof value.id === "string" &&
				typeof value.text === "string" &&
				hasOptionalStringArray(value, "dependencies")
			);
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
				hasOptionalBoolean(value, "verified") &&
				hasOptionalEvidenceOutcome(value)
			);
		case "progress":
		case "no_progress":
			return true;
		case "clarification_requested":
			return (
				typeof value.requestId === "string" &&
				isGoalClarificationCategory(value.category) &&
				typeof value.question === "string" &&
				hasOptionalString(value, "detail")
			);
		case "clarification_answered":
			return (
				typeof value.requestId === "string" &&
				typeof value.answerSummary === "string" &&
				hasOptionalBoolean(value, "cancelled")
			);
		case "complete_goal":
			return hasOptionalBoolean(value, "acceptanceOverride");
		case "complete_goal_manually":
		case "pause_goal":
		case "cancel_goal":
			return true;
		case "resume_goal":
			return value.source === undefined || value.source === "owner" || value.source === "system";
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
				Number.isFinite(value.spendUsd) &&
				(value.outcome === undefined ||
					value.outcome === "completed" ||
					value.outcome === "interrupted" ||
					value.outcome === "rerouted" ||
					value.outcome === "errored") &&
				hasOptionalFiniteNumber(value, "completionTurn")
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
		hasOptionalBoolean(value, "acceptanceOverride") &&
		(value.systemFailureStreak === undefined ||
			(typeof value.systemFailureStreak === "number" &&
				Number.isSafeInteger(value.systemFailureStreak) &&
				value.systemFailureStreak >= 0)) &&
		isValidConsumedRunawaySignatures(value.consumedRunawaySignatures) &&
		isValidGoalClarifications(value.clarifications)
	);
}

function isValidConsumedRunawaySignatures(value: unknown): boolean {
	if (value === undefined) return true;
	if (!isStringArray(value) || value.length > MAX_CONSUMED_RUNAWAY_SIGNATURES) return false;
	return new Set(value).size === value.length && value.every(isRunawayStopReason);
}

function cloneRequirement(requirement: Requirement): Requirement {
	return {
		...requirement,
		evidenceIds: [...requirement.evidenceIds],
		...(requirement.dependencies ? { dependencies: [...requirement.dependencies] } : {}),
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
		...(state.consumedRunawaySignatures ? { consumedRunawaySignatures: [...state.consumedRunawaySignatures] } : {}),
		...(state.clarifications
			? { clarifications: state.clarifications.map((clarification) => ({ ...clarification })) }
			: {}),
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
		systemFailureStreak: 0,
		consumedRunawaySignatures: [],
	};
}

function updateRequirement(state: GoalState, id: string, update: (requirement: Requirement) => Requirement): void {
	const index = state.requirements.findIndex((requirement) => requirement.id === id);
	if (index < 0) return;
	const requirements = [...state.requirements];
	requirements[index] = update(requirements[index]);
	state.requirements = requirements;
}

function isPreviouslyTrustedReceiptReplay(
	existingEvidence: readonly GoalEvidenceRef[],
	newEvidence: GoalEvidenceRef,
): boolean {
	return existingEvidence.some((prev) => {
		if (!isTrustedGoalEvidence(prev)) return false;
		if (prev.kind !== newEvidence.kind || prev.outcome !== newEvidence.outcome) return false;
		if (newEvidence.uri !== undefined && newEvidence.uri.length > 0) {
			return prev.uri === newEvidence.uri;
		}
		return prev.id === newEvidence.id;
	});
}

/**
 * Keeps the clarification ledger within {@link MAX_GOAL_CLARIFICATIONS}. Settled entries are dropped
 * oldest-first so a question still waiting on the owner survives. A ledger that is entirely pending
 * cannot occur while an unanswered question holds control, but the bound is durable and has to hold
 * regardless; the oldest entry then goes, and its exact text is still in the human-input snapshot.
 */
function boundGoalClarifications(clarifications: readonly GoalClarification[]): readonly GoalClarification[] {
	if (clarifications.length <= MAX_GOAL_CLARIFICATIONS) return clarifications;
	const kept = [...clarifications];
	while (kept.length > MAX_GOAL_CLARIFICATIONS) {
		const settledIndex = kept.findIndex((clarification) => clarification.status !== "pending");
		kept.splice(settledIndex >= 0 ? settledIndex : 0, 1);
	}
	return kept;
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
			if (isGoalExecutionActive(newState.status)) newState.blockedReason = undefined;
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
				dependencies: event.dependencies,
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
			updateRequirement(newState, event.id, (requirement) => ({
				...requirement,
				status: "satisfied",
				evidenceIds: [...event.evidenceIds],
				updatedAt: event.now,
				blockedReason: undefined,
			}));
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			newState.progressRevision = (state.progressRevision ?? 0) + 1;
			break;
		}

		case "block_requirement": {
			updateRequirement(newState, event.id, (requirement) => ({
				...requirement,
				status: "blocked",
				blockedReason: event.blockedReason,
				updatedAt: event.now,
			}));
			break;
		}

		case "reopen_requirement": {
			updateRequirement(newState, event.id, (requirement) => ({
				...requirement,
				status: "open",
				blockedReason: undefined,
				updatedAt: event.now,
			}));
			newState.lastProgressAt = event.now;
			newState.stallTurns = 0;
			newState.progressRevision = (state.progressRevision ?? 0) + 1;
			break;
		}

		case "dispatch_worker": {
			// Records the requirement<->lane binding ONLY -- never satisfies the requirement and never
			// touches lastProgressAt/stallTurns. The worker's own completion later populates "worker"
			// evidence and prompts an explicit satisfy_requirement pass through the existing gate.
			updateRequirement(newState, event.id, (requirement) => ({
				...requirement,
				boundLaneId: event.laneId,
				// Start (or keep) the wait-timeout clock ONLY when this dispatch actually bound a real
				// lane -- a declined dispatch (no laneId) preserves whatever boundAt was already there.
				boundAt: event.laneId ? event.now : requirement.boundAt,
				updatedAt: event.now,
			}));
			break;
		}

		case "add_evidence": {
			const existingIndex = newState.evidence.findIndex((evidence) => evidence.id === event.id);
			const existing = existingIndex >= 0 ? newState.evidence[existingIndex] : undefined;
			const newEvidence: GoalEvidenceRef = {
				id: event.id,
				kind: event.kind,
				summary: event.summary,
				uri: event.uri,
				verified: event.verified,
				outcome: event.outcome,
				createdAt: existing !== undefined ? existing.createdAt : event.now,
			};
			if (existingIndex >= 0) {
				const updatedEvidence = [...newState.evidence];
				updatedEvidence[existingIndex] = newEvidence;
				newState.evidence = updatedEvidence;
			} else {
				newState.evidence = [...newState.evidence, newEvidence];
			}
			// Trusted progress resets the provider-failure streak only. Consumed runaway signatures
			// are cleared by an owner resume alone: a loop that already burned its recovery must not
			// re-earn one from the model's own progress.
			if (isTrustedGoalEvidence(newEvidence) && !isPreviouslyTrustedReceiptReplay(state.evidence, newEvidence)) {
				newState.progressRevision = (state.progressRevision ?? 0) + 1;
				newState.systemFailureStreak = 0;
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

		case "clarification_requested": {
			const existing = (state.clarifications ?? []).map((clarification) => ({ ...clarification }));
			const record: GoalClarification = {
				requestId: event.requestId,
				category: event.category,
				question: event.question,
				status: "pending",
				requestedAt: event.now,
			};
			const replacedIndex = existing.findIndex((clarification) => clarification.requestId === event.requestId);
			if (replacedIndex >= 0) existing[replacedIndex] = record;
			else existing.push(record);
			// Asking is not progress: progressRevision is deliberately untouched, so a question cannot
			// reset the continuation stall gate on its own.
			newState.clarifications = boundGoalClarifications(existing);
			break;
		}

		case "clarification_answered": {
			const existing = state.clarifications ?? [];
			const settledStatus: GoalClarificationStatus = event.cancelled ? "cancelled" : "answered";
			const recorded = existing.find((clarification) => clarification.requestId === event.requestId);
			// A restart can resume a question the in-turn path already settled. Replaying the identical
			// settlement is not a second owner reply, so it must not count as progress twice.
			if (recorded?.status === settledStatus && recorded.answerSummary === event.answerSummary) break;
			newState.clarifications = existing.map((clarification) =>
				clarification.requestId === event.requestId
					? {
							...clarification,
							status: settledStatus,
							answeredAt: event.now,
							answerSummary: event.answerSummary,
						}
					: { ...clarification },
			);
			// The owner's own reply (an answer, or an explicit decline) is new information the next
			// continuation has to re-evaluate against, so it counts as progress.
			newState.progressRevision = (state.progressRevision ?? 0) + 1;
			break;
		}

		case "record_continuation_budget": {
			const expectedTurn = (state.continuationTurnsUsed ?? 0) + 1;
			newState.continuationTurnsUsed = (state.continuationTurnsUsed ?? 0) + event.turns;
			newState.continuationWallClockMs = (state.continuationWallClockMs ?? 0) + event.wallClockMs;
			newState.continuationSpendUsd = (state.continuationSpendUsd ?? 0) + Math.max(0, event.spendUsd);
			newState.tokensUsed = (state.tokensUsed ?? 0) + Math.max(0, event.tokens);
			if (
				isGoalExecutionActive(state.status) &&
				event.outcome === "completed" &&
				typeof event.completionTurn === "number" &&
				Number.isSafeInteger(event.completionTurn) &&
				event.completionTurn > 0 &&
				event.completionTurn === expectedTurn
			) {
				newState.systemFailureStreak = 0;
			}
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
			if (event.source === "system") {
				// An automatic resume consumes the stop's runaway signature. The collection is bounded
				// and never evicts: at capacity the reducer records nothing more and the controller
				// refuses further automatic recovery until the owner intervenes.
				const consumed = state.consumedRunawaySignatures ?? [];
				if (
					isRunawayStopReason(state.blockedReason) &&
					!consumed.includes(state.blockedReason!) &&
					consumed.length < MAX_CONSUMED_RUNAWAY_SIGNATURES
				) {
					newState.consumedRunawaySignatures = [...consumed, state.blockedReason!];
				}
			} else {
				// Owner intent: the recovery allowance starts over.
				newState.systemFailureStreak = 0;
				newState.consumedRunawaySignatures = [];
			}
			break;
		}

		case "system_stop_goal": {
			newState.status = event.status;
			newState.blockedReason = event.reason;
			if (event.status === "blocked") {
				const isNonProviderSystemStop =
					event.reason.startsWith("goal_tool_unavailable:") ||
					event.reason.startsWith("provider_turn_limit:") ||
					isRunawayStopReason(event.reason);
				if (!isNonProviderSystemStop) {
					newState.systemFailureStreak = (state.systemFailureStreak ?? 0) + 1;
				}
			}
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
	return isGoalExecutionActive(args.state.status);
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
