export interface SessionShutdownTracker {
	readonly completion: Promise<void>;
	safely(action: () => void): void;
	track(action: () => Promise<unknown>): void;
	trackRequired(action: () => Promise<unknown>): void;
	finish(): Promise<void>;
}

/** Aggregates independent session cleanup while preserving failures from required release barriers. */
export function createSessionShutdownTracker(): SessionShutdownTracker {
	const shutdowns: Promise<unknown>[] = [];
	const requiredFailures: unknown[] = [];
	let resolveCompletion!: () => void;
	let rejectCompletion!: (reason: unknown) => void;
	const completion = new Promise<void>((resolve, reject) => {
		resolveCompletion = resolve;
		rejectCompletion = reject;
	});
	void completion.catch(() => undefined);

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
		const finishing = Promise.allSettled(shutdowns).then(() => {
			if (requiredFailures.length === 1) throw requiredFailures[0];
			if (requiredFailures.length > 1) {
				throw new AggregateError(requiredFailures, "Required session resource release failed");
			}
		});
		void finishing.then(resolveCompletion, rejectCompletion);
		return completion;
	};

	return { completion, safely, track, trackRequired, finish };
}

/**
 * How long a quitting session waits for its run to settle before the run's handlers are released. The same few seconds the worker's
 * physical settlement grace uses (worker-attempt-executor.ts). Past it, the run's final message may not be persisted, and that is disclosed.
 */
export const CLOSING_RUN_SETTLE_MS = 5_000;

export interface ClosingSessionMemoryPorts {
	waitForAgentIdle(): Promise<void>;
	settleReflectionTurn(): Promise<void>;
	settleCompaction(): Promise<void>;
	releaseAgentConsumer(): void;
	shutdownMemory(): Promise<void>;
	disposeSemanticUsage(): void;
	holdWarning(message: string): void;
}

/** Settle trailing run writes before memory captures its lifecycle tail, then release usage delivery. */
export async function settleClosingSessionMemory(ports: ClosingSessionMemoryPorts): Promise<void> {
	try {
		// The aborted run's partial message and agent_end reach persistence before its consumer goes.
		try {
			if (!(await runSettlesWithin(ports.waitForAgentIdle(), CLOSING_RUN_SETTLE_MS))) {
				ports.holdWarning(
					`A run did not settle within ${CLOSING_RUN_SETTLE_MS / 1000}s of quit; its final message may not have been persisted.`,
				);
			}
		} finally {
			ports.releaseAgentConsumer();
		}
		// Reflection may be held by an abort-ignoring provider; the same bound keeps memory closable.
		if (!(await runSettlesWithin(ports.settleReflectionTurn(), CLOSING_RUN_SETTLE_MS))) {
			ports.holdWarning(
				`A reflection turn did not settle within ${CLOSING_RUN_SETTLE_MS / 1000}s of quit; its work may not have been persisted.`,
			);
		}
		// Manual and automatic compaction end cancelled, or their outstanding work is disclosed.
		if (!(await runSettlesWithin(ports.settleCompaction(), CLOSING_RUN_SETTLE_MS))) {
			ports.holdWarning(
				`A compaction did not settle within ${CLOSING_RUN_SETTLE_MS / 1000}s of quit; its result is discarded.`,
			);
		}
		await ports.shutdownMemory();
	} finally {
		// A history summary can record spend until memory finishes; later disclosure is held at close.
		ports.disposeSemanticUsage();
	}
}

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
