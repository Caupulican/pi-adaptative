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
	readonly capabilities?: {
		readonly images: boolean;
		readonly boxes: boolean;
		readonly visionModel?: string;
		readonly experimentalVision: boolean;
	};
}

/**
 * Where a paid response's usage is charged from. Absent is a System One review; `system_one_tool` is the root systemone tool's
 * review (counted in the session statistics); history and maintenance routes identify their actual summary responses.
 */
export type MaintenanceUsageRoute = "compaction" | "branch_summary";
export type SystemOneUsageRoute = "system_one_tool" | "history_summary" | MaintenanceUsageRoute;

export interface HistoryUsageCall {
	readonly reportId: string;
	readonly provider: string;
	readonly model: string;
	readonly attempt: number;
	readonly origin?: AccountingOrigin;
}

/** The priced usage record handed to the usage sink. `receiptId` is the persistence identity of one response. */
export interface TypeSafeUsageReceipt extends PricedTypeSafeUsage {
	/** Actual provider response time, preserved across deferred delivery. */
	readonly responseTimestamp?: string;
	readonly receiptId: string;
	readonly provider: string;
	readonly model: string;
	readonly attempt: number;
	readonly route?: SystemOneUsageRoute;
	readonly origin?: AccountingOrigin;
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

/**
 * Most provider responses one evaluation can receive: the first attempt plus the reviewer's provider retries
 * (`maxRetries` is this minus one). The usage sink reserves this many slots per evaluation.
 */
export const SYSTEM_ONE_RESPONSES_PER_EVALUATION = 3;

/**
 * What the usage sink did with one paid response. `physically_recorded` means the identical row is confirmed in
 * the session's ledger; `durably_pending` means the receipt is retained and that row is not confirmed yet; and
 * `unretained` means only the in-process receipt object exists. Only the first confirms the spend.
 */
export type SystemOneUsageOutcome =
	| { readonly kind: "physically_recorded" }
	| { readonly kind: "durably_pending"; readonly cause: string }
	| { readonly kind: "unretained"; readonly cause: string };

/** The usage slots of one evaluation: each paid response is recorded through it, and unused slots are released. */
export interface SystemOneUsageLease {
	/** Records one paid response. Never throws: a failure is an `unretained` outcome. */
	record(receipt: TypeSafeUsageReceipt): SystemOneUsageOutcome;
	/** Returns the slots no response used. Idempotent. */
	release(): void;
}

/** The session's usage sink: an evaluation begins a lease before any provider call is paid. */
export interface SystemOneUsageSink {
	/** Snapshot the initiating work before asynchronous preparation can change the live session. */
	captureOrigin?(): AccountingOrigin;
	/**
	 * Throws {@link SystemOneUsageRefusal} when no slot can be reserved; nothing has been paid at that point. The route says
	 * where the usage is charged from (see SystemOneUsageRoute); absent is a System One review.
	 */
	begin(route?: SystemOneUsageRoute, origin?: AccountingOrigin): SystemOneUsageLease;
}

/** The usage sink cannot admit a new paid evaluation, so none is made. */
export class SystemOneUsageRefusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SystemOneUsageRefusal";
	}
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
	/** The paid responses received before the observer failed: their receipts are still owed to the caller. */
	readonly receipts: readonly SystemOneReceipt[];

	constructor(message: string, cause: unknown, receipts: readonly SystemOneReceipt[] = []) {
		super(message, { cause });
		this.name = "SystemOneObserverError";
		this.receipts = receipts;
	}
}

/** The semantic-review capability the generic tool requires from any provider implementation. */
export interface SystemOneReviewPort {
	captureUsageOrigin?(): AccountingOrigin | undefined;
	status(signal?: AbortSignal): Promise<SystemOneStatus>;
	evaluate(
		input: EvaluationInput,
		signal?: AbortSignal,
		onResponse?: SystemOneReviewResponseObserver,
		origin?: AccountingOrigin,
	): Promise<SystemOneEvaluationRecord>;
	review(
		input: ReviewInput,
		signal?: AbortSignal,
		onResponse?: SystemOneReviewResponseObserver,
		origin?: AccountingOrigin,
	): Promise<SystemOneReviewRecord>;
}

import type { AccountingOrigin } from "../cost/accounting-evidence.ts";
