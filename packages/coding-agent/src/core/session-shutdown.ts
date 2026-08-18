export interface SessionShutdownTracker {
	safely(action: () => void): void;
	track(action: () => Promise<unknown>): void;
	trackRequired(action: () => Promise<unknown>): void;
	finish(): Promise<void>;
}

/** Aggregates independent session cleanup while preserving failures from required release barriers. */
export function createSessionShutdownTracker(): SessionShutdownTracker {
	const shutdowns: Promise<unknown>[] = [];
	const requiredFailures: unknown[] = [];

	const safely = (action: () => void): void => {
		try {
			action();
		} catch {
			// One synchronous cleanup failure cannot skip independent resources.
		}
	};
	const track = (action: () => Promise<unknown>): void => {
		try {
			shutdowns.push(action());
		} catch {
			// A synchronously throwing adapter cannot skip independent resources.
		}
	};
	const trackRequired = (action: () => Promise<unknown>): void => {
		try {
			shutdowns.push(
				action().catch((reason: unknown) => {
					requiredFailures.push(reason);
				}),
			);
		} catch (reason) {
			requiredFailures.push(reason);
		}
	};
	const finish = (): Promise<void> => {
		const completion = Promise.allSettled(shutdowns).then(() => {
			if (requiredFailures.length === 1) throw requiredFailures[0];
			if (requiredFailures.length > 1) {
				throw new AggregateError(requiredFailures, "Required session resource release failed");
			}
		});
		void completion.catch(() => undefined);
		return completion;
	};

	return { safely, track, trackRequired, finish };
}
