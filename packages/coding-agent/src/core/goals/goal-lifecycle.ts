import { isDeepStrictEqual } from "node:util";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { GoalOwnerCorrection, GoalSourcePosition } from "./goal-correction-contract.ts";
import { goalOwnerActivationAt } from "./goal-owner-activation.ts";
import { type GoalRefusalAction, type RefusedGoalAction, refuseGoalAction } from "./goal-refusal.ts";
import {
	applyGoalEvent,
	type GoalEvent,
	type GoalState,
	type GoalStopModel,
	HELD_GOAL_STOP_PREFIXES,
	isGoalExecutionActive,
	isGoalResumableStatus,
	isGoalUnfinishedStatus,
	MAX_CONSUMED_RUNAWAY_SIGNATURES,
	MAX_GOAL_OBJECTIVE_LENGTH,
} from "./goal-state.ts";
import { applyGoalAction, type GoalActionFailure, type GoalActionResult } from "./goal-tool-core.ts";

export interface GoalStateRevision {
	/** Exact read snapshot supplied by the in-process writer, including which branch state it observed. */
	readonly basis?: GoalState;
	goalId: string;
	revision: number;
}

export function getGoalStateRevision(state: GoalState): GoalStateRevision {
	return { goalId: state.goalId, revision: state.revision ?? 0, basis: state };
}

export function matchesGoalStateRevision(current: GoalState | undefined, expected: GoalStateRevision): boolean {
	return (
		current !== undefined &&
		current.goalId === expected.goalId &&
		(current.revision ?? 0) === expected.revision &&
		(!expected.basis || expected.basis === current || isDeepStrictEqual(expected.basis, current))
	);
}

/**
 * Journal events that extend the ledger without revising what the goal is or whether it runs. A
 * pending evidence observation can be replayed across them: appending evidence commutes with other
 * evidence, requirement bookkeeping (an `increment` satisfying a requirement landed while parallel
 * file verifications awaited and refused all of them in the live census), dispatches, progress ticks,
 * and budget records. Lifecycle and objective changes are not in this set: the writer observed an
 * active goal with a given objective and must re-observe after those.
 */
const LEDGER_EVENT_TYPES: ReadonlySet<GoalEvent["type"]> = new Set([
	"add_evidence",
	"add_requirement",
	"satisfy_requirement",
	"block_requirement",
	"reopen_requirement",
	"dispatch_worker",
	"progress",
	"no_progress",
	"record_continuation_budget",
]);

/** Rebase a pending evidence observation across proven ledger-only journal additions. */
export function resolveGoalEvidenceCommitState(
	observed: GoalState | undefined,
	current: GoalState | undefined,
): GoalState | undefined {
	if (observed === current) return current;
	if (observed && current && observed.goalId === current.goalId) {
		const added = (current.revision ?? 0) - (observed.revision ?? 0);
		if (added >= 0 && added <= current.events.length) {
			let replayed = observed;
			for (let index = current.events.length - added; index < current.events.length; index++) {
				const event = current.events[index];
				if (!LEDGER_EVENT_TYPES.has(event.type)) break;
				replayed = applyGoalEvent(replayed, event);
			}
			// Replay also proves ancestry: an equal id/revision on a replaced branch is insufficient.
			if (isDeepStrictEqual(replayed, current)) return current;
		}
	}
	throw new Error("Goal state changed concurrently during evidence verification. Retry against the latest state.");
}

const AUTO_RESUMABLE_SYSTEM_STOP_REASON_PREFIXES = [
	"stagnant_tool_cycle:",
	"runaway_tool_loop:",
	"provider_turn_limit:",
	"overloaded:",
	"rate_limit:",
	"server_error:",
	"network:",
	"stream_stall:",
	"goal_tool_unavailable:",
] as const;

/**
 * True when the goal is blocked by a system stop, regardless of classification. The reducer records
 * the origin on every block; only a snapshot written before it did is read from the bounded event
 * history.
 */
export function isSystemStoppedGoal(state: GoalState | undefined): boolean {
	if (state?.status !== "blocked") return false;
	if (state.blockedBy !== undefined) return state.blockedBy === "system";
	for (let index = state.events.length - 1; index >= 0; index--) {
		const event = state.events[index];
		if (event?.type === "system_stop_goal") {
			return event.status === "blocked";
		}
		if (
			event?.type === "block_goal" ||
			event?.type === "pause_goal" ||
			event?.type === "resume_goal" ||
			event?.type === "complete_goal" ||
			event?.type === "complete_goal_manually" ||
			event?.type === "cancel_goal"
		) {
			return false;
		}
	}
	return false;
}

/** True only when a classified bounded guard or provider failure permits automatic recovery. */
export function isSystemBlockedGoal(state: GoalState | undefined): boolean {
	return (
		isSystemStoppedGoal(state) &&
		AUTO_RESUMABLE_SYSTEM_STOP_REASON_PREFIXES.some((prefix) => state?.blockedReason?.startsWith(prefix))
	);
}

export function getAutoResumableReasonPrefix(reason: string | undefined): string | undefined {
	if (!reason) return undefined;
	return AUTO_RESUMABLE_SYSTEM_STOP_REASON_PREFIXES.find((prefix) => reason.startsWith(prefix));
}

/** Who resumes a system-stopped goal: the system's own recovery, the owner's prompt, or a subscription's usage reset. */
export type GoalResumeSource = "system" | "owner" | "usage_reset";

/**
 * The state `current` resumes to from its system stop, read without saving; undefined when no such resume applies. The
 * owner's own prompt resumes any system stop; an automatic resume (`source: "system"`) applies only to a classified guard
 * or provider stop (whose prefix must be `requiredPrefix` when one is given) within its recovery allowance. A usage reset
 * (`source: "usage_reset"`) resumes only a goal a usage or rate limit stopped (`usage_limited`, or a system block for a
 * rate limit), whatever its recovery allowance: the reset is the provider's own word that the limit is over.
 */
export function planSystemGoalResume(
	current: GoalState,
	now: string,
	source: GoalResumeSource,
	requiredPrefix?: string,
): GoalState | undefined {
	if (source === "usage_reset") {
		const limited =
			current.status === "usage_limited" ||
			(isSystemStoppedGoal(current) && current.blockedReason?.startsWith("rate_limit:") === true);
		const resumed = limited ? resumeGoal(current, now, "system") : undefined;
		return resumed?.ok ? resumed.state : undefined;
	}
	if (!(source === "owner" ? isSystemStoppedGoal(current) : isSystemBlockedGoal(current)) || !current.blockedReason)
		return undefined;

	const prefix = getAutoResumableReasonPrefix(current.blockedReason);
	if (requiredPrefix !== undefined && prefix !== requiredPrefix) return undefined;

	if (source === "system" && (!prefix || !isAutomaticRecoveryAllowed(current, prefix))) return undefined;

	const resumed = resumeGoal(current, now, source);
	return resumed.ok ? resumed.state : undefined;
}

/**
 * Whether a session restored holding `goal` takes it up on its own (`restoreAfterResume`): it runs, or a system stop the
 * system's own recovery resumes holds it (`planSystemGoalResume`, source `"system"`). A goal a usage or rate limit stopped
 * waits for the usage reset instead (`goalUsageStop`), which the caller reads first.
 */
export function goalResumesOnRestore(goal: GoalState, now: string): boolean {
	return isGoalExecutionActive(goal.status) || planSystemGoalResume(goal, now, "system") !== undefined;
}

/**
 * A system stop of the persisted goal while it runs (`stopGoalFromSystem`), saved against the revision it was read at;
 * undefined when no goal runs.
 */
export function stopPersistedGoalFromSystem(
	host: PersistedGoalStateHost,
	stop: GoalSystemStop,
	now = new Date().toISOString(),
): GoalActionResult | undefined {
	const current = host.getGoalStateSnapshot();
	if (!current || !isGoalExecutionActive(current.status)) return undefined;
	return persistResult(host, current, stopGoalFromSystem(current, stop, now));
}

/** A runaway signature resumes once and never once the consumed set is full; a provider failure once per streak. */
function isAutomaticRecoveryAllowed(current: GoalState, prefix: string): boolean {
	if (prefix === "runaway_tool_loop:" || prefix === "stagnant_tool_cycle:") {
		const consumed = current.consumedRunawaySignatures ?? [];
		if (consumed.includes(current.blockedReason ?? "")) return false;
		return consumed.length < MAX_CONSUMED_RUNAWAY_SIGNATURES;
	}
	// Transient provider failures: exactly one automatic resume per unrecovered streak.
	return (current.systemFailureStreak ?? 0) <= 1;
}

/** Minimal durable seam shared by CLI, tools, and in-process session restoration. */
export interface PersistedGoalStateHost {
	getGoalStateSnapshot(): GoalState | undefined;
	goalSourcePosition?(goal: GoalState): GoalSourcePosition | undefined;
	recordGoalOwnerCorrection?(
		goal: GoalState,
		objective: string,
		now: string,
		expectedEntryId?: string,
	): GoalOwnerCorrection;
	saveGoalStateSnapshot(state: GoalState, expected?: GoalStateRevision): string;
	clearGoalStateSnapshot?(state: GoalState, now: string): string;
}

/** The refusal for an action asked of a goal that does not exist: the wording names the action. */
function missingGoal(action: GoalRefusalAction): RefusedGoalAction {
	return refuseGoalAction({ kind: "no_goal", action });
}

function persistResult(
	host: PersistedGoalStateHost,
	current: GoalState | undefined,
	result: GoalActionResult,
): GoalActionResult {
	if (!result.ok) return result;
	host.saveGoalStateSnapshot(result.state, current ? getGoalStateRevision(current) : undefined);
	return result;
}

export function pauseGoal(current: GoalState | undefined, now: string): GoalActionResult {
	if (!current) return missingGoal("pause");
	if (!isGoalExecutionActive(current.status)) {
		harnessLog.debug("ui", "a goal pause was refused: the goal is not active", {
			goalId: current.goalId,
			status: current.status,
		});
		return refuseGoalAction({ kind: "not_active", status: current.status });
	}
	return { ok: true, state: applyGoalEvent(current, { type: "pause_goal", now }) };
}

export function resumeGoal(current: GoalState | undefined, now: string, source?: "owner" | "system"): GoalActionResult {
	if (!current) return missingGoal("resume");
	if (!isGoalResumableStatus(current.status)) {
		harnessLog.debug("ui", "a goal resume was refused: the goal is not paused, blocked or usage-limited", {
			goalId: current.goalId,
			status: current.status,
		});
		return refuseGoalAction({ kind: "not_resumable", status: current.status });
	}
	return { ok: true, state: applyGoalEvent(current, { type: "resume_goal", now, ...(source ? { source } : {}) }) };
}

function validateGoalEdit(
	current: GoalState | undefined,
	args: { userGoal: string; tokenBudget?: number },
): RefusedGoalAction | undefined {
	if (!current) return missingGoal("edit");
	if (current.status === "cancelled") {
		harnessLog.debug("ui", "a goal edit was refused: the goal is cancelled", { goalId: current.goalId });
		return refuseGoalAction({ kind: "edit_goal_cancelled" });
	}
	const userGoal = args.userGoal.trim();
	if (!userGoal) return refuseGoalAction({ kind: "edit_objective_empty" });
	if (userGoal.length > MAX_GOAL_OBJECTIVE_LENGTH) {
		return refuseGoalAction({ kind: "edit_objective_too_long", limit: MAX_GOAL_OBJECTIVE_LENGTH });
	}
	if (args.tokenBudget !== undefined && (!Number.isSafeInteger(args.tokenBudget) || args.tokenBudget <= 0)) {
		return refuseGoalAction({ kind: "edit_token_budget_invalid" });
	}
	return undefined;
}

export function editGoal(
	current: GoalState | undefined,
	args: { userGoal: string; tokenBudget?: number },
	now: string,
): GoalActionResult {
	const invalid = validateGoalEdit(current, args);
	if (invalid) return invalid;
	if (current!.status === "completed") throw new Error("Completed goal edits require a recorded owner correction.");
	return {
		ok: true,
		state: applyGoalEvent(current!, {
			type: "edit_goal",
			userGoal: args.userGoal.trim(),
			tokenBudget: args.tokenBudget,
			now,
		}),
	};
}

export function cancelGoal(current: GoalState | undefined, now: string): GoalActionResult {
	if (!current) return missingGoal("cancel");
	if (!isGoalUnfinishedStatus(current.status)) {
		harnessLog.debug("ui", "a goal cancel was refused: the goal already ended", {
			goalId: current.goalId,
			status: current.status,
		});
		return refuseGoalAction({ kind: "goal_already_ended", status: current.status });
	}
	return { ok: true, state: applyGoalEvent(current, { type: "cancel_goal", now }) };
}

/** Explicit owner replacement. The old and new states cross one persistence boundary. */
export function replaceGoal(
	args: { goalId: string; userGoal: string; tokenBudget?: number },
	now: string,
): GoalActionResult {
	return applyGoalAction(undefined, { action: "start", ...args }, now);
}

/** A stop the system makes on an active goal: its status, why, and the model whose refusal stopped it, if one did. */
export interface GoalSystemStop {
	readonly status: "blocked" | "usage_limited" | "budget_limited";
	readonly reason: string;
	readonly refusedBy?: GoalStopModel;
}

export function stopGoalFromSystem(
	current: GoalState | undefined,
	args: GoalSystemStop,
	now: string,
): GoalActionResult {
	if (!current) return missingGoal("stop");
	if (!isGoalExecutionActive(current.status)) {
		harnessLog.debug("ui", "a system goal stop was refused: the goal is not active", {
			goalId: current.goalId,
			status: current.status,
		});
		return refuseGoalAction({ kind: "system_stop_unneeded", status: current.status });
	}
	const reason = args.reason.trim();
	if (!reason) return refuseGoalAction({ kind: "system_stop_reason_empty" });
	// The refusing model is kept by its provider and id only, whatever model record the caller holds.
	const refusedBy = args.refusedBy && { provider: args.refusedBy.provider, id: args.refusedBy.id };
	const event = {
		type: "system_stop_goal" as const,
		status: args.status,
		reason,
		...(refusedBy ? { refusedBy } : {}),
		now,
	};
	return { ok: true, state: applyGoalEvent(current, event) };
}

export function pausePersistedGoal(host: PersistedGoalStateHost, now = new Date().toISOString()): GoalActionResult {
	const current = host.getGoalStateSnapshot();
	return persistResult(host, current, pauseGoal(current, now));
}

const OWNER_STOP_GOAL_REASON = `${HELD_GOAL_STOP_PREFIXES.ownerStop} the owner stopped this bot's work; the owner's next words resume the goal`;

/**
 * The owner's stop of a bot's work, made at `stopAt` and applied at `now`, applied to its goal: a goal running, or stopped
 * by the system (a guard, a provider failure, a usage limit) and so resumed by the system on its own, is held as a system
 * stop (`blocked`, reason `owner_stop:`, `HELD_GOAL_STOP_PREFIXES`), which neither the system's own recovery nor a usage reset
 * resumes and the owner's next delivered words do (`planSystemGoalResume`, source `"owner"`). A goal the owner or its agent
 * already holds, one already held by an owner's stop, one that ended, or one the owner set going after the stop was made
 * (`goalSetGoingSince`) is left as it is; undefined then.
 */
export function holdPersistedGoalForOwnerStop(
	host: PersistedGoalStateHost,
	stopAt: number,
	now = new Date().toISOString(),
): GoalActionResult | undefined {
	const current = host.getGoalStateSnapshot();
	if (!current) return undefined;
	const systemResumes =
		isGoalExecutionActive(current.status) || isSystemStoppedGoal(current) || current.status === "usage_limited";
	const held =
		isSystemStoppedGoal(current) && current.blockedReason?.startsWith(HELD_GOAL_STOP_PREFIXES.ownerStop) === true;
	if (!systemResumes || held || goalSetGoingSince(current, stopAt)) return undefined;
	const stop = { type: "system_stop_goal", status: "blocked", reason: OWNER_STOP_GOAL_REASON, now } as const;
	return persistResult(host, current, { ok: true, state: applyGoalEvent(current, stop) });
}

/**
 * Whether the owner set the goal going after `at`: it was created then, or the owner resumed or edited it then. A system
 * resume, or the goal's own progress, after it is not the owner's word and leaves the stop to hold it.
 */
function goalSetGoingSince(state: GoalState, at: number): boolean {
	const activatedAt = goalOwnerActivationAt(state);
	return activatedAt !== undefined && Date.parse(activatedAt) > at;
}

export function resumePersistedGoal(host: PersistedGoalStateHost, now = new Date().toISOString()): GoalActionResult {
	const current = host.getGoalStateSnapshot();
	return persistResult(host, current, resumeGoal(current, now));
}

export function editPersistedGoal(
	host: PersistedGoalStateHost,
	args: { userGoal: string; tokenBudget?: number; expected?: GoalStateRevision; expectedEntryId?: string },
	now = new Date().toISOString(),
): GoalActionResult {
	const current = host.getGoalStateSnapshot();
	if (args.expected && !matchesGoalStateRevision(current, args.expected))
		throw new Error("Goal state changed; retry the edit against the current goal.");
	if (args.expectedEntryId && (!current || host.goalSourcePosition?.(current)?.goalEntryId !== args.expectedEntryId))
		throw new Error("Goal branch changed; retry the edit against the current goal.");
	const invalid = validateGoalEdit(current, args);
	if (invalid) return invalid;
	if (current?.status !== "completed") return persistResult(host, current, editGoal(current, args, now));
	if (!host.recordGoalOwnerCorrection) throw new Error("This host cannot record an explicit owner correction.");
	const correction = host.recordGoalOwnerCorrection(current, args.userGoal.trim(), now, args.expectedEntryId);
	return persistResult(host, current, {
		ok: true,
		state: applyGoalEvent(current, {
			type: "correct_completed_goal",
			correction,
			tokenBudget: args.tokenBudget,
			now,
		}),
	});
}

export function cancelPersistedGoal(host: PersistedGoalStateHost, now = new Date().toISOString()): GoalActionResult {
	const current = host.getGoalStateSnapshot();
	return persistResult(host, current, cancelGoal(current, now));
}

export type ClearPersistedGoalResult = { ok: true; cleared: boolean } | GoalActionFailure;

export function clearPersistedGoal(
	host: PersistedGoalStateHost,
	now = new Date().toISOString(),
): ClearPersistedGoalResult {
	const current = host.getGoalStateSnapshot();
	if (!current) return { ok: true, cleared: false };
	if (!host.clearGoalStateSnapshot) return refuseGoalAction({ kind: "clear_unsupported" });
	host.clearGoalStateSnapshot(current, now);
	return { ok: true, cleared: true };
}
