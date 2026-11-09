/**
 * Kept admission verdicts of the transcript memory coordinator: the rule that turns one admission result into the
 * verdict a job keeps while its paid receipts are owed, the rule that turns a kept verdict back into its result once
 * those receipts are settled, and the identity of one owed receipt.
 */

import type { SystemOneReceipt } from "../review/system-one-review-port.ts";
import type {
	TranscriptAdmissionUnavailableCause,
	TranscriptSummaryAdmissionResult,
} from "./transcript-summary-admission.ts";
import type { TranscriptSummaryPendingVerdict } from "./transcript-summary-scheduler.ts";

/** The identity of one owed receipt: its owner session and report id. */
export function owedKey(entry: { ownerSessionId: string; receipt: SystemOneReceipt }): string {
	return `${entry.ownerSessionId}\u0000${entry.receipt.reportId}`;
}

export function countRecorded(receipts: readonly SystemOneReceipt[]): number {
	return receipts.filter((receipt) => receipt.status === "recorded").length;
}

/**
 * The verdict kept on a job when a paid response's usage receipt is owed. A judgment keeps its disposition; a result
 * that is not a judgment (an outage with partial paid responses, an answer that failed the evaluator contract) is kept
 * only so its receipts can be settled, as `invalid_output` with its real cause in the reason.
 */
export function verdictOf(
	result: TranscriptSummaryAdmissionResult,
	receipts: readonly SystemOneReceipt[],
	attempt: number,
	ownerSessionId: string,
	key: { inputDigest: string; textDigest: string; contractVersion: number },
): TranscriptSummaryPendingVerdict {
	const base = {
		...key,
		ownerSessionId,
		attempt,
		receipts: receipts.map((receipt) => ({ ...receipt })),
	};
	if (result.disposition === "unavailable") {
		return {
			...base,
			disposition: "invalid_output",
			reason: `${result.cause}: ${result.reason}`,
			judged: [],
			confidences: {},
			evaluator: result.evaluator ?? { engineId: "unknown", model: "unknown" },
		};
	}
	return {
		...base,
		disposition: result.disposition,
		...(result.disposition === "accepted" ? {} : { reason: result.reason }),
		judged: [...result.judged],
		confidences: { ...result.confidences },
		evaluator: { ...result.evaluator },
	};
}

const UNAVAILABLE_CAUSES: readonly TranscriptAdmissionUnavailableCause[] = [
	"not_bound",
	"not_calibrated",
	"input_too_large",
	"request_refused",
	"evaluator_error",
	"invalid_output",
];

/** The admission result a kept verdict stands for, once its receipts are settled. */
export function resultFromVerdict(
	verdict: TranscriptSummaryPendingVerdict,
	receipts: readonly SystemOneReceipt[],
): TranscriptSummaryAdmissionResult {
	const base = {
		contractVersion: verdict.contractVersion,
		judged: [...verdict.judged],
		confidences: { ...verdict.confidences },
		receipts,
		// A kept verdict stands for a response that was sent and paid; replaying it sends nothing (it is counted as reused).
		requestSent: true,
	};
	if (verdict.disposition === "accepted") {
		return { ...base, disposition: "accepted", evaluator: { ...verdict.evaluator } };
	}
	if (verdict.disposition === "rejected" || verdict.disposition === "uncertain") {
		return {
			...base,
			disposition: verdict.disposition,
			reason: verdict.reason ?? "the evaluator did not accept the summary",
			evaluator: { ...verdict.evaluator },
		};
	}
	const separator = (verdict.reason ?? "").indexOf(": ");
	const named = separator > 0 ? (verdict.reason ?? "").slice(0, separator) : "";
	const cause = UNAVAILABLE_CAUSES.find((candidate) => candidate === named) ?? "evaluator_error";
	return {
		...base,
		disposition: "unavailable",
		cause,
		reason: separator > 0 ? (verdict.reason ?? "").slice(separator + 2) : (verdict.reason ?? "no judgment"),
		evaluator: { ...verdict.evaluator },
	};
}
