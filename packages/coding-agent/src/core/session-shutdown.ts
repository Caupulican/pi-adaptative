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

/**
 * How long a quitting session waits for its run to settle before the run's handlers are released. The same few seconds the worker's
 * physical settlement grace uses (worker-attempt-executor.ts). Past it, the run's final message may not be persisted, and that is disclosed.
 */
export const CLOSING_RUN_SETTLE_MS = 5_000;

/**
 * Resolves true once `run` has ended, false when `ms` pass first. A run that ENDED IN FAILURE has still ended: its failure belongs to
 * the caller that started it, and the closing sequence only needs to know the run is over (rejecting here would skip the rest of the
 * ordered shutdown). The timer is cleared either way.
 */
export async function runSettlesWithin(run: Promise<void>, ms: number): Promise<boolean> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			run.then(
				() => true,
				() => true,
			),
			new Promise<boolean>((resolve) => {
				timer = setTimeout(() => resolve(false), ms);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
