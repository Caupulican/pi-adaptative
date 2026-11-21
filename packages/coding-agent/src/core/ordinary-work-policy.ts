/** Stop decisions for an ordinary owner request. Its original turn is free of the continuation budget. */
import type { StopReason } from "@caupulican/pi-ai";
import type { AgentMessage } from "../kernel/types.ts";
import { isNonNegativeSafeInteger, isPlainRecord } from "../kernel/utils/value-guards.ts";
import type { NoulReading } from "./decision/noul.ts";
import type { OrdinaryWorkRecord } from "./ordinary-work-store.ts";

export const ORDINARY_WORK_MAX_CONTINUATIONS = 3;
export const ORDINARY_WORK_EVIDENCE_CHARS = 12_000;

export const ORDINARY_ANSWER_RESERVATION = "answer_only_reserved";
export const ORDINARY_REPORTING_RESERVATION = "reporting_reply_reserved";
export const ORDINARY_WORK_CONTINUATION_TYPE = "ordinary-work-continuation";

type OrdinaryReportJudgment = "report_ready" | "report_review_needed";

export type OrdinaryWorkJudgment =
	| "fulfilled"
	| "actionable"
	| OrdinaryReportJudgment
	| "waiting"
	| "owner_needed"
	| "unverified";
export type OrdinaryWorkReviewGate =
	| Exclude<OrdinaryWorkJudgment, "actionable" | OrdinaryReportJudgment>
	| "review"
	| "limited";

export interface OrdinaryWorkStopHostFacts {
	readonly interrupted: boolean;
	readonly terminalStopReason: StopReason | "missing";
	readonly finalAnswerPresent: boolean;
	readonly foregroundCallsSettled: true;
	readonly foregroundReceipts: { readonly recorded: number; readonly included: number };
	readonly backgroundReports: { readonly recorded: number; readonly included: number };
	readonly pendingBackgroundWork: "not_checked";
}

export interface OrdinaryWorkStopEvidence {
	readonly reporting?: OrdinaryReportingRequirements;
	readonly latestOwnerRequest?: string;
	readonly isCurrentOwnerQuote?: (quote: string) => boolean;
	readonly request: string;
	readonly answer: string;
	readonly receipts: string;
	readonly hasCompleteReceipt: boolean;
	readonly hostFacts: OrdinaryWorkStopHostFacts;
	readonly receiptSources?: readonly {
		readonly callId: string;
		readonly receiptStart: number;
		readonly resultStart: number;
		readonly resultEnd: number;
	}[];
}

export interface OrdinaryWorkCorrection {
	readonly missing: string;
	readonly next: string;
	readonly responseMode?: "answer_only";
	readonly missingReportingIds?: readonly string[];
}

export type OrdinaryReportingVerdict =
	| "fulfilled"
	| "reporting_override_unverified"
	| "reporting_unverified"
	| "reviewer_invalid_response"
	| OrdinaryWorkCorrection;

export function settleOrdinaryReporting(
	substantive: OrdinaryWorkJudgment,
	presentation: OrdinaryReportingVerdict,
	count: number,
	restriction: NoulReading | undefined,
) {
	if (presentation === "fulfilled") return substantive === "fulfilled" ? "fulfilled" : "unverified";
	if (presentation === "reviewer_invalid_response") return "reporting_review_invalid";
	if (typeof presentation !== "object") return presentation;
	if (restriction === "hard_pass") return "reporting_override_unverified";
	if (!restriction || restriction === "unasked") return "reporting_unverified";
	return ordinaryWorkReviewGate("actionable", count) === "limited" ? "limited" : presentation;
}

export interface OrdinaryReportingRequirements {
	readonly requirements: readonly { readonly id: string; readonly text: string }[];
	readonly complete: boolean;
	isCurrent(): boolean;
}

export function ordinaryReportingChangedAtSettlement(
	intent: OrdinaryWorkRecord["status"] | typeof ORDINARY_REPORTING_RESERVATION,
	captured: OrdinaryReportingRequirements | undefined,
): boolean {
	return (
		(intent === "fulfilled" || intent === ORDINARY_REPORTING_RESERVATION) &&
		captured !== undefined &&
		!captured.isCurrent()
	);
}

export function ordinaryReportEligible(evidence: OrdinaryWorkStopEvidence): boolean {
	const facts = evidence.hostFacts;
	return (
		facts.interrupted &&
		!facts.finalAnswerPresent &&
		!evidence.answer.trim() &&
		facts.foregroundCallsSettled &&
		evidence.hasCompleteReceipt &&
		facts.foregroundReceipts.included > 0 &&
		facts.foregroundReceipts.included === facts.foregroundReceipts.recorded &&
		facts.backgroundReports.included === facts.backgroundReports.recorded
	);
}

export function requiresOrdinaryReportReview(judgment: OrdinaryWorkJudgment): judgment is OrdinaryReportJudgment {
	return judgment === "report_ready" || judgment === "report_review_needed";
}

export function ordinaryWorkReviewGate(judgment: OrdinaryWorkJudgment, continuations: number): OrdinaryWorkReviewGate {
	if (judgment !== "actionable" && !requiresOrdinaryReportReview(judgment)) return judgment;
	if (!Number.isSafeInteger(continuations) || continuations < 0 || continuations >= ORDINARY_WORK_MAX_CONTINUATIONS)
		return "limited";
	return "review";
}

export function ordinaryWorkContinuationRef(details: unknown) {
	if (!isPlainRecord(details)) return;
	const { sessionId, openingEntryId, generation, revision, responseMode, reportingRevision } = details;
	if (
		typeof sessionId !== "string" ||
		!sessionId ||
		typeof openingEntryId !== "string" ||
		!openingEntryId ||
		!isNonNegativeSafeInteger(generation) ||
		generation === 0 ||
		!isNonNegativeSafeInteger(revision) ||
		revision === 0 ||
		(responseMode !== undefined && responseMode !== "answer_only") ||
		(reportingRevision !== undefined && typeof reportingRevision !== "boolean") ||
		(reportingRevision === true && responseMode !== "answer_only")
	)
		return;
	return { sessionId, openingEntryId, generation, revision, responseMode, reportingRevision };
}

export function assertOrdinaryDispatch(
	message: AgentMessage | undefined,
	record: OrdinaryWorkRecord | undefined,
	reportingCurrent?: () => boolean,
): void {
	if (message?.role !== "custom" || message.customType !== ORDINARY_WORK_CONTINUATION_TYPE) return;
	const details = ordinaryWorkContinuationRef(message.details);
	const reporting = record?.reason === ORDINARY_REPORTING_RESERVATION;
	if (
		record?.status !== "active" ||
		!record.leaseId ||
		!details ||
		details.sessionId !== record.sessionId ||
		details.openingEntryId !== record.openingEntryId ||
		details.generation !== record.generation ||
		details.revision !== record.revision ||
		details.responseMode !==
			(reporting || record.reason === ORDINARY_ANSWER_RESERVATION ? "answer_only" : undefined) ||
		(details.reportingRevision === true) !== reporting ||
		(reporting && reportingCurrent?.() !== true)
	)
		throw new Error("The ordinary continuation no longer owns its reserved generation.");
}
