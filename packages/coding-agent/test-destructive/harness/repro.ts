/**
 * The one-line repro formatter every destructive harness must call on failure (design rule §0.1):
 * `SEED=<n> INJECTION=<k> SCENARIO=<id>`. Re-running a scenario with those exact values must
 * reproduce byte-identically — this module only formats/parses the line, it does not itself
 * guarantee determinism (that's on each harness sourcing all randomness from `SeededRandom`).
 */

export interface ReproFields {
	/** The scenario's PRNG seed. */
	seed: number;
	/** The fault-injection point: an op index (crash sweep), a request index (chaos), or a round
	 * index (interleaving stress). `undefined` when the scenario has no injection axis (e.g. a pure
	 * clean-run op count probe). */
	injection?: number | string;
	/** Stable scenario id, e.g. "H1b" / "H2a" / catalogue id like "INV-W4". */
	scenario: string;
}

/** Format the mandatory one-line repro. Always emit `INJECTION=` even when absent, as `INJECTION=-`,
 * so the line has a fixed, greppable shape across every harness. */
export function formatRepro(fields: ReproFields): string {
	const injection = fields.injection === undefined ? "-" : String(fields.injection);
	return `SEED=${fields.seed} INJECTION=${injection} SCENARIO=${fields.scenario}`;
}

const REPRO_LINE_PATTERN = /^SEED=(-?\d+)\s+INJECTION=(\S+)\s+SCENARIO=(\S+)$/;

/** Parse a previously-emitted repro line back into its fields (round-trip for tooling/tests). */
export function parseRepro(line: string): ReproFields {
	const match = REPRO_LINE_PATTERN.exec(line.trim());
	if (!match) throw new TypeError(`Not a destructive-suite repro line: ${JSON.stringify(line)}`);
	const [, seedText, injectionText, scenario] = match as unknown as [string, string, string, string];
	const seed = Number(seedText);
	if (!Number.isSafeInteger(seed)) throw new TypeError(`Repro line has a non-integer seed: ${seedText}`);
	const injection = injectionText === "-" ? undefined : injectionText;
	return { seed, injection, scenario };
}

/**
 * Build an Error whose message ends with the mandatory repro line, so any assertion failure
 * surfaces it directly in the test runner's output without extra plumbing at each call site.
 */
export function reproError(message: string, fields: ReproFields): Error {
	return new Error(`${message}\n${formatRepro(fields)}`);
}
