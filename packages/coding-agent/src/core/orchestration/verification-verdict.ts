/** The verifier's typed verdict and its one reason-code form, read and written in one place. */

/**
 * A verifier's decision on one subject: accepted, rejected with the reason codes it gave, or inconclusive with the
 * cause that kept it from judging.
 */
export type VerifierVerdict =
	| { kind: "accepted" }
	| { kind: "rejected"; reasonCodes: readonly string[] }
	| { kind: "inconclusive"; cause: string };

const ACCEPTED_CODE = "independent_verification_accepted";
const REJECTED_PREFIX = "independent_verification_rejected:";
const INCONCLUSIVE_PREFIX = "independent_verification_inconclusive:";
/** The reason list of a rejection that named none. Records from before the codec wrote an empty list instead. */
const UNSPECIFIED = "unspecified";

/** The durable reason code a verdict is recorded under. */
export function verdictReasonCode(verdict: VerifierVerdict): string {
	switch (verdict.kind) {
		case "accepted":
			return ACCEPTED_CODE;
		case "rejected":
			return `${REJECTED_PREFIX}${verdict.reasonCodes.join(",") || UNSPECIFIED}`;
		case "inconclusive":
			return `${INCONCLUSIVE_PREFIX}${verdict.cause}`;
	}
}

/** The verdict a durable reason code records; undefined for any code that is not a verdict code. */
export function verdictOfReasonCode(code: string): VerifierVerdict | undefined {
	if (code === ACCEPTED_CODE) return { kind: "accepted" };
	if (code.startsWith(REJECTED_PREFIX)) {
		const codes = code.slice(REJECTED_PREFIX.length);
		return { kind: "rejected", reasonCodes: codes === "" || codes === UNSPECIFIED ? [] : codes.split(",") };
	}
	// A cause may itself contain colons, so only the first prefix is removed.
	if (code.startsWith(INCONCLUSIVE_PREFIX))
		return { kind: "inconclusive", cause: code.slice(INCONCLUSIVE_PREFIX.length) };
	return undefined;
}

/**
 * The plain correction a refused reason-code list reads as, in both transports: a verifier's submit_report refuses the call with
 * it, and its text envelope fails the lane with it as the blocker.
 */
export const REASON_CODE_LIST_CORRECTION =
	"Each reason code must be a non-empty string without a comma, which separates codes in a verdict; send one reason code per entry.";

/** True for a verifier's reason-code list: every entry a non-empty string without a comma, which is the codec's separator. */
export function isVerdictReasonCodeList(value: unknown): value is readonly string[] {
	return (
		Array.isArray(value) &&
		value.every((code) => typeof code === "string" && code.trim().length > 0 && !code.includes(","))
	);
}
