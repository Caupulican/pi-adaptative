import { abortableSleep } from "@caupulican/pi-ai/abort-signals";
import { classifyFailure } from "../../kernel/reliability/index.ts";
import {
	SystemOneInvalidResponseError,
	SystemOneObserverError,
	type SystemOneReceipt,
	SystemOneReviewError,
	SystemOneUsageRefusal,
} from "../review/system-one-review-port.ts";
import { TypeSafeEvidenceError, TypeSafeInputError } from "../review/typesafe-contract.ts";
import type { SystemOneAccessResolver } from "./access.ts";
import { SYSTEM_ONE_PINNED_MODEL } from "./catalog.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig } from "./config.ts";
import { containsCredential } from "./projector.ts";
import { getSystemOneProviderDriver, type SystemOneProviderDriver } from "./provider-driver.ts";
import type { ToolImpact } from "./types.ts";

export interface JevEvaluationRequest {
	state: unknown;
	questions: Record<string, unknown>;
	model?: string;
}

export interface JevEvaluationResponse {
	model: string;
	answers: Record<string, unknown>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
	};
	latency_ms: number;
	/** Persistence outcome of each paid provider response behind this answer. Absent when the reviewer persists nothing. */
	receipts?: readonly SystemOneReceipt[];
}

export interface JevAdapterEvaluateOptions {
	signal?: AbortSignal;
	impact?: ToolImpact;
	timeoutMs?: number;
}

import type { ConfidenceProvenance } from "../decision/confidence.ts";

export interface JevAdapter {
	readonly provenance?: ConfidenceProvenance;
	evaluate(input: JevEvaluationRequest, options?: JevAdapterEvaluateOptions): Promise<JevEvaluationResponse>;
}

export interface SystemOneReviewerLike {
	evaluate(
		input: { model?: string; state: unknown; questions: Record<string, unknown> },
		signal?: AbortSignal,
	): Promise<{
		request: { model: string };
		response: {
			model: string;
			answers: Record<string, unknown>;
			usage?: { input_tokens?: number; output_tokens?: number };
		};
		elapsedMs: number;
		/** Absent for a reviewer that persists no usage; the real reviewer always supplies it. */
		receipts?: readonly SystemOneReceipt[];
	}>;
}

export type JevFailureKind =
	| "invalid_request"
	| "invalid_response"
	| "unavailable"
	| "rate_limit"
	| "timeout"
	| "cancelled"
	| "model_drift";

/**
 * A refusal raised before any request could be sent (no key configured, a model that is not the one System One runs).
 * It stays a plain `Error` for every caller; callers that account for sent requests read `preSend`.
 */
export class SystemOnePreSendError extends Error {
	readonly preSend = true;
	constructor(message: string) {
		super(message);
		this.name = "SystemOnePreSendError";
	}
}

export class JevAdapterFailure extends Error {
	readonly kind: JevFailureKind;
	readonly originalMessage: string;
	/** Paid provider responses the failure carries, so a caller can settle their receipts. Empty when none were paid. */
	readonly receipts: readonly SystemOneReceipt[];

	constructor(
		kind: JevFailureKind,
		originalMessage: string,
		impact: string,
		cause?: unknown,
		receipts?: readonly SystemOneReceipt[],
	) {
		super(`Jev System One ${kind} for impact '${impact}': ${originalMessage}`, { cause });
		this.name = "JevAdapterFailure";
		this.kind = kind;
		this.originalMessage = originalMessage;
		// A failure raised after a paid response was received (drift, an incomplete answer) carries that response's receipts.
		this.receipts =
			receipts ??
			(cause instanceof SystemOneReviewError || cause instanceof SystemOneObserverError ? cause.receipts : []);
	}
}

/**
 * Typed contract failures first (no text matching). The text fallback reads transport and provider text only;
 * a response that failed validation is always a typed `invalid_response`, never an outage.
 */
export function classifyJevFailure(error: unknown, aborted: boolean): JevFailureKind {
	if (aborted) return "cancelled";
	if (error instanceof TypeSafeEvidenceError || error instanceof TypeSafeInputError) return "invalid_request";
	if (error instanceof SystemOneInvalidResponseError) return "invalid_response";
	if (error instanceof SystemOneReviewError) {
		const status = error.transportAttempts.at(-1)?.status;
		if (status === 400 || status === 422) return "invalid_request";
		if (status === 429) return "rate_limit";
		if (status !== undefined && status >= 400) return "unavailable";
	}
	const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	if (/AbortError|aborted/i.test(text)) return "cancelled";
	if (/timeout|ETIMEDOUT/i.test(text)) return "timeout";
	if (/\bHTTP\s+(?:400|422)\b/i.test(text)) return "invalid_request";
	if (/\b429\b|rate limit/i.test(text)) return "rate_limit";
	if (/\b401\b|\b403\b|\b503\b|ECONNREFUSED|unavailable|ENOTFOUND/i.test(text)) return "unavailable";
	return "unavailable";
}

export interface SystemOneJevAdapterDeps {
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** The session's System One access, resolved per evaluation: provider, pinned model and key. */
	access?: SystemOneAccessResolver;
	/** A fixed connection's key, when no access resolver is given. */
	getApiKey?: () => Promise<string | undefined> | string | undefined;
	getUserKeys?: () => Promise<readonly string[]> | readonly string[];
	driver?: SystemOneProviderDriver;
}

/**
 * SystemOneJevAdapter: System One client with pinned model enforcement and failure policy.
 * R-006: Pin Jev to jev-1.13.0 in production.
 * R-007: Log the concrete model version and reject unexpected model drift.
 * R-032: Secrets, tokens, credentials, private keys, and user keys MUST NOT be leaked.
 * R-066: The adapter never invents an answer when Jev is unavailable: it throws, and the consumer applies the
 * authority line (authority-line.ts). Objective transitions hold, delivery and edge classes stay with the
 * operator through the deterministic gates, and the shell gate's advisory judgment lets the call run with the
 * doubt shown, because code already decided every edge class before System One was asked.
 * R-067: Rate-limit retries MUST use bounded backoff.
 */
export class SystemOneJevAdapter implements JevAdapter {
	readonly provenance: ConfidenceProvenance = "native_calibrated";
	private readonly reviewer: SystemOneReviewerLike;
	private readonly config: SystemOneConfig;
	private readonly pinnedModel: string;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	private readonly deps: SystemOneJevAdapterDeps;
	private readonly driver: SystemOneProviderDriver;

	constructor(
		reviewer: SystemOneReviewerLike,
		config: SystemOneConfig = DEFAULT_SYSTEM_ONE_CONFIG,
		deps: SystemOneJevAdapterDeps = {},
	) {
		this.reviewer = reviewer;
		this.config = config;
		this.pinnedModel = config.model.production || SYSTEM_ONE_PINNED_MODEL;
		this.deps = deps;
		this.driver = deps.driver ?? getSystemOneProviderDriver(config.provider);
		this.sleep = deps.sleep ?? abortableSleep;
	}

	async evaluate(input: JevEvaluationRequest, options?: JevAdapterEvaluateOptions): Promise<JevEvaluationResponse> {
		const started = Date.now();
		const impact = options?.impact ?? "read_only";

		// 1. Mandatory user credential requirement: always require non-empty user API key (no bypass, no fallback)
		let driver = this.driver;
		let targetModel = input.model ?? this.pinnedModel;
		let userKey: string | undefined;
		let credentialHint = driver.formatSetupHelp();
		if (this.deps.access) {
			const outcome = await this.deps.access.resolve();
			if (outcome.kind === "ready") {
				({ driver } = outcome.access);
				userKey = outcome.access.apiKey;
				// The access decides the version; the caller's id is only accepted when it names the same one.
				if (input.model !== undefined && !driver.matchesModel(outcome.access.model, input.model))
					throw new SystemOnePreSendError(`System One runs ${outcome.access.model}; ${input.model} was requested`);
				targetModel = outcome.access.model;
			} else credentialHint = outcome.setup;
		} else userKey = (await this.deps.getApiKey?.())?.trim();
		if (!userKey) {
			throw new SystemOnePreSendError(
				`${driver.displayName} System One requires an API key configured by the user (${credentialHint}). No fallback or default credential is permitted.`,
			);
		}

		// 2. Secret leak prevention: assert no raw user keys or credentials are in the outgoing payload (R-032)
		const userKeys: string[] = [];
		if (userKey) userKeys.push(userKey);
		if (this.deps.getUserKeys) {
			const extra = await this.deps.getUserKeys();
			for (const k of extra) {
				const trimmed = k?.trim();
				if (trimmed) userKeys.push(trimmed);
			}
		}

		const serializedPayload = JSON.stringify({ state: input.state, questions: input.questions });
		for (const key of userKeys) {
			if (
				key.length >= 6 &&
				(serializedPayload.includes(key) || serializedPayload.includes(JSON.stringify(key).slice(1, -1)))
			) {
				// A refusal of this exact input (nothing was sent): typed, so no caller reads it as an outage to retry.
				throw new JevAdapterFailure(
					"invalid_request",
					"TypeSafe System One detected user API key in review payload; outgoing request blocked to prevent credential leakage (R-032)",
					impact,
				);
			}
		}
		if (containsCredential(serializedPayload, userKeys)) {
			// A refusal of this exact input (nothing was sent): typed, so no caller reads it as an outage to retry.
			throw new JevAdapterFailure(
				"invalid_request",
				"TypeSafe System One detected sensitive credential in review payload; outgoing request blocked to prevent credential leakage (R-032)",
				impact,
			);
		}

		let attempts = 0;
		const maxAttempts = 3;
		let lastError: unknown;
		// Every paid response any attempt received: a failure that ends the evaluation still owes their receipts.
		let owedReceipts: readonly SystemOneReceipt[] = [];
		// One deadline bounds the whole evaluation, retries and backoff included.
		const timeoutMs = options?.timeoutMs;
		const deadline = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
		const signal =
			deadline && options?.signal ? AbortSignal.any([options.signal, deadline]) : (deadline ?? options?.signal);
		// A timeout that follows a paid response still owes that response's receipts.
		const timedOut = () =>
			new JevAdapterFailure(
				"timeout",
				`System One evaluation exceeded its ${timeoutMs} ms budget`,
				impact,
				undefined,
				owedReceipts.length > 0 ? owedReceipts : undefined,
			);

		// A caller abort after a paid response keeps that response's receipts: the abort error alone would drop them.
		const abortedWithReceipts = (error: unknown) =>
			owedReceipts.length > 0
				? new JevAdapterFailure(
						"cancelled",
						error instanceof Error ? error.message : String(error),
						impact,
						error,
						owedReceipts,
					)
				: error;

		while (attempts < maxAttempts) {
			if (deadline?.aborted && !options?.signal?.aborted) throw timedOut();
			try {
				options?.signal?.throwIfAborted();
			} catch (aborted) {
				throw abortedWithReceipts(aborted);
			}
			attempts++;

			try {
				const result = await this.reviewer.evaluate(
					{
						model: targetModel,
						state: input.state,
						questions: input.questions,
					},
					signal,
				);

				const returnedModel = result.response.model;
				const latency_ms = result.elapsedMs ?? Date.now() - started;

				// R-007: Log the concrete model version returned and reject unexpected model drift
				const modelsMatch = driver.matchesModel(targetModel, returnedModel);
				if (this.config.model.pin_required && !modelsMatch) {
					throw new JevAdapterFailure(
						"model_drift",
						`Model drift detected: requested pinned model '${targetModel}', but Jev endpoint returned '${returnedModel}' (R-007)`,
						impact,
						undefined,
						result.receipts ?? [],
					);
				}

				const questionIds = Object.keys(input.questions ?? {});
				const answers = result.response.answers;
				if (questionIds.length > 0) {
					const missing = questionIds.filter((id) => answers?.[id] === undefined);
					if (missing.length > 0) {
						throw new JevAdapterFailure(
							"invalid_response",
							`Incomplete Jev answers: missing '${missing[0]}'`,
							impact,
							undefined,
							result.receipts ?? [],
						);
					}
				}

				return {
					model: returnedModel,
					answers,
					usage: result.response.usage,
					latency_ms,
					receipts: result.receipts ?? [],
				};
			} catch (error) {
				lastError = error;
				// A usage lease refused before payment is not an outage: nothing was sent, so it is neither classified nor retried.
				if (error instanceof SystemOneUsageRefusal) throw new SystemOnePreSendError(error.message);
				if (error instanceof SystemOneReviewError || error instanceof SystemOneObserverError) {
					owedReceipts = [...owedReceipts, ...error.receipts];
				}
				if (error instanceof JevAdapterFailure) {
					throw error;
				}
				if (deadline?.aborted && !options?.signal?.aborted) throw timedOut();
				if (options?.signal?.aborted) throw abortedWithReceipts(error);
				// The reviewer already exhausted its provider retry budget. Never multiply it here.
				if (
					error instanceof SystemOneReviewError ||
					error instanceof TypeSafeEvidenceError ||
					error instanceof TypeSafeInputError
				) {
					throw new JevAdapterFailure(
						classifyJevFailure(error, false),
						error.message,
						impact,
						error,
						// The earlier attempts' paid receipts (collected above, this error's included) stay with the failure.
						owedReceipts.length > 0 ? owedReceipts : undefined,
					);
				}
				const classified = classifyFailure({ message: error instanceof Error ? error.message : String(error) });
				if (!classified.retryable) break;

				// R-067: Bounded backoff for transient or rate limit errors
				if (attempts < maxAttempts) {
					const backoffMs = Math.min(1000 * 2 ** (attempts - 1) + Math.random() * 200, 5000);
					try {
						await this.sleep(backoffMs, signal);
					} catch (sleepError) {
						// The deadline ending the backoff is the evaluation's timeout, with the receipts it owes.
						if (deadline?.aborted && !options?.signal?.aborted) throw timedOut();
						throw options?.signal?.aborted ? abortedWithReceipts(sleepError) : sleepError;
					}
				}
			}
		}

		const original = lastError instanceof Error ? lastError.message : String(lastError);
		const kind = classifyJevFailure(lastError, Boolean(options?.signal?.aborted));
		// Never turn an invalid/incomplete typed response into empty successful answers.
		// Advisory callers catch JevAdapterFailure and continue without a fake evaluation.
		throw new JevAdapterFailure(
			kind,
			original,
			impact,
			lastError,
			owedReceipts.length > 0 ? owedReceipts : undefined,
		);
	}
}
