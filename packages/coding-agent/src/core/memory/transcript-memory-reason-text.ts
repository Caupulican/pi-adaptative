/**
 * Reason text of the transcript memory coordinator: the wait explanations for model summaries that are not approved
 * yet, the fixed causes that pause work, and the bounded renderings of store, index, admission and recovery results
 * that diagnostics and job holds quote.
 */

import type { TranscriptReadmissionWait } from "./transcript-memory-status.ts";
import type { TranscriptSummaryAdmissionResult } from "./transcript-summary-admission.ts";
import type {
	TranscriptSummaryJobsSaveResult,
	TranscriptSummaryRecoveryIssue,
	TranscriptSummaryStoreState,
} from "./transcript-summary-store.ts";

/** The reply text for each wait code: what an operator or a reader of the summary can act on. */
export const READMISSION_WAIT_TEXT: Record<TranscriptReadmissionWait, string> = {
	not_yet_judged: "re-admission has not judged it yet",
	judged_rejected: "re-admission judged this summary rejected; it is being revoked and rebuilt from its sources",
	judged_uncertain: "re-admission judged this summary uncertain; it is being revoked and rebuilt from its sources",
	evaluator_unavailable: "the evaluator did not answer; the re-admission job retries on its own backoff",
	child_not_approved: "a child summary is not approved yet",
	source_coverage_changed: "its sources changed since it was built",
	source_unreadable: "a source could not be re-read for judgment; the re-admission job retries on its own backoff",
	source_read_refused: "a source part cannot be read within the read bound, so it cannot be re-read for judgment",
	judgment_discarded: "a source, child or policy fence changed while it was judged",
	store_refused: "the store refused its admission record",
	store_unavailable: "the store could not record its judgment; re-admission retries later",
	admission_mismatch: "its text no longer matches the admission it carries",
	readmission_failed:
		"its re-admission failed and its attempt budget is spent; it is not judged again for this text and contract",
};
export const MAX_HELD_REASON_CHARS = 200;
/** A hold's cause is cut to this on its own, so it always fits inside {@link MAX_HELD_REASON_CHARS} ({@link holdReason}). */
const MAX_HELD_CAUSE_CHARS = 150;
export const COORDINATOR_NOT_RUNNING = "the summary coordinator is not running";

export const RECONCILIATION_WAITING =
	"a recovered summary job waits until its session is read again, so the budget it had under capture version 1 is adopted first";
export const CLAIM_SUPERSEDED_BEFORE_DISPATCH =
	"the job's spending authority changed after its claim (a merged budget, a floor or a transition); the claim was returned before dispatch";
export const CLAIM_SUPERSEDED_BEFORE_SUMMARY =
	"the job's spending authority changed during source preparation; the claim was returned before the summarizer call";
export const CLAIM_SUPERSEDED_BEFORE_ADMISSION =
	"the job's spending authority changed before the admission call; the claim made no paid call and was returned";
export const CLAIM_SUPERSEDED_AFTER_SUMMARY =
	"the job's spending authority changed after its summarizer call; that attempt stays spent and its reply is kept";

/**
 * Why the permanent forget state blocks all summary work: an unknown state (damaged, rolled back or missing where it
 * must exist) can never mean "nothing was forgotten", so it fails closed with its cause. Undefined when it is known.
 */
export function forgetStateBlock(state: TranscriptSummaryStoreState): string | undefined {
	const forgotten = state.forgotten;
	if (forgotten.status === "ok") return undefined;
	return `the permanent forget state is ${forgotten.status} (${forgotten.reason}); summaries and background work stay off until it is repaired, and exact history recall is unaffected`;
}

/** The real cause of a receipt write that failed, within the 1 to 200 characters a persisted receipt may carry. */
export function receiptCause(error: unknown): string {
	const message = (error instanceof Error ? error.message : String(error)).trim();
	return bounded(message.length > 0 ? message : "the usage write failed", 200);
}

/** The real cause of a job save that did not succeed. */
export function describeSaveRefusal(saved: Exclude<TranscriptSummaryJobsSaveResult, { status: "saved" }>): string {
	switch (saved.status) {
		case "unavailable":
			return saved.reason;
		case "jobs_overflow":
			return `job list overflow (${saved.active} active)`;
		case "fenced":
			return `fenced (the writer was superseded; current fence ${saved.currentFence})`;
		case "manifest_corrupt":
			return `manifest_corrupt: ${saved.detail}`;
	}
}

export function describeIssue(issue: TranscriptSummaryRecoveryIssue): string {
	switch (issue.kind) {
		case "manifest_corrupt":
			return `manifest corrupt: ${issue.detail}`;
		case "owed_receipts_corrupt":
			return `owed usage receipts file damaged: ${issue.detail}`;
		case "node_missing":
			return `node ${issue.nodeId.slice(0, 16)} missing`;
		case "node_corrupt":
			return `node ${issue.nodeId.slice(0, 16)} corrupt: ${issue.detail}`;
		case "node_mismatch":
			return `node ${issue.nodeId.slice(0, 16)} inconsistent: ${issue.detail}`;
		case "child_missing":
			return `node ${issue.nodeId.slice(0, 16)} lost child ${issue.childId.slice(0, 16)}`;
		case "frontier_dangling":
			return `frontier ${issue.frontier} references missing node ${issue.nodeId.slice(0, 16)}`;
		case "dormant_damaged":
			return `dormant node ${issue.nodeId.slice(0, 16)} unreadable (purged): ${issue.detail}`;
		case "jobs_corrupt":
			return `jobs file damaged: ${issue.detail}`;
		case "anchors_corrupt":
			return `retention anchors damaged: ${issue.detail}`;
		case "forgotten_unknown":
			return `permanent forget state unknown: ${issue.detail}`;
		case "spent_corrupt":
			return `terminal-proof ledger damaged: ${issue.detail}`;
		case "terminals_corrupt":
			return `terminal record file damaged: ${issue.detail}`;
	}
}

export function bounded(text: string, max: number): string {
	return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** `text` cut to `max` characters in its middle, so its head (what failed) and its tail (where an error code sits) both survive. */
function boundedMiddle(text: string, max: number): string {
	if (text.length <= max) return text;
	const head = Math.floor((max - 1) / 3);
	return `${text.slice(0, head)}…${text.slice(text.length - (max - 1 - head))}`;
}

/**
 * A hold's reason: its cause first, cut on its own to {@link MAX_HELD_CAUSE_CHARS} around its middle, then what the
 * job waits for. The status bound ({@link MAX_HELD_REASON_CHARS}) then cuts only the explanation, never the cause, so
 * its identifying code (a reader's `read_error:<code>` near its end, a failed save's errno near its start) is shown.
 */
export function holdReason(cause: string, waits: string): string {
	return `${boundedMiddle(cause, MAX_HELD_CAUSE_CHARS)}; ${waits}`;
}

/** The real cause of a judgment that did not admit, in one bounded line: the disposition, why, who judged and the confidences. */
export function describeAdmission(
	result: Exclude<TranscriptSummaryAdmissionResult, { disposition: "accepted" }>,
): string {
	const confidences = Object.entries(result.confidences)
		.map(([id, value]) => `${id}=${value.toFixed(2)}`)
		.join(", ");
	const judge = result.evaluator ? ` by ${result.evaluator.engineId} (${result.evaluator.model})` : "";
	const cause = result.disposition === "unavailable" ? ` [${result.cause}]` : "";
	return `summary admission ${result.disposition}${cause}${judge}: ${result.reason}${confidences ? ` (P(holds): ${confidences})` : ""}`;
}
