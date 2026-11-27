import { type GoalState, isGoalExecutionActive } from "../goals/goal-state.ts";
import { goalObjectiveId, isGoalObjectiveId } from "../orchestration/work-state-projection.ts";

/** Host lifetime changes interrupt obsolete work independently of ordinary accounting revisions. */
export class ObjectiveExecutionInterruptedError extends Error {
	readonly reason: "session_disposed" | "session_replaced" | "goal_replaced" | "goal_changed";

	constructor(reason: ObjectiveExecutionInterruptedError["reason"]) {
		super(`The objective loop was interrupted: ${reason}.`);
		this.name = "ObjectiveExecutionInterruptedError";
		this.reason = reason;
	}
}

export function sameGoalExecution(expected: GoalState, current: GoalState | undefined): boolean {
	return (
		current !== undefined &&
		current.goalId === expected.goalId &&
		current.createdAt === expected.createdAt &&
		current.status === expected.status &&
		current.ownerCorrection?.ownerEntryId === expected.ownerCorrection?.ownerEntryId &&
		(current.executionEpoch ?? 0) === (expected.executionEpoch ?? 0)
	);
}

/** Only the completing foreground tool receives this in-process receipt. */
export interface GoalCompletionPresentation {
	readonly toolCallId: string;
	readonly signal: AbortSignal;
	readonly committed: boolean;
	readonly reportDispatched: boolean;
	beginReportDispatch(): void;
}

export interface GoalForegroundTurn {
	readonly completedGoal?: GoalState;
	readonly signal: AbortSignal;
	release(): void;
}

interface ForegroundState {
	completedGoal?: GoalState;
	goal: GoalState;
	controller: AbortController;
}

const combinedSignals = new WeakMap<AbortSignal, { work: AbortSignal; caller: AbortSignal }>();

/** Recover the independent caller lifetime even after a composite first aborts for a goal transition. */
function outsideGoalWork(signal: AbortSignal | undefined, work: AbortSignal): AbortSignal | undefined {
	while (signal && signal !== work) {
		const parts = combinedSignals.get(signal);
		if (parts?.work !== work) return signal;
		signal = parts.caller;
	}
	return undefined;
}

/** The session invalidates every outstanding admission before notifying subscribers of a changed goal. */
export class GoalExecutionCustody {
	private admitted?: { goal: GoalState; controller: AbortController };
	private readonly foreground = new Map<GoalForegroundTurn, ForegroundState>();
	private readonly completions = new WeakMap<
		GoalCompletionPresentation,
		{
			turn: ForegroundState;
			goal: GoalState;
			assertCurrent: () => void;
			committed: boolean;
		}
	>();

	openForeground(goal: GoalState, signal?: AbortSignal): GoalForegroundTurn {
		const work = this.signalFor(goalObjectiveId(goal.goalId), goal, true)!;
		signal?.throwIfAborted();
		const caller = outsideGoalWork(signal, work);
		const controller = new AbortController();
		const state: ForegroundState = { goal, controller };
		const turn: GoalForegroundTurn = {
			get completedGoal() {
				return state.completedGoal;
			},
			signal: caller ? AbortSignal.any([caller, controller.signal]) : controller.signal,
			release: () => {
				this.foreground.delete(turn);
				controller.abort(new ObjectiveExecutionInterruptedError("goal_changed"));
			},
		};
		this.foreground.set(turn, state);
		return turn;
	}

	prepareCompletion(
		foreground: GoalForegroundTurn,
		goal: GoalState,
		toolCallId: string,
		assertCurrent: () => void,
	): GoalCompletionPresentation {
		const turn = this.foreground.get(foreground);
		if (!turn || !toolCallId || !sameGoalExecution(turn.goal, goal) || !isGoalExecutionActive(goal.status))
			throw new ObjectiveExecutionInterruptedError("goal_changed");
		const pending = { turn, goal, assertCurrent, committed: false };
		let reportDispatched = false;
		const receipt = {
			toolCallId,
			signal: foreground.signal,
			get reportDispatched() {
				return reportDispatched;
			},
			beginReportDispatch() {
				foreground.signal.throwIfAborted();
				if (!pending.committed || reportDispatched)
					throw new Error("The committed goal report has no remaining dispatch.");
				reportDispatched = true;
			},
			get committed() {
				return pending.committed && !foreground.signal.aborted;
			},
		};
		this.completions.set(receipt, pending);
		return receipt;
	}

	assertCompleting(receipt: GoalCompletionPresentation, previous: GoalState | undefined, next: GoalState): void {
		const pending = this.completions.get(receipt);
		if (
			!pending ||
			pending.committed ||
			!sameGoalExecution(pending.goal, previous) ||
			!sameGoalExecution(pending.goal, pending.turn.goal) ||
			next.goalId !== previous?.goalId ||
			next.createdAt !== previous.createdAt ||
			next.status !== "completed" ||
			next.events.at(-1)?.type !== "complete_goal"
		)
			throw new ObjectiveExecutionInterruptedError("goal_changed");
		receipt.signal.throwIfAborted();
		pending.assertCurrent();
	}

	/** Promote only the submitting turn after the exact completed journal entry has been read back. */
	published(receipt: GoalCompletionPresentation, previous: GoalState | undefined, next: GoalState): void {
		this.assertCompleting(receipt, previous, next);
		const pending = this.completions.get(receipt)!;
		pending.turn.goal = next;
		pending.turn.completedGoal = next;
		pending.committed = true;
	}

	signalFor(objectiveId: string, current: GoalState | undefined, activeOnly = false): AbortSignal | undefined {
		if (!isGoalObjectiveId(objectiveId)) return undefined;
		const goal = assertCurrentGoalObjective(objectiveId, current)!;
		this.changed(goal);
		if (activeOnly && !isGoalExecutionActive(goal.status))
			throw new ObjectiveExecutionInterruptedError("goal_changed");
		this.admitted ??= { goal, controller: new AbortController() };
		return this.admitted.controller.signal;
	}

	changed(current?: GoalState): void {
		for (const [turn, state] of this.foreground) {
			if (!sameGoalExecution(state.goal, current)) turn.release();
		}
		const old = this.admitted;
		if (old && !sameGoalExecution(old.goal, current)) {
			this.admitted = undefined;
			old.controller.abort(new ObjectiveExecutionInterruptedError("goal_changed"));
		}
	}
}

/** Combine the caller's cancellation with the captured goal lifetime on every objective entry. */
export function objectiveExecutionSignal(
	runtime: { executionSignal?(id: string, activeOnly?: boolean): AbortSignal | undefined },
	id: string,
	signal?: AbortSignal,
	activeOnly = false,
): AbortSignal | undefined {
	const owned = runtime.executionSignal?.(id, activeOnly);
	if (!owned || !signal || owned === signal) return owned ?? signal;
	const combined = AbortSignal.any([owned, signal]);
	combinedSignals.set(combined, { work: owned, caller: signal });
	return combined;
}

/** Goal routes retain their admitted identity; unrelated durable objectives keep their own policy. */
export function assertCurrentGoalObjective(objectiveId: string, goal: GoalState | undefined): GoalState | undefined {
	if (!isGoalObjectiveId(objectiveId)) return undefined;
	if (!goal || goalObjectiveId(goal.goalId) !== objectiveId) {
		throw new ObjectiveExecutionInterruptedError("goal_replaced");
	}
	return goal;
}
