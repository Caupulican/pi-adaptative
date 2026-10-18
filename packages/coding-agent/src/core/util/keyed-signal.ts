/**
 * An in-process change signal keyed by a shared resource (its path). Every instance that owns that resource in this
 * process notifies through the same key, so a change one instance makes wakes a waiter that holds another. A change
 * another process makes is never seen here: a waiter on a machine-wide resource keeps a bounded re-read for that.
 */
export class KeyedSignal {
	private readonly listeners = new Map<string, Set<() => void>>();

	/** Returns the unsubscribe. */
	subscribe(key: string, listener: () => void): () => void {
		let keyed = this.listeners.get(key);
		if (keyed === undefined) {
			keyed = new Set();
			this.listeners.set(key, keyed);
		}
		keyed.add(listener);
		return () => {
			const current = this.listeners.get(key);
			if (current === undefined) return;
			current.delete(listener);
			if (current.size === 0) this.listeners.delete(key);
		};
	}

	/**
	 * Calls every listener of `key` subscribed when the notification starts, synchronously. A listener is a wake of a
	 * `waitFor` source, which never throws: it only re-reads what its wait waits for.
	 */
	notify(key: string): void {
		const keyed = this.listeners.get(key);
		if (keyed === undefined) return;
		for (const listener of [...keyed]) listener();
	}
}
