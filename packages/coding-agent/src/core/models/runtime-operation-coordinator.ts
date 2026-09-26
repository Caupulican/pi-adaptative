interface KeyedOperationRecord<TResult> {
	readonly promise: Promise<TResult>;
}

/**
 * Share one exact-key asynchronous transaction while allowing unrelated keys to run in parallel.
 * `retire()` only removes admission to stale work; the owning system remains responsible for
 * fencing that operation's side effects at its own lifecycle boundary.
 */
export class KeyedSingleFlight<TResult> {
	private readonly inFlight = new Map<string, KeyedOperationRecord<TResult>>();

	run(key: string, operation: () => Promise<TResult>): Promise<TResult> {
		const active = this.inFlight.get(key);
		if (active) return active.promise;

		const deferred = Promise.withResolvers<TResult>();
		const record = { promise: deferred.promise };
		this.inFlight.set(key, record);
		const clear = (): void => {
			if (this.inFlight.get(key) === record) this.inFlight.delete(key);
		};
		void deferred.promise.then(clear, clear);
		try {
			void operation().then(deferred.resolve, deferred.reject);
		} catch (error) {
			deferred.reject(error);
		}
		return deferred.promise;
	}

	retire(key: string): void {
		this.inFlight.delete(key);
	}
}

interface SerializedOperationRecord<TResult> {
	readonly key: string;
	readonly generation: number;
	readonly promise: Promise<TResult>;
}

/**
 * One resource owns one mutation transaction. Equivalent intent shares the active result;
 * conflicting intent waits and re-evaluates after it. Retirement fences every continuation
 * without allowing a later generation to join stale work.
 */
export class SerializedOperationCoordinator<TResult> {
	private generation = 0;
	private inFlight: SerializedOperationRecord<TResult> | undefined;

	run(key: string, operation: (isCurrent: () => boolean) => Promise<TResult>): Promise<TResult> {
		const active = this.inFlight;
		if (active && active.key === key && active.generation === this.generation) return active.promise;
		if (active) {
			return active.promise.then(
				() => this.run(key, operation),
				() => this.run(key, operation),
			);
		}

		const generation = this.generation;
		const promise = Promise.resolve().then(() => operation(() => this.generation === generation));
		const record = { key, generation, promise };
		this.inFlight = record;
		const clear = (): void => {
			if (this.inFlight === record) this.inFlight = undefined;
		};
		void promise.then(clear, clear);
		return promise;
	}

	retire(): void {
		this.generation++;
	}
}
