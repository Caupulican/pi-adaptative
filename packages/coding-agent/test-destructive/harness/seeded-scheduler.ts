/**
 * Seeded op interleaver for H3 (blueprint §2/§4). The harness owns the work-list; this module only
 * orders and releases it. Interleaving is a function of (seed, prior draws): two schedulers
 * constructed from the same seed and fed the same op ids produce the same release order.
 *
 * No runtime hacks — ops are explicit functions. A round shuffles, releases every op, then awaits
 * quiescence (Promise.all) before the caller starts the next round.
 */
import { SeededRandom } from "./seeded-random.ts";

export interface ScheduledOp<T = void> {
	id: string;
	run: () => T | Promise<T>;
}

export class SeededScheduler {
	readonly rng: SeededRandom;
	private rounds = 0;

	constructor(seed: number) {
		this.rng = new SeededRandom(seed);
	}

	get seed(): number {
		return this.rng.seed;
	}

	get completedRounds(): number {
		return this.rounds;
	}

	/** Shuffle `ops` with the scheduler PRNG. The returned array is a new permutation. */
	orderForRound<T>(ops: readonly ScheduledOp<T>[]): ScheduledOp<T>[] {
		return this.rng.shuffle(ops);
	}

	/**
	 * Release every op in seeded-shuffled order, then wait until all have settled.
	 * Sync ops still go through `Promise.resolve` so the release order is the interleaving.
	 */
	async runRound<T>(ops: readonly ScheduledOp<T>[]): Promise<T[]> {
		const ordered = this.orderForRound(ops);
		const pending = ordered.map((op) => Promise.resolve().then(() => op.run()));
		const results = await Promise.all(pending);
		this.rounds += 1;
		return results;
	}
}
