/**
 * Where a System One answer decides: the owner's rule for any acceptance is P >= 0.90 (a yes) or P <= 0.10 (a no), and an
 * evidence-sufficiency answer must reach 0.90 before the judgment it covers counts. No yes/no family carries these cuts,
 * and nothing here has been measured on its own answers, so they stay the rule's own values. A looser threshold needs a
 * written reason at its use; a probability is never rounded up to reach one.
 */

export const ACCEPT_AT = 0.9;
export const ACCEPT_ABSENCE_AT = 0.1;

/** The probability a Noul answer carries, or undefined when the answer has none or it is not within [0, 1]. */
export function noulProbability(answer: unknown): number | undefined {
	const noul = (answer as { noul?: unknown } | undefined)?.noul;
	return typeof noul === "number" && Number.isFinite(noul) && noul >= 0 && noul <= 1 ? noul : undefined;
}
