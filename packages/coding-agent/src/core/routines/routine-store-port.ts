import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type {
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

/** The existing persistent store implements this boundary; scheduling owns no second registry. */
export interface RoutineStorePort {
	reload(): void;
	subscribe(listener: () => void): () => void;
	listRoutines(): readonly RoutineDefinitionView[];
	getRoutine(routineId: string): RoutineDefinitionView | undefined;
	upsertRoutine(input: UpsertPersistentRoutineInput): RoutineDefinitionView;
	deleteRoutine(routineId: string, expectedRevision?: number, nowMs?: number): boolean;
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
	}): void;
	finishRoutineOccurrence(input: {
		occurrenceId: string;
		claimToken: string;
		outcome: RoutineTerminalOutcome;
		summary: string;
		recipient: string;
		nowMs: number;
		/** A run away's settled spend, read from its attempts' ledger usage; absent when unread. */
		awaySpentUsd?: number;
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
		/** A run away's settled spend, read from its attempts' ledger usage; absent when unread. */
		awaySpentUsd?: number;
	}): void;
	listPendingRoutineDeliveries(parentSessionId: string, limit: number): readonly RoutineDelivery[];
	acknowledgeRoutineDelivery(input: {
		occurrenceId: string;
		recipient: string;
		resultDigest: string;
		deliveryMarker: string;
		nowMs: number;
	}): void;
}
