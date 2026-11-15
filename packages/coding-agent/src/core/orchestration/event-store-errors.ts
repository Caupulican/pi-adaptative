/**
 * The orchestration event store's failures (`event-store.ts`): a store that does not read or write as its files require,
 * a cursor that moved under an expected ordinal, and a read that needs the published projection snapshot first.
 */
export class OrchestrationEventStoreError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "OrchestrationEventStoreError";
	}
}

export class OrchestrationConcurrencyError extends OrchestrationEventStoreError {
	constructor(expected: number, actual: number) {
		super(`Orchestration event cursor changed: expected ${expected}, actual ${actual}.`);
		this.name = "OrchestrationConcurrencyError";
	}
}

export class OrchestrationSnapshotRequiredError extends OrchestrationEventStoreError {
	readonly throughOrdinal: number;

	constructor(throughOrdinal: number) {
		super(`Orchestration projection snapshot through ordinal ${throughOrdinal} is required.`);
		this.name = "OrchestrationSnapshotRequiredError";
		this.throughOrdinal = throughOrdinal;
	}
}
