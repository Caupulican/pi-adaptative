/**
 * Deterministic PRNG for the destructive suite (design rule §0.1: seeded determinism only — no
 * `Math.random()`, no `Date.now()` entropy, no real-timer races anywhere in this tree). Every
 * source of randomness in every harness (fault selection, interleaving order, chaos scenarios)
 * must be derived from a `SeededRandom` constructed from the scenario's numeric seed, so a failure
 * captured as `SEED=<n> INJECTION=<k> SCENARIO=<id>` reproduces byte-identically on rerun.
 *
 * mulberry32: a small, fast, public-domain 32-bit PRNG (Tommy Ettinger). Not cryptographic — this
 * is a test harness, not a security boundary — but it has good statistical distribution for the
 * bounded draws (fault selection, shuffles) this suite needs, and is trivially reimplementable if
 * ever needed outside JS, which keeps a captured seed portable.
 */

export type Mulberry32State = number;

/** One mulberry32 step: advances `state` and returns a float in [0, 1). */
export function mulberry32Next(state: Mulberry32State): { value: number; nextState: Mulberry32State } {
	let t = (state + 0x6d2b79f5) | 0;
	const nextState = t;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	const value = ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	return { value, nextState };
}

/**
 * Stateful, replayable PRNG wrapper. `seed` must be a non-negative safe integer (bounded, so a
 * repro line is always copy-pasteable and never loses precision). Every derived draw
 * (`nextFloat`/`nextInt`/`pick`/`shuffle`) advances the same internal state deterministically —
 * two `SeededRandom` instances constructed from the same seed and driven through the same call
 * sequence produce byte-identical draws.
 */
export class SeededRandom {
	readonly seed: number;
	private state: Mulberry32State;
	private drawCount = 0;

	constructor(seed: number) {
		if (!Number.isSafeInteger(seed) || seed < 0) {
			throw new TypeError("SeededRandom requires a non-negative safe-integer seed.");
		}
		this.seed = seed;
		// mulberry32 with state 0 immediately diverges from state 1, 2, ... in its low bits; seeding
		// the state directly from the caller's seed keeps distinct seeds visibly distinct draws.
		this.state = seed | 0;
	}

	/** Count of draws made so far; useful for repro annotations and invariant assertions. */
	get draws(): number {
		return this.drawCount;
	}

	/** Next float in [0, 1). */
	nextFloat(): number {
		const { value, nextState } = mulberry32Next(this.state);
		this.state = nextState;
		this.drawCount += 1;
		return value;
	}

	/** Next integer in [min, max] inclusive. */
	nextInt(min: number, max: number): number {
		if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || max < min) {
			throw new TypeError(`SeededRandom.nextInt requires min <= max safe integers (got ${min}, ${max}).`);
		}
		const span = max - min + 1;
		return min + Math.floor(this.nextFloat() * span);
	}

	/** Pick one element of a non-empty readonly array. */
	pick<T>(items: readonly T[]): T {
		if (items.length === 0) throw new RangeError("SeededRandom.pick requires a non-empty array.");
		return items[this.nextInt(0, items.length - 1)] as T;
	}

	/**
	 * Weighted pick: `entries` is `[item, weight]` pairs with non-negative weights summing > 0.
	 * Used by ChaosProvider's per-scenario fault-menu weights.
	 */
	weightedPick<T>(entries: ReadonlyArray<readonly [T, number]>): T {
		const total = entries.reduce((sum, [, weight]) => sum + weight, 0);
		if (total <= 0) throw new RangeError("SeededRandom.weightedPick requires a positive total weight.");
		let threshold = this.nextFloat() * total;
		for (const [item, weight] of entries) {
			threshold -= weight;
			if (threshold <= 0) return item;
		}
		// Floating-point rounding can leave a hair of `threshold` unconsumed; fall back to the last
		// entry rather than returning undefined.
		return entries[entries.length - 1]![0];
	}

	/** Fisher-Yates shuffle; returns a new array, does not mutate `items`. */
	shuffle<T>(items: readonly T[]): T[] {
		const result = [...items];
		for (let i = result.length - 1; i > 0; i--) {
			const j = this.nextInt(0, i);
			const temp = result[i] as T;
			result[i] = result[j] as T;
			result[j] = temp;
		}
		return result;
	}

	/** Derive an independent child seed, for fanning one scenario seed out to sub-harnesses. */
	nextSeed(): number {
		return this.nextInt(0, 0x7fffffff);
	}
}
