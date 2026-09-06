/**
 * Progress is an observation, not execution authority. A subscriber failure cannot throw into
 * a tool body or erase its eventual result. Retain only a count and one settlement waiter,
 * never the growing history of delivered updates or settled promises.
 */
export class ToolProgressDelivery<T> {
	private readonly deliver: (update: T) => Promise<void> | void;
	private pending = 0;
	private failed = false;
	private closed = false;
	private readonly drained = Promise.withResolvers<void>();

	constructor(deliver: (update: T) => Promise<void> | void) {
		this.deliver = deliver;
	}

	publish(update: T): void {
		// A callback retained by a faulty adapter cannot publish after the operation terminals.
		if (this.closed) return;
		try {
			const completion = this.deliver(update);
			if (!completion) return;
			this.pending++;
			void Promise.resolve(completion)
				.catch(() => {
					this.failed = true;
				})
				.then(() => {
					this.pending--;
					if (this.closed && this.pending === 0) this.drained.resolve();
				});
		} catch {
			this.failed = true;
		}
	}

	async finish(): Promise<boolean> {
		this.closed = true;
		if (this.pending > 0) await this.drained.promise;
		return this.failed;
	}
}
