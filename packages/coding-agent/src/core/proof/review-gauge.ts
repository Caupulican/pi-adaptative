/**
 * Review gauge: how many finished results reached the owner since the owner last wrote, read from the session branch.
 *
 * Whether the owner actually read a result cannot be known honestly without new ceremony, so the gauge measures delivery
 * state: every delivery that carries a proof sheet (a goal completion, a worker result, a plan result) counts until an
 * owner-authored message follows it. The gauge informs only: it never holds, queues or refuses work. Past the owner's
 * setting it raises one notice that new work is piling up faster than it is reviewed.
 */

import type { SessionEntry } from "../../kernel/node.ts";
import type { HarnessNoticeKind, HarnessNoticeObservation } from "../harness-notice.ts";
import { ownerOriginKind, stampedHistoryStart } from "../turn-origin.ts";
import { type ProofSheetRecord, readProofSheetRecords } from "./proof-sheet.ts";

/** The proof sheets an entry carries, in delivery order: a host custom message's, or a host goal tool result's. */
export function entryProofSheets(entry: SessionEntry): ProofSheetRecord[] {
	if (entry.type === "custom_message") {
		return readProofSheetRecords(entry.details, { kind: "custom-message", customType: entry.customType });
	}
	if (entry.type !== "message") return [];
	if (entry.message.role === "custom") {
		return readProofSheetRecords(entry.message.details, {
			kind: "custom-message",
			customType: entry.message.customType,
		});
	}
	if (entry.message.role === "toolResult") {
		return readProofSheetRecords(entry.message.details, { kind: "tool-result", toolName: entry.message.toolName });
	}
	return [];
}

/** Proof sheets delivered after the owner's last own message, newest first. */
export function proofSheetsAwaitingReview(entries: readonly SessionEntry[]): ProofSheetRecord[] {
	const stampedStart = stampedHistoryStart(entries);
	const waiting: ProofSheetRecord[] = [];
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index] as SessionEntry;
		// The owner's own message ends the wait: typed at the terminal or sent from a verified owner channel (see `ownerOriginKind`).
		if (ownerOriginKind(entry, index, stampedStart) !== undefined) break;
		waiting.push(...entryProofSheets(entry).reverse());
	}
	return waiting;
}

/** The newest proof sheet on the branch, whatever the owner wrote since; the quiz reads it. */
export function latestProofSheet(entries: readonly SessionEntry[]): ProofSheetRecord | undefined {
	for (let index = entries.length - 1; index >= 0; index--) {
		const sheet = entryProofSheets(entries[index] as SessionEntry).at(-1);
		if (sheet) return sheet;
	}
	return undefined;
}

/** The status line, or undefined when nothing waits. */
export function reviewGaugeStatusLine(waiting: number): string | undefined {
	if (waiting <= 0) return undefined;
	return waiting === 1
		? "1 finished result arrived since your last message and is waiting for your review."
		: `${waiting} finished results arrived since your last message and are waiting for your review.`;
}

/** The notice observation for a count: one notice past the threshold, cleared once the count drops back under it. */
export function reviewGaugeNotice(waiting: number, noticeAt: number): HarnessNoticeObservation {
	if (noticeAt <= 0 || waiting < noticeAt) return "clear";
	return {
		reason: "review-backlog",
		text: `${waiting} finished results are waiting for your review: new work is piling up faster than it is reviewed. Consider tightening the checks or pausing new fan-out until you catch up; nothing was held.`,
	};
}

export interface ReviewGaugeObservationDeps {
	readonly observeHarnessNotice?: (
		kind: HarnessNoticeKind,
		read: () => HarnessNoticeObservation | undefined,
	) => unknown;
	readonly getBranch: () => readonly SessionEntry[];
	readonly getNoticeAt: () => number;
}

/** Observes the review gauge once (after a turn): one notice past the owner's threshold, cleared below it. */
export function observeReviewGauge(deps: ReviewGaugeObservationDeps): void {
	deps.observeHarnessNotice?.("review-backlog", () =>
		reviewGaugeNotice(proofSheetsAwaitingReview(deps.getBranch()).length, deps.getNoticeAt()),
	);
}
