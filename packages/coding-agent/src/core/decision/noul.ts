/**
 * Noul is P(the proposition is true), a number in [0, 1]. It is not a boolean and it is not
 * "confidence in a yes": 0.96 is a confident yes, 0.04 is a confident no, and 0.50 is ignorance.
 *
 * A noul answer therefore never settles anything on its own. What settles it is the pair
 * (direction, band): the direction says which end the asker needs, and the band says whether the
 * probability reached it. Collapsing that to `noul >= 0.5` throws the band away and turns "I do not
 * know" into a yes -- which is how an undecided claim ends up authorizing work.
 *
 * This module owns the band arithmetic. `system-one/policy.ts` supplies the operator's configured
 * thresholds; nothing else is allowed to invent its own cutoff.
 */

export type NoulDirection = "required_true" | "required_false";

/**
 * `hard_pass`: the required end was reached decisively; act on it.
 * `soft_pass`: provisional. The step may continue; it may not close a goal or authorize a
 *   destructive or outward-facing action.
 * `ambiguous`: undecided. Not a pass. Required-true asks again or retrieves; required-false does
 *   not treat the risk as absent.
 * `hard_fail`: the opposite end was reached decisively.
 */
export type NoulBand = "hard_pass" | "soft_pass" | "ambiguous" | "hard_fail";

export interface NoulBandThresholds {
	readonly requiredTrue: { readonly hardPass: number; readonly softPass: number; readonly hardFail: number };
	readonly requiredFalse: {
		readonly hardPassMax: number;
		readonly softPassMax: number;
		readonly hardFailMin: number;
	};
}

export const DEFAULT_NOUL_BAND_THRESHOLDS: NoulBandThresholds = Object.freeze({
	requiredTrue: Object.freeze({ hardPass: 0.93, softPass: 0.85, hardFail: 0.2 }),
	requiredFalse: Object.freeze({ hardPassMax: 0.07, softPassMax: 0.15, hardFailMin: 0.8 }),
});

/** A probability outside [0, 1], or not a number at all, is not an answer. */
export function isNoulProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function noulBand(
	probabilityTrue: number,
	direction: NoulDirection,
	thresholds: NoulBandThresholds = DEFAULT_NOUL_BAND_THRESHOLDS,
): NoulBand {
	if (!isNoulProbability(probabilityTrue)) return "hard_fail";
	if (direction === "required_true") {
		const bands = thresholds.requiredTrue;
		if (probabilityTrue >= bands.hardPass) return "hard_pass";
		if (probabilityTrue >= bands.softPass) return "soft_pass";
		if (probabilityTrue <= bands.hardFail) return "hard_fail";
		return "ambiguous";
	}
	// required_false reads the same number: a LOW P(true) is the confident answer it wants.
	const bands = thresholds.requiredFalse;
	if (probabilityTrue <= bands.hardPassMax) return "hard_pass";
	if (probabilityTrue <= bands.softPassMax) return "soft_pass";
	if (probabilityTrue >= bands.hardFailMin) return "hard_fail";
	return "ambiguous";
}

/**
 * The yes/no the band settles on, or undefined when the claim is undecided.
 *
 * This is the only sanctioned way to get a boolean out of a noul answer, and it can refuse: a
 * caller that needs a decision from an `ambiguous` band has to go and get more evidence, not pick
 * a side. A `soft_pass` answers, because the step may continue on it -- callers that must not act
 * on a provisional answer check the band itself.
 */
export function settledFromBand(band: NoulBand, direction: NoulDirection): boolean | undefined {
	const reachedRequiredEnd = band === "hard_pass" || band === "soft_pass";
	// Anything that is not one of the four bands decided nothing, same as ambiguous. Falling through
	// to a yes on an unrecognised band is the 0.5 cutoff's failure mode in another costume.
	if (!reachedRequiredEnd && band !== "hard_fail") return undefined;
	return direction === "required_true" ? reachedRequiredEnd : !reachedRequiredEnd;
}

/** Certainty, not agreement: how far the probability is from ignorance, in [0.5, 1]. */
export function noulCertainty(probabilityTrue: number): number {
	return Math.max(probabilityTrue, 1 - probabilityTrue);
}

/**
 * The truth of a recorded noul answer (`{ band, direction }`, or `{ noul, direction }` when no band
 * was stored), or undefined when it settled nothing. The one reader for answers that crossed a
 * certificate or ledger boundary: nothing downstream re-derives a boolean from the probability.
 */
export function settledAnswer(
	answer: unknown,
	thresholds: NoulBandThresholds = DEFAULT_NOUL_BAND_THRESHOLDS,
): boolean | undefined {
	if (!answer || typeof answer !== "object") return undefined;
	const record = answer as { band?: unknown; direction?: unknown; noul?: unknown };
	const direction: NoulDirection = record.direction === "required_false" ? "required_false" : "required_true";
	if (typeof record.band === "string") return settledFromBand(record.band as NoulBand, direction);
	if (isNoulProbability(record.noul)) return settledFromBand(noulBand(record.noul, direction, thresholds), direction);
	return undefined;
}

/**
 * True only when a required-true Noul answer reached `hard_pass`. A provisional `soft_pass` is not
 * decisive: what settles an item, closes a goal or names a duplicate outright needs the hard band.
 */
export function isDecisivelyTrue(
	answer: unknown,
	thresholds: NoulBandThresholds = DEFAULT_NOUL_BAND_THRESHOLDS,
): boolean {
	if (!answer || typeof answer !== "object") return false;
	const record = answer as { band?: unknown; noul?: unknown };
	if (typeof record.band === "string") return record.band === "hard_pass";
	return isNoulProbability(record.noul) && noulBand(record.noul, "required_true", thresholds) === "hard_pass";
}
