import type { EvaluationInput, EvaluationResponse, REVIEW_CONFIDENCE, ReviewInput } from "./typesafe-contract.ts";

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

/** Shared evaluation record consumed by the System One tool and retained-evidence path. */
export interface SystemOneEvaluationRecord {
	readonly request: EvaluationInput & { model: string };
	readonly requestSha256: string;
	readonly response: EvaluationResponse;
	readonly attempts: number;
	readonly transportAttempts: SystemOneTransportAttempt[];
	readonly elapsedMs: number;
}

/** A claim review adds its confidence decision to the same lossless evaluation receipt. */
export interface SystemOneReviewRecord extends SystemOneEvaluationRecord {
	readonly threshold: number;
	readonly expected: Record<string, string>;
	readonly accepted: boolean;
	readonly failures: string[];
}

/** Provider-neutral failure retaining the request and every response received before transport failure. */
export class SystemOneReviewError extends Error {
	readonly response: unknown;
	readonly requestSha256: string;
	readonly request: SystemOneEvaluationRecord["request"];
	readonly transportAttempts: SystemOneTransportAttempt[];
	readonly failureKind: "transport" | "usage_recording";

	constructor(
		message: string,
		requestSha256: string,
		request: SystemOneEvaluationRecord["request"],
		response: unknown,
		transportAttempts: SystemOneTransportAttempt[],
		failureKind: "transport" | "usage_recording" = "transport",
	) {
		super(message);
		this.name = "SystemOneReviewError";
		this.response = response;
		this.requestSha256 = requestSha256;
		this.request = request;
		this.transportAttempts = transportAttempts;
		this.failureKind = failureKind;
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
