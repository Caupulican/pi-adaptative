import type { EvaluationInput, EvaluationResponse, REVIEW_CONFIDENCE, ReviewInput } from "./typesafe-contract.ts";
import type { PricedTypeSafeUsage } from "./typesafe-usage.ts";

/** Provider-neutral receipt for one transport attempt that may contribute usage or diagnostics. */
export interface SystemOneTransportAttempt {
	attempt: number;
	status?: number;
	response?: unknown;
}

/** Which configured provider/model produced a response, without exposing credentials or driver details. */
export interface SystemOneReviewConnection {
	readonly provider: string;
	readonly model: string;
}

/** Called for each received response, including provider attempts that are later rejected or retried. */
export type SystemOneReviewResponseObserver = (
	attempts: readonly SystemOneTransportAttempt[],
	connection: SystemOneReviewConnection,
) => void;

export interface SystemOneStatus {
	readonly enabled: boolean;
	readonly model: string;
	readonly confidence: typeof REVIEW_CONFIDENCE;
	readonly setup: string;
	readonly authenticationVerified: boolean;
	readonly message: string;
}

/** The priced usage record handed to the usage sink. `receiptId` is the persistence identity of one response. */
export interface TypeSafeUsageReceipt extends PricedTypeSafeUsage {
	readonly receiptId: string;
	readonly provider: string;
	readonly model: string;
	readonly attempt: number;
}

/**
 * The persistence outcome of one paid provider response. `reportId` is identical on every persistence
 * retry, so readers dedupe the usage by it. `payload` is retained so the persistence stage can be retried
 * without a new provider call. `cause` is set only when `status` is `unrecorded`.
 */
export interface SystemOneReceipt {
	readonly status: "recorded" | "unrecorded";
	readonly reportId: string;
	readonly attempt: number;
	readonly cause?: string;
	readonly payload: TypeSafeUsageReceipt;
}

/** Shared evaluation record consumed by the System One tool and retained-evidence path. */
export interface SystemOneEvaluationRecord {
	readonly request: EvaluationInput & { model: string };
	readonly requestSha256: string;
	readonly response: EvaluationResponse;
	readonly attempts: number;
	readonly transportAttempts: SystemOneTransportAttempt[];
	readonly elapsedMs: number;
	/** One receipt per provider response that carried valid usage while a usage sink was supplied, retries included. */
	readonly receipts: readonly SystemOneReceipt[];
}

/** A claim review adds its confidence decision to the same lossless evaluation receipt. */
export interface SystemOneReviewRecord extends SystemOneEvaluationRecord {
	readonly threshold: number;
	readonly expected: Record<string, string>;
	readonly accepted: boolean;
	readonly failures: string[];
}

/** Provider-neutral failure retaining the request, every response received, and every paid receipt so far. */
export class SystemOneReviewError extends Error {
	readonly response: unknown;
	readonly requestSha256: string;
	readonly request: SystemOneEvaluationRecord["request"];
	readonly transportAttempts: SystemOneTransportAttempt[];
	readonly receipts: readonly SystemOneReceipt[];

	constructor(
		message: string,
		requestSha256: string,
		request: SystemOneEvaluationRecord["request"],
		response: unknown,
		transportAttempts: SystemOneTransportAttempt[],
		receipts: readonly SystemOneReceipt[],
	) {
		super(message);
		this.name = "SystemOneReviewError";
		this.response = response;
		this.requestSha256 = requestSha256;
		this.request = request;
		this.transportAttempts = transportAttempts;
		this.receipts = receipts;
	}
}

/**
 * A provider response that arrived but failed the System One contract (schema, coverage, probability, choice,
 * duplicate members). `response` is the sanitized raw body. The answer is never admission evidence and never reused.
 */
export class SystemOneInvalidResponseError extends SystemOneReviewError {
	constructor(
		message: string,
		requestSha256: string,
		request: SystemOneEvaluationRecord["request"],
		response: unknown,
		transportAttempts: SystemOneTransportAttempt[],
		receipts: readonly SystemOneReceipt[],
	) {
		super(message, requestSha256, request, response, transportAttempts, receipts);
		this.name = "SystemOneInvalidResponseError";
	}
}

/** The caller's response observer failed. Not a receipt or provider failure; surfaced as its own error. */
export class SystemOneObserverError extends Error {
	constructor(message: string, cause: unknown) {
		super(message, { cause });
		this.name = "SystemOneObserverError";
	}
}

/** The semantic-review capability the generic tool requires from any provider implementation. */
export interface SystemOneReviewPort {
	status(signal?: AbortSignal): Promise<SystemOneStatus>;
	evaluate(
		input: EvaluationInput,
		signal?: AbortSignal,
		onResponse?: SystemOneReviewResponseObserver,
	): Promise<SystemOneEvaluationRecord>;
	review(
		input: ReviewInput,
		signal?: AbortSignal,
		onResponse?: SystemOneReviewResponseObserver,
	): Promise<SystemOneReviewRecord>;
}
