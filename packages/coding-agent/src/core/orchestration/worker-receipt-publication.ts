import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { readWireRecord } from "../../kernel/wire-record.ts";
import { selectedTaskAttempt } from "./attempt-ordering.ts";
import type { ClaimReceipts } from "./claim-receipts.ts";
import { MAX_ORCHESTRATION_IDENTIFIER_LENGTH } from "./contracts.ts";
import { type AttemptRuntimeState, DurableTaskRuntimeError, type TaskRuntimeProjection } from "./task-runtime-state.ts";
import { attemptVerification } from "./verification-identity.ts";
import { type WorkerReceiptOrigin, workerReceiptOriginFromValue } from "./worker-receipt-origin.ts";
import { captureWorkerReceiptFacts } from "./worker-result-receipts.ts";

export interface WorkerReceiptAcknowledgement {
	readonly receiptId: string;
	readonly resultId: string;
	readonly factsDigest: string;
	readonly parentEntryId: string;
	readonly parentReviewEntryId?: string;
	readonly verifierAttemptId?: string;
}

export interface WorkerReceiptPublication {
	readonly version: 2;
	readonly receiptId: string;
	readonly attemptId: string;
	readonly taskId: string;
	readonly resultId: string;
	readonly origin: WorkerReceiptOrigin;
	readonly factsDigest: string;
	readonly receipts: ClaimReceipts;
	readonly parentReviewEntryId?: string;
	readonly verifierAttemptId?: string;
}

export interface WorkerReceiptCandidate {
	readonly publication: WorkerReceiptPublication;
	readonly parentReviewRequired: boolean;
}

export interface WorkerReceiptReview {
	readonly attemptId: string;
	readonly resultId: string;
	readonly factsDigest: string;
}

const ACK_KEYS = new Set([
	"receiptId",
	"resultId",
	"factsDigest",
	"parentEntryId",
	"parentReviewEntryId",
	"verifierAttemptId",
]);
const PUBLICATION_KEYS = new Set([
	"version",
	"receiptId",
	"attemptId",
	"taskId",
	"resultId",
	"origin",
	"factsDigest",
	"receipts",
	"parentReviewEntryId",
	"verifierAttemptId",
]);
const REVIEW_KEYS = new Set(["attemptId", "resultId", "factsDigest"]);

function identifier(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_ORCHESTRATION_IDENTIFIER_LENGTH &&
		!value.includes("\0")
	);
}

function receiptId(origin: WorkerReceiptOrigin, attemptId: string, resultId: string): string {
	return createHash("sha256")
		.update(JSON.stringify([origin.sessionId, origin.sessionFile ?? null, origin.leafId, attemptId, resultId]))
		.digest("hex");
}

export function decodeWorkerReceiptReview(value: unknown): WorkerReceiptReview | undefined {
	const record = readWireRecord(value, REVIEW_KEYS);
	return record &&
		identifier(record.attemptId) &&
		identifier(record.resultId) &&
		typeof record.factsDigest === "string" &&
		/^[a-f0-9]{64}$/.test(record.factsDigest)
		? { attemptId: record.attemptId, resultId: record.resultId, factsDigest: record.factsDigest }
		: undefined;
}

export function decodeWorkerReceiptAcknowledgement(value: unknown): WorkerReceiptAcknowledgement | undefined {
	const record = readWireRecord(value, ACK_KEYS);
	if (
		!record ||
		!identifier(record.receiptId) ||
		!identifier(record.resultId) ||
		!identifier(record.parentEntryId) ||
		typeof record.factsDigest !== "string" ||
		!/^[a-f0-9]{64}$/.test(record.factsDigest) ||
		(record.parentReviewEntryId !== undefined && !identifier(record.parentReviewEntryId)) ||
		(record.verifierAttemptId !== undefined && !identifier(record.verifierAttemptId))
	)
		return undefined;
	return {
		receiptId: record.receiptId,
		resultId: record.resultId,
		factsDigest: record.factsDigest,
		parentEntryId: record.parentEntryId,
		...(record.parentReviewEntryId === undefined ? {} : { parentReviewEntryId: record.parentReviewEntryId }),
		...(record.verifierAttemptId === undefined ? {} : { verifierAttemptId: record.verifierAttemptId }),
	};
}

/** Only this resolver authorizes publication; a generic reviewed stamp never supplies acceptance. */
export function workerReceiptCandidate(
	state: Pick<TaskRuntimeProjection, "tasks" | "attempts">,
	attempt: AttemptRuntimeState,
): WorkerReceiptCandidate | undefined {
	const result = attempt.result;
	const evidence = result?.receipts;
	const origin = attempt.dispatch.receiptOrigin;
	if (!result || !origin || evidence?.status !== "captured" || evidence.acceptance.disposition === "rejected")
		return undefined;
	if (attempt.status !== "completed" && attempt.status !== "partial") return undefined;
	if (result.status !== attempt.status || result.attemptId !== attempt.attemptId || result.taskId !== attempt.taskId)
		return undefined;
	const required = evidence.acceptance.verificationRequired;
	if (required !== (result.nextAction === "independent_verification_required")) return undefined;
	const reviewRequired = evidence.acceptance.disposition === "parent_review";
	if (result.status !== (required || reviewRequired ? "partial" : "completed")) return undefined;
	const verification = required ? attemptVerification(state, attempt) : undefined;
	if (required && verification?.verdict !== "accepted") return undefined;
	return {
		parentReviewRequired: reviewRequired,
		publication: {
			version: 2,
			receiptId: receiptId(origin, attempt.attemptId, result.resultId),
			attemptId: attempt.attemptId,
			taskId: attempt.taskId,
			resultId: result.resultId,
			origin,
			factsDigest: evidence.factsDigest,
			receipts: evidence.facts,
			...(verification ? { verifierAttemptId: verification.verifierAttemptId } : {}),
		},
	};
}

export function workerReceiptPublicationAllowed(
	state: Pick<TaskRuntimeProjection, "tasks" | "attempts">,
	attempt: AttemptRuntimeState,
): boolean {
	const current = selectedTaskAttempt(state, attempt.taskId)?.attemptId === attempt.attemptId;
	const status = state.tasks[attempt.taskId]?.task.status;
	return !current || (status !== "cancelled" && status !== "failed");
}

export function assertWorkerReceiptAcknowledgement(
	state: Pick<TaskRuntimeProjection, "tasks" | "attempts">,
	attempt: AttemptRuntimeState,
	acknowledgement: WorkerReceiptAcknowledgement,
): void {
	const candidate = workerReceiptCandidate(state, attempt);
	if (
		!candidate ||
		acknowledgement.receiptId !== candidate.publication.receiptId ||
		acknowledgement.resultId !== candidate.publication.resultId ||
		acknowledgement.factsDigest !== candidate.publication.factsDigest ||
		acknowledgement.verifierAttemptId !== candidate.publication.verifierAttemptId ||
		(candidate.parentReviewRequired
			? acknowledgement.parentReviewEntryId === undefined
			: acknowledgement.parentReviewEntryId !== undefined)
	) {
		throw new DurableTaskRuntimeError("Worker receipt acknowledgement does not match its accepted result.");
	}
	if (attempt.receiptAcknowledgement && !isDeepStrictEqual(attempt.receiptAcknowledgement, acknowledgement))
		throw new DurableTaskRuntimeError("Worker receipt acknowledgement conflicts with its prior publication.");
}

export function decodeWorkerReceiptPublication(value: unknown): WorkerReceiptPublication | undefined {
	const record = readWireRecord(value, PUBLICATION_KEYS);
	if (
		record?.version !== 2 ||
		!identifier(record.attemptId) ||
		!identifier(record.taskId) ||
		!identifier(record.resultId) ||
		(record.parentReviewEntryId !== undefined && !identifier(record.parentReviewEntryId)) ||
		(record.verifierAttemptId !== undefined && !identifier(record.verifierAttemptId))
	)
		return undefined;
	let origin: WorkerReceiptOrigin;
	try {
		origin = workerReceiptOriginFromValue(record.origin);
	} catch {
		return undefined;
	}
	const captured = captureWorkerReceiptFacts(record.receipts);
	if (
		captured.status !== "captured" ||
		captured.factsDigest !== record.factsDigest ||
		receiptId(origin, record.attemptId, record.resultId) !== record.receiptId
	)
		return undefined;
	return {
		version: 2,
		receiptId: record.receiptId as string,
		attemptId: record.attemptId,
		taskId: record.taskId,
		resultId: record.resultId,
		origin,
		receipts: captured.facts,
		factsDigest: captured.factsDigest,
		...(record.parentReviewEntryId === undefined ? {} : { parentReviewEntryId: record.parentReviewEntryId }),
		...(record.verifierAttemptId === undefined ? {} : { verifierAttemptId: record.verifierAttemptId }),
	};
}
