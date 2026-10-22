interface ReceiptDeliveryLoopDeps {
	subscribe(signal: () => void): readonly (() => void)[];
	isDisposed(): boolean;
	flush(): void;
	warn(message: string): void;
	failureMessage: string;
}

/** Shared lifecycle for durable receipt owners; delivery policy stays with each owner. */
export class ReceiptDeliveryLoop {
	private readonly deps: ReceiptDeliveryLoopDeps;
	private readonly unsubscribe: readonly (() => void)[];
	private disposed = false;
	private scheduled = false;
	private flushing = false;

	constructor(deps: ReceiptDeliveryLoopDeps) {
		this.deps = deps;
		this.unsubscribe = deps.subscribe(() => this.signal());
		this.signal();
	}

	get active(): boolean {
		return !this.disposed && !this.deps.isDisposed();
	}

	signal(): void {
		if (!this.active || this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.scheduled = false;
			if (!this.active || this.flushing) return;
			this.flushing = true;
			try {
				this.deps.flush();
			} catch (error) {
				this.warn(`${this.deps.failureMessage}: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				this.flushing = false;
			}
		});
	}

	warn(message: string): void {
		try {
			this.deps.warn(message);
		} catch {
			/* Diagnostics cannot consume a receipt obligation. */
		}
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const unsubscribe of this.unsubscribe) {
			try {
				unsubscribe();
			} catch (error) {
				this.warn(`Receipt subscription cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}
}
