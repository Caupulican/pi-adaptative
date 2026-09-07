/** Bounded, task-keyed shell lifecycle. Retirement is event-driven and never evicts an active lease. */
export class TaskShellSessions {
	private readonly retire: (key: string) => Promise<void>;
	private readonly capacity: number;
	private readonly entries = new Map<string, { active: number }>();
	private tail: Promise<void> = Promise.resolve();
	private pending = 0;
	private disposed = false;

	constructor(retire: (key: string) => Promise<void>, capacity = 128) {
		if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256)
			throw new Error("Invalid task shell capacity");
		this.retire = retire;
		this.capacity = capacity;
	}

	async acquire(key: string, signal?: AbortSignal): Promise<() => void> {
		if (this.pending >= 256) throw new Error("Task shell admission capacity reached");
		this.pending++;
		const acquired = this.tail.then(async () => {
			if (this.disposed) throw new Error("Task shells disposed");
			signal?.throwIfAborted();
			let entry = this.entries.get(key);
			if (!entry) {
				if (this.entries.size >= this.capacity) {
					const idle = [...this.entries].find(([, candidate]) => candidate.active === 0);
					if (!idle) throw new Error("Task shell capacity reached; all shells have active operations");
					// Keep ownership until physical terminal close; a failure remains retryable.
					await this.retire(idle[0]);
					this.entries.delete(idle[0]);
				}
				if (this.disposed) throw new Error("Task shells disposed");
				signal?.throwIfAborted();
				entry = { active: 0 };
			}
			this.entries.delete(key);
			this.entries.set(key, entry);
			entry.active++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				entry.active--;
			};
		});
		this.tail = acquired
			.then(
				() => {},
				() => {},
			)
			.finally(() => {
				this.pending--;
			});
		return acquired;
	}

	invalidate(invalidate: (key: string) => void): void {
		for (const key of this.entries.keys()) invalidate(key);
	}

	async dispose(): Promise<void> {
		this.disposed = true;
		await this.tail;
		await Promise.all(
			[...this.entries.keys()].map(async (key) => {
				await this.retire(key);
				this.entries.delete(key);
			}),
		);
	}
}
