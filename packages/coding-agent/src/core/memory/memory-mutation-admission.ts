/**
 * Cancellation gates preparation until the first commit attempt is admitted. After admission,
 * the storage owner finishes the operation's consistency writes and reports the actual outcome.
 * Share one admission only across writes belonging to the same storage transaction.
 */
export class MemoryMutationAdmission {
	private readonly signal: AbortSignal | undefined;
	private admitted = false;

	constructor(signal?: AbortSignal) {
		this.signal = signal;
	}

	assertPending(): void {
		if (!this.admitted) this.signal?.throwIfAborted();
	}

	begin(): void {
		this.assertPending();
		this.admitted = true;
	}
}
