/**
 * Noul is P(the proposition is true), a number in [0, 1]. It is not a boolean and it is not
 * "confidence in a yes": 0.96 is a confident yes, 0.04 is a confident no, and 0.50 is ignorance.
 *
 * A noul answer therefore never settles anything on its own. What settles it is the pair
 * (direction, band): the direction says which end the asker needs, and the band says whether the
 * probability reached it. Collapsing that to `noul >= 0.5` throws the band away and turns "I do not
 * know" into a yes -- which is how an undecided claim ends up authorizing work.
 *
 * This module owns the band arithmetic; the cuts live in `thresholds.ts` (one table of families), and
 * nothing else is allowed to invent its own cutoff.
 */

import { YES_NO_BANDS, type YesNoFamily } from "./thresholds.ts";

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

/** The gating family: the bands every reader uses when it names no family. */
export const DEFAULT_NOUL_BAND_THRESHOLDS: NoulBandThresholds = YES_NO_BANDS.gating;

/** A probability outside [0, 1], or not a number at all, is not an answer. */
export function isNoulProbability(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** The band of P(true) against the end the asker needs, under a family's cuts or explicit thresholds. */
export function noulBand(
	probabilityTrue: number,
	direction: NoulDirection,
	thresholds: NoulBandThresholds | YesNoFamily = DEFAULT_NOUL_BAND_THRESHOLDS,
): NoulBand {
	if (!isNoulProbability(probabilityTrue)) return "hard_fail";
	const family = typeof thresholds === "string" ? YES_NO_BANDS[thresholds] : thresholds;
	if (direction === "required_true") {
		const bands = family.requiredTrue;
		if (probabilityTrue >= bands.hardPass) return "hard_pass";
		if (probabilityTrue >= bands.softPass) return "soft_pass";
		if (probabilityTrue <= bands.hardFail) return "hard_fail";
		return "ambiguous";
	}
	// required_false reads the same number: a LOW P(true) is the confident answer it wants.
	const bands = family.requiredFalse;
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

/**
 * The P(true) an answer carries, or undefined when it carries none: a question that was never asked,
 * an absent answer, or anything that is not a probability. There is no fallback: an unasked question
 * is not a P=1 or a P=0. A literal boolean is an answer an engine computed (a mechanical read, a model
 * that returned true/false), so it is P=1 or P=0.
 */
export function noulProbability(answer: unknown): number | undefined {
	if (typeof answer === "boolean") return answer ? 1 : 0;
	if (typeof answer === "number") return isNoulProbability(answer) ? answer : undefined;
	if (!answer || typeof answer !== "object") return undefined;
	const record = answer as { noul?: unknown; probabilityTrue?: unknown; value?: unknown; boolean?: unknown };
	for (const candidate of [record.noul, record.probabilityTrue, record.value, record.boolean]) {
		if (typeof candidate === "boolean") return candidate ? 1 : 0;
		if (isNoulProbability(candidate)) return candidate;
	}
	return undefined;
}

/** A band, or `unasked` for an answer that holds no probability: its caller decides that outcome, never a pass or a fail. */
export type NoulReading = NoulBand | "unasked";

export function readNoul(
	answer: unknown,
	direction: NoulDirection,
	thresholds: NoulBandThresholds | YesNoFamily = DEFAULT_NOUL_BAND_THRESHOLDS,
): NoulReading {
	const probability = noulProbability(answer);
	return probability === undefined ? "unasked" : noulBand(probability, direction, thresholds);
}

/**
 * {@link readNoul} on one answer of a program whose ids are a typed union: reading an id the program
 * does not ask is a compile error, and an id it asks but did not answer reads `unasked`.
 */
export function readAskedNoul<Id extends string>(
	answers: Readonly<Partial<Record<Id, unknown>>>,
	id: Id,
	direction: NoulDirection,
	thresholds: NoulBandThresholds | YesNoFamily = DEFAULT_NOUL_BAND_THRESHOLDS,
): NoulReading {
	return readNoul(answers[id], direction, thresholds);
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

function decisiveAnswer(answer: unknown, expected: boolean, thresholds: NoulBandThresholds): boolean {
	if (!answer || typeof answer !== "object") return false;
	const record = answer as { band?: unknown; direction?: unknown; noul?: unknown };
	if (typeof record.band === "string") {
		if (record.band !== "hard_pass" && record.band !== "hard_fail") return false;
		const direction = record.direction === "required_false" ? "required_false" : "required_true";
		return settledFromBand(record.band, direction) === expected;
	}
	return (
		isNoulProbability(record.noul) &&
		noulBand(record.noul, expected ? "required_true" : "required_false", thresholds) === "hard_pass"
	);
}

/** True only when the answer decisively says the proposition itself is false. */
export function isDecisivelyFalse(
	answer: unknown,
	thresholds: NoulBandThresholds = DEFAULT_NOUL_BAND_THRESHOLDS,
): boolean {
	return decisiveAnswer(answer, false, thresholds);
}

/** True only when the answer decisively says the proposition itself is true. */
export function isDecisivelyTrue(
	answer: unknown,
	thresholds: NoulBandThresholds = DEFAULT_NOUL_BAND_THRESHOLDS,
): boolean {
	return decisiveAnswer(answer, true, thresholds);
}
