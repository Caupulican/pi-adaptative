import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type {
	AwayEventDecisionInput,
	AwayEventDecisionResult,
	RoutineClaimResult,
	RoutineDefinitionView,
	RoutineDelivery,
	RoutineIntakeChange,
	RoutineIntakeSession,
	RoutineOccurrence,
	RoutineOccurrenceClaimInput,
	RoutineOccurrenceListFilter,
	RoutineRetireInput,
	RoutineTerminalOutcome,
	UpsertPersistentRoutineInput,
} from "./routine-contract.ts";
import type { RoutineRunFacts } from "./routine-progress.ts";
import type { RetiredRoutineRecord } from "./routine-retired.ts";
import type { RoutineWatchObservationInput, RoutineWatchOutcome } from "./routine-watch-edge.ts";

/** The existing persistent store implements this boundary; scheduling owns no second registry. */
export interface RoutineStorePort {
	reload(): void;
	subscribe(listener: () => void): () => void;
	listRoutines(): readonly RoutineDefinitionView[];
	getRoutine(routineId: string): RoutineDefinitionView | undefined;
	upsertRoutine(input: UpsertPersistentRoutineInput): RoutineDefinitionView;
	deleteRoutine(routineId: string, expectedRevision?: number, nowMs?: number): boolean;
	/**
	 * Undoes a save while the revision it wrote is the stored one: a created routine is removed, an updated one restored
	 * to `prior`, the routine as it stood just before the save. Throws when the routine changed since.
	 */
	revertRoutineSave(input: {
		readonly routineId: string;
		readonly savedRevision: number;
		readonly prior?: RoutineDefinitionView;
	}): void;
	/** The records of the routines `parentSessionId` armed that were retired, newest first. */
	listRetiredRoutines(parentSessionId: string): readonly RetiredRoutineRecord[];
	getRoutineIntakeSession(parentSessionId: string): RoutineIntakeSession | undefined;
	hasRoutineIntakeOrigin(key: string): boolean;
	recordRoutineIntake(parentSessionId: string, nowMs: number, change: RoutineIntakeChange): void;
	claimDueRoutineOccurrences(input: RoutineOccurrenceClaimInput): RoutineClaimResult;
	retireEndedRoutines(input: RoutineRetireInput): {
		readonly retired: readonly string[];
		readonly journalFull: boolean;
	};
	/** Why due routines cannot run away; recorded on each routine until a claim admits it again. */
	recordRoutineAwayRefusals(input: {
		refusals: readonly { readonly routineId: string; readonly reason: string }[];
		nowMs: number;
	}): void;
	/** Clears the recorded away refusals starting with `reasonPrefix` (their cause ended); other reasons are kept. */
	clearRoutineAwayRefusals(input: { routineIds: readonly string[]; reasonPrefix: string }): void;
	/** Away: records a closed parent's decided event attempts as pending occurrences (see the store). */
	decideAwayEventRoutines(input: AwayEventDecisionInput): AwayEventDecisionResult;
	/** A watch monitor's observation: moves the edge baseline or fires a pending occurrence (see the store). */
	observeWatch(input: RoutineWatchObservationInput): RoutineWatchOutcome;
	/** Returns a parent's away claims that lapsed before dispatch to pending without `executor`; whether any was. */
	releaseLapsedAwayClaims(input: { parentSessionId: string; nowMs: number }): boolean;
	claimManualRoutineOccurrence(input: {
		routineId: string;
		expectedRevision?: number;
		parentSessionId?: string;
		receiptOrigin?: WorkerReceiptOrigin;
		commandId: string;
		nowMs: number;
		owner: string;
		leaseMs: number;
	}): RoutineOccurrence;
	listRoutineOccurrences(filter?: RoutineOccurrenceListFilter): readonly RoutineOccurrence[];
	markRoutineDispatching(input: {
		occurrenceId: string;
		claimToken: string;
		dispatchKey: string;
		nowMs: number;
	}): void;
	/**
	 * Only a claim no executor took (an executor's explicit refusal before admission, or the host's admission guard)
	 * may return to pending; it drops `executor`.
	 */
	deferRoutineOccurrence(input: { occurrenceId: string; claimToken: string; nowMs: number }): void;
	markRoutineRunning(input: {
		occurrenceId: string;
		claimToken: string;
		dispatchKey: string;
		nowMs: number;
		executionRef?: { taskId: string; attemptId: string };
	}): void;
	markRoutineUncertain(input: {
		occurrenceId: string;
		claimToken: string;
		reason: string;
		recipient: string;
		nowMs: number;
		/** The run's code facts for its progress record (`routine-progress.ts`); absent, its outcome is its code. */
		facts?: RoutineRunFacts;
	}): void;
	finishRoutineOccurrence(input: {
		occurrenceId: string;
		claimToken: string;
		outcome: RoutineTerminalOutcome;
		summary: string;
		recipient: string;
		nowMs: number;
		/** The run reported no owner update is needed now (succeeded only). */
		ownerUpdate?: "none";
		/** The run reported the routine's stated end met (succeeded, with a stated end, only). */
		conditionMet?: true;
		/** A run away's settled spend, read from its attempts' ledger usage; absent when unread. */
		awaySpentUsd?: number;
		/** The run's code facts and own report for its progress record; absent, its outcome is its code. */
		facts?: RoutineRunFacts;
	}): void;
	resolveUncertainRoutineOccurrence(input: {
		occurrenceId: string;
		claimToken: string;
		dispatchKey: string;
		executionRef: { taskId: string; attemptId: string };
		outcome: Exclude<RoutineTerminalOutcome, "uncertain">;
		summary: string;
		recipient: string;
		nowMs: number;
		conditionMet?: true;
		/** A run away's settled spend, read from its attempts' ledger usage; absent when unread. */
		awaySpentUsd?: number;
		facts?: RoutineRunFacts;
	}): void;
	/** The owner's note on where a routine's task stands, kept in its progress record; never moves the revision. */
	noteRoutineProgress(input: { routineId: string; text: string; nowMs: number }): RoutineDefinitionView;
	/** Drops a routine's progress record: its next run starts from scratch. Never moves the revision. */
	resetRoutineProgress(input: { routineId: string }): RoutineDefinitionView;
	listPendingRoutineDeliveries(parentSessionId: string, limit: number): readonly RoutineDelivery[];
	acknowledgeRoutineDelivery(input: {
		occurrenceId: string;
		recipient: string;
		resultDigest: string;
		deliveryMarker: string;
		nowMs: number;
	}): void;
}
