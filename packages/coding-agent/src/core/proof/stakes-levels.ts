/**
 * The stakes levels, as a leaf module: durable records (plan step and join settlements) validate against these names without
 * loading the stakes reader and the shell parsers it uses. `proof-stakes.ts` re-exports them.
 */

/** The stakes levels, lowest first: the durable records of a settled step or join accept exactly these. */
export const PROOF_STAKES_LEVELS = ["low", "elevated", "high"] as const;
/** How deep the proof sheet goes: `low` is two lines, `high` is the full sheet with the review and quiz offers. */
export type ProofStakesLevel = (typeof PROOF_STAKES_LEVELS)[number];

export const PROOF_STAKES_LEVEL_RANK: Readonly<Record<ProofStakesLevel, number>> = { low: 0, elevated: 1, high: 2 };

/** The highest of several recorded levels; undefined when none is recorded (a record written before levels were kept). */
export function highestStakesLevel(levels: readonly (ProofStakesLevel | undefined)[]): ProofStakesLevel | undefined {
	let best: ProofStakesLevel | undefined;
	for (const level of levels) {
		if (level !== undefined && (best === undefined || PROOF_STAKES_LEVEL_RANK[level] > PROOF_STAKES_LEVEL_RANK[best]))
			best = level;
	}
	return best;
}
