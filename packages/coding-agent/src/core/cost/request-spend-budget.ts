/** Controlled spending hold; callers must not retry it as a provider outage. */
export class RequestSpendRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "RequestSpendRefusal";
	}
}

/** Transport wrappers may retain paid receipts while preserving this refusal as their cause. */
export function isRequestSpendRefusal(error: unknown): boolean {
	for (let depth = 0; depth < 8 && error instanceof Error; depth++) {
		if (error instanceof RequestSpendRefusal) return true;
		error = error.cause;
	}
	return false;
}

/** Projected admission and measured settlement shared by a sequence of model requests. */
export class RequestSpendBudget {
	private readonly maxUsd: number;
	private spentUsd = 0;
	private readonly charges = new Map<string, number>();
	private failure: RequestSpendRefusal | undefined;
	private pending: string | undefined;
	private readonly admissionListeners = new Set<(requestId: string) => void>();

	constructor(maxUsd: number) {
		if (!Number.isFinite(maxUsd) || maxUsd < 0) throw new Error("Request spending limit must be non-negative.");
		this.maxUsd = maxUsd;
	}

	/** Bounded synchronous work checkpoints at the physical request boundary; not another spend counter. */
	subscribeAdmission(listener: (requestId: string) => void): () => void {
		if (this.admissionListeners.size >= 32) throw new Error("Request admission listener capacity exceeded");
		this.admissionListeners.add(listener);
		return () => {
			this.admissionListeners.delete(listener);
		};
	}

	/** Callers serialize requests sharing this budget; preflight never reserves or records a charge. */
	remainingUsd(): number {
		this.assertHealthy();
		return Math.max(0, this.maxUsd - this.spentUsd);
	}

	assertAffordable(projectedUsd: number): void {
		if (!Number.isFinite(projectedUsd) || projectedUsd < 0 || projectedUsd > this.remainingUsd())
			throw new RequestSpendRefusal("The remaining budget cannot cover the next projected request.");
	}

	/** A cancelled logical caller cannot start another request while billing is still unknown. */
	beginRequest(receiptId: string): void {
		this.assertHealthy();
		this.pending = receiptId;
		try {
			for (const listener of this.admissionListeners) listener(receiptId);
		} catch {
			this.fail("A request admission checkpoint failed; dispatch and further spending are suspended.");
			this.assertHealthy();
		}
	}

	endRequest(receiptId: string): void {
		if (this.pending === receiptId) this.pending = undefined;
	}

	/** Record before checking health, so even an overspend never interrupts durable usage delivery. */
	record(receiptId: string, costUsd: number, measuredTokens: number): void {
		if (!Number.isFinite(costUsd) || costUsd < 0) {
			this.fail("A model response has no valid measured cost.");
			return;
		}
		const previous = this.charges.get(receiptId);
		if (previous !== undefined) {
			if (previous !== costUsd) this.fail("A response receipt changed its measured cost.");
			return;
		}
		if (this.charges.size >= 8_192) {
			this.fail("The request budget's response receipt capacity is exhausted.");
			return;
		}
		this.charges.set(receiptId, costUsd);
		this.spentUsd += costUsd;
		if (!Number.isSafeInteger(measuredTokens) || measuredTokens < 1)
			this.fail("A model response has no measured token usage; further spending is suspended.");
		if (!Number.isFinite(this.spentUsd) || this.spentUsd > this.maxUsd)
			this.fail("Measured request spending exceeded its projected limit.");
	}

	fail(reason: string): void {
		this.failure ??= new RequestSpendRefusal(reason);
	}

	assertHealthy(): void {
		if (this.failure) throw this.failure;
		if (this.pending) throw new RequestSpendRefusal("A provider request still has unsettled usage.");
	}
}
