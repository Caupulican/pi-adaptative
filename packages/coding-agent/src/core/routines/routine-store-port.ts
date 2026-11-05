import type { WorkerReceiptOrigin } from "../orchestration/worker-receipt-origin.ts";
import type {
	RoutineDefinitionView,
	RoutineDelivery,
	RoutineOccurrence,
	RoutineOccurrenceClaimInput,
	RoutineOccurrenceListFilter,
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
	claimDueRoutineOccurrences(input: RoutineOccurrenceClaimInput): readonly RoutineOccurrence[];
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
	/** Only an executor's explicit refusal before admission may return a dispatch to pending. */
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
