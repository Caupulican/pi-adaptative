/** Owns membership and synchronous delivery for independent observers. */
export class IndependentObserverSet<Listener> {
	private readonly listeners = new Set<Listener>();

	get size(): number {
		return this.listeners.size;
	}

	subscribe(listener: Listener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	clear(): void {
		this.listeners.clear();
	}

	/** Registrations made by a callback remain eligible for the next dispatch only. */
	notify(invoke: (listener: Listener) => void, onError: (error: unknown) => void): void {
		for (const listener of [...this.listeners]) {
			try {
				invoke(listener);
			} catch (error) {
				onError(error);
			}
		}
	}
}
