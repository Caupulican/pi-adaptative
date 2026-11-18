import { isDeepStrictEqual } from "node:util";
import type { TurnOriginRecord } from "../../kernel/turn-origin-stamp.ts";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { workerAgentMessageId } from "../delegation/worker-agent-control.ts";
import { projectWorkerAttemptLaneRecord, selectedWorkerAttempt } from "../delegation/worker-lane-projection.ts";
import type { WorkerSavedIntent } from "../delegation/worker-saved-intent.ts";
import type { AttemptStatus, WorkerResultContract } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../orchestration/task-runtime-state.ts";
import { verificationSubjectAttempt } from "../orchestration/verification-identity.ts";
import { isGoalObjectiveId } from "../orchestration/work-state-projection.ts";
import type { RoutineOccurrence } from "./routine-contract.ts";
import { routineTurnOrigin } from "./routine-parent-input.ts";
import type { RoutineRunFacts } from "./routine-progress.ts";
import { routineInstructions } from "./routine-run-brief.ts";

/** Attempt states that can still spend: a settled run away reads only attempts past them. */
const LIVE_ATTEMPT_STATUSES: ReadonlySet<AttemptStatus> = new Set(["queued", "leased", "running", "suspended"]);

export interface RoutineWorkerRequest {
	readonly intent: WorkerSavedIntent;
	readonly instructions: string;
	readonly dispatchKey: string;
	/** Absent for the owner's own work; a third party's words when the run carries them (`routineTurnOrigin`). */
	readonly turnOrigin?: TurnOriginRecord;
}

export interface RoutineWorkerState {
	readonly taskId: string;
	readonly attemptId: string;
	readonly record: LaneRecord;
	readonly result?: WorkerResultContract;
}

interface RoutineWorkerExecutorDeps {
	getSnapshot(): TaskRuntimeProjection;
	/** Whether an attempt's spend is metered (`WorkerDelegationController.attemptIsMetered`): a run away settles that alone. */
	isMeteredAttempt(attempt: AttemptRuntimeState): boolean;
	start(
		input: RoutineWorkerRequest & { assertAdmission: () => void },
		signal: AbortSignal,
	): Promise<{ started: false; skipReason: string } | { started: true; record: LaneRecord }>;
}

/** Native execution adapter: the existing task ledger owns dispatch, retries and terminal evidence. */
export class RoutineWorkerExecutor {
	private readonly deps: RoutineWorkerExecutorDeps;

	constructor(deps: RoutineWorkerExecutorDeps) {
		this.deps = deps;
	}

	find(request: RoutineWorkerRequest): RoutineWorkerState | undefined {
		const snapshot = this.deps.getSnapshot();
		const matches = this.matchingAttempts(request, snapshot);
		if (matches.length === 0) return undefined;
		const attempt = selectedWorkerAttempt(snapshot, matches[0]!.taskId);
		if (!attempt || !matches.some((candidate) => candidate.attemptId === attempt.attemptId))
			throw new Error("Routine task selected an execution outside its original saved intent.");
		const record = projectWorkerAttemptLaneRecord(snapshot, attempt.attemptId);
		if (!record) throw new Error("Routine worker task has no retained execution state.");
		return {
			taskId: attempt.taskId,
			attemptId: attempt.attemptId,
			record,
			...(attempt.result ? { result: attempt.result } : {}),
		};
	}

	private matchingAttempts(request: RoutineWorkerRequest, snapshot: TaskRuntimeProjection): AttemptRuntimeState[] {
		const controlMessageId = workerAgentMessageId(request.intent.receiptOrigin.sessionId, request.dispatchKey);
		const matches = Object.values(snapshot.attempts).filter(
			(attempt) => attempt.dispatch.controlMessageId === controlMessageId,
		);
		if (matches.length === 0) return matches;
		const taskIds = new Set(matches.map((attempt) => attempt.taskId));
		if (taskIds.size !== 1) throw new Error("Routine dispatch resolves to conflicting worker tasks.");
		const objectiveId = snapshot.tasks[matches[0]!.taskId]?.task.objectiveId;
		if (
			!objectiveId ||
			(request.intent.objectiveId === null
				? isGoalObjectiveId(objectiveId)
				: objectiveId !== request.intent.objectiveId)
		)
			throw new Error("Routine dispatch has a different goal binding.");
		for (const attempt of matches) {
			if (
				attempt.dispatch.instructions !== request.instructions ||
				!isDeepStrictEqual(attempt.dispatch.turnOrigin, request.turnOrigin) ||
				!isDeepStrictEqual(attempt.dispatch.knowledgeReferences ?? [], request.intent.knowledgeReferences) ||
				!isDeepStrictEqual(attempt.dispatch.subscriptions ?? [], request.intent.subscriptions) ||
				!isDeepStrictEqual(attempt.dispatch.receiptOrigin, request.intent.receiptOrigin)
			)
				throw new Error("Routine dispatch identity has conflicting saved intent.");
		}
		return matches;
	}

	/** Subject retries and their exact independent reviewers share one parent delivery. */
	notificationAttemptIds(request: RoutineWorkerRequest): ReadonlySet<string> {
		const snapshot = this.deps.getSnapshot();
		const subjects = new Set(this.matchingAttempts(request, snapshot).map((attempt) => attempt.attemptId));
		const ids = new Set(subjects);
		for (const attempt of Object.values(snapshot.attempts)) {
			const task = snapshot.tasks[attempt.taskId]?.task;
			const subject = task ? verificationSubjectAttempt(snapshot, task) : undefined;
			if (subject && subjects.has(subject.attemptId)) ids.add(attempt.attemptId);
		}
		return ids;
	}

	/**
	 * What the run's attempts (subject retries and their reviewers) spent in metered (API) dollars, from their canonical
	 * ledger usage: a subscription's attempts are held by its usage windows, never by the away bound's dollars. Undefined,
	 * so the caller keeps charging the full bound, when an attempt can still run (queued, leased, running, suspended),
	 * has no canonical usage accounting, or the run's identity conflicts.
	 */
	spentUsd(request: RoutineWorkerRequest): number | undefined {
		try {
			const snapshot = this.deps.getSnapshot();
			let costUsd = 0;
			for (const attemptId of this.notificationAttemptIds(request)) {
				const attempt = snapshot.attempts[attemptId];
				if (!attempt?.usageAccounting || LIVE_ATTEMPT_STATUSES.has(attempt.status)) return undefined;
				if (this.deps.isMeteredAttempt(attempt)) costUsd += attempt.usageAccounting.total.costUsd;
			}
			return costUsd;
		} catch {
			return undefined;
		}
	}

	async start(
		request: RoutineWorkerRequest,
		assertAdmission: () => void,
		signal: AbortSignal,
	): Promise<{ started: false; skipReason: string } | { started: true; state: RoutineWorkerState }> {
		assertAdmission();
		signal.throwIfAborted();
		const existing = this.find(request);
		if (existing) return { started: true, state: existing };
		const outcome = await this.deps.start({ ...request, assertAdmission }, signal);
		if (!outcome.started) return outcome;
		const state = this.find(request);
		if (!state) throw new Error("Routine worker start returned without its durable dispatch identity.");
		return { started: true, state };
	}
}

/** The one shape of a routine run's dispatch identity, also read back to find its attempts. */
export function routineWorkerRequest(
	occurrence: RoutineOccurrence,
	intent: RoutineWorkerRequest["intent"],
	dispatchKey: string,
): RoutineWorkerRequest {
	const turnOrigin = routineTurnOrigin(occurrence);
	return {
		intent,
		instructions: routineInstructions(occurrence),
		dispatchKey,
		...(turnOrigin ? { turnOrigin } : {}),
	};
}

/**
 * What a finished worker run tells its routine's progress record beyond outcome and summary: code facts only (the
 * result's reason code and its first error's code, never their text) and the run's own report.
 */
export function routineRunFacts(execution: RoutineWorkerState): RoutineRunFacts {
	const step = execution.result?.errors[0]?.code;
	const report = execution.result?.progress;
	return {
		reasonCode: execution.result?.reasonCode ?? execution.record.reasonCode ?? execution.record.status,
		...(step ? { step } : {}),
		...(report ? { report } : {}),
	};
}
