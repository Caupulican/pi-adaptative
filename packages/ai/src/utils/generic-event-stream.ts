export const STREAM_ENDED_WITHOUT_TERMINAL = "stream ended without a terminal result";

// Generic event stream class for async iteration
export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private queueHead = 0;
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	private done = false;
	private settled = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;
	private rejectFinalResult!: (error: Error) => void;
	private isComplete: (event: T) => boolean;
	private extractResult: (event: T) => R;

	constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
		this.isComplete = isComplete;
		this.extractResult = extractResult;
		this.finalResultPromise = new Promise((resolve, reject) => {
			this.resolveFinalResult = resolve;
			this.rejectFinalResult = reject;
		});
	}

	protected isSettled(): boolean {
		return this.settled;
	}

	private settleOk(result: R): void {
		if (this.settled) return;
		this.settled = true;
		this.resolveFinalResult(result);
	}

	private settleMissing(): void {
		if (this.settled) return;
		this.settled = true;
		const error = new Error(STREAM_ENDED_WITHOUT_TERMINAL);
		this.rejectFinalResult(error);
		// end() may run with no result() waiter (iterator-only consumers). Keep the rejection
		// available to later awaiters without turning it into an unhandled rejection.
		void this.finalResultPromise.catch(() => {});
	}

	push(event: T): void {
		if (this.done) return;

		if (this.isComplete(event)) {
			this.done = true;
			this.settleOk(this.extractResult(event));
		}

		// Deliver to waiting consumer or queue it
		const waiter = this.waiting.shift();
		if (waiter) {
			waiter({ value: event, done: false });
		} else {
			this.queue.push(event);
		}
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) {
			this.settleOk(result);
		} else {
			this.settleMissing();
		}
		// Notify all waiting consumers that we're done
		while (this.waiting.length > 0) {
			const waiter = this.waiting.shift()!;
			waiter({ value: undefined as never, done: true });
		}
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queueHead < this.queue.length) {
				const value = this.queue[this.queueHead++];
				if (this.queueHead === this.queue.length) {
					this.queue = [];
					this.queueHead = 0;
				} else if (this.queueHead >= 1024 && this.queueHead * 2 >= this.queue.length) {
					// Array.shift() makes a burst of N provider deltas O(N²). Compact consumed
					// slots occasionally while keeping the common one-at-a-time path allocation-free.
					this.queue = this.queue.slice(this.queueHead);
					this.queueHead = 0;
				}
				yield value;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}
