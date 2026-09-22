import { TypeSafeEvidenceError } from "../review/typesafe-contract.ts";
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
	}>;
}

export type TypeSafeReviewerLike = SystemOneReviewerLike;

export type JevFailureKind =
	| "invalid_request"
	| "invalid_response"
	| "unavailable"
	| "rate_limit"
	| "timeout"
	| "cancelled"
	| "model_drift";

export class JevAdapterFailure extends Error {
	readonly kind: JevFailureKind;
	readonly originalMessage: string;

	constructor(kind: JevFailureKind, originalMessage: string, impact: string) {
		super(`Jev System One ${kind} for impact '${impact}': ${originalMessage}`);
		this.name = "JevAdapterFailure";
		this.kind = kind;
		this.originalMessage = originalMessage;
	}
}

export function classifyJevFailure(error: unknown, aborted: boolean): JevFailureKind {
	if (aborted) return "cancelled";
	if (error instanceof TypeSafeEvidenceError) return "invalid_request";
	const text = error instanceof Error ? `${error.name} ${error.message}` : String(error);
	if (/Model drift detected/i.test(text)) return "model_drift";
	if (/AbortError|aborted/i.test(text)) return "cancelled";
	if (/timeout|ETIMEDOUT/i.test(text)) return "timeout";
	if (/\b429\b|rate limit/i.test(text)) return "rate_limit";
	if (/\b401\b|\b403\b|\b503\b|ECONNREFUSED|unavailable|ENOTFOUND/i.test(text)) return "unavailable";
	if (/Missing answer|Invalid noul|Invalid choice|question coverage|incomplete/i.test(text)) return "invalid_response";
	return "unavailable";
}

export interface SystemOneJevAdapterDeps {
	sleep?: (ms: number) => Promise<void>;
	getApiKey?: () => Promise<string | undefined> | string | undefined;
	getUserKeys?: () => Promise<readonly string[]> | readonly string[];
	driver?: SystemOneProviderDriver;
}

/**
 * SystemOneJevAdapter: System One client with pinned model enforcement and failure policy.
 * R-006: Pin Jev to jev-1.13.0 in production.
 * R-007: Log the concrete model version and reject unexpected model drift.
 * R-032: Secrets, tokens, credentials, private keys, and user keys MUST NOT be leaked.
 * R-066: If Jev is unavailable, repo mutation and high-impact actions MUST fail closed.
 * R-067: Rate-limit retries MUST use bounded backoff.
 */
export class SystemOneJevAdapter implements JevAdapter {
	readonly provenance: ConfidenceProvenance = "native_calibrated";
	private readonly reviewer: SystemOneReviewerLike;
	private readonly config: SystemOneConfig;
	private readonly pinnedModel: string;
	private readonly sleep: (ms: number) => Promise<void>;
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
		this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async evaluate(input: JevEvaluationRequest, options?: JevAdapterEvaluateOptions): Promise<JevEvaluationResponse> {
		const targetModel = input.model ?? this.pinnedModel;
		const started = Date.now();
		const impact = options?.impact ?? "read_only";

		// 1. Mandatory user credential requirement: always require non-empty user API key (no bypass, no fallback)
		const getApiKey = this.deps.getApiKey ?? (() => this.driver.getApiKey());
		const userKey = (await getApiKey())?.trim();
		if (!userKey) {
			const credentialHint = this.driver.formatSetupHelp();
			throw new Error(
				`${this.driver.displayName} System One requires an API key configured by the user (${credentialHint}). No fallback or default credential is permitted.`,
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
				throw new Error(
					"TypeSafe System One detected user API key in review payload; outgoing request blocked to prevent credential leakage (R-032)",
				);
			}
		}
		if (containsCredential(serializedPayload, userKeys)) {
			throw new Error(
				"TypeSafe System One detected sensitive credential in review payload; outgoing request blocked to prevent credential leakage (R-032)",
			);
		}

		let attempts = 0;
		const maxAttempts = 3;
		let lastError: unknown;
		// One deadline bounds the whole evaluation, retries and backoff included.
		const timeoutMs = options?.timeoutMs;
		const deadline = timeoutMs !== undefined ? AbortSignal.timeout(timeoutMs) : undefined;
		const signal =
			deadline && options?.signal ? AbortSignal.any([options.signal, deadline]) : (deadline ?? options?.signal);
		const timedOut = () =>
			new JevAdapterFailure("timeout", `Jev evaluation exceeded its ${timeoutMs} ms budget`, impact);

		while (attempts < maxAttempts) {
			if (deadline?.aborted && !options?.signal?.aborted) throw timedOut();
			options?.signal?.throwIfAborted();
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
				const modelsMatch = this.driver.matchesModel(targetModel, returnedModel);
				if (this.config.model.pin_required && !modelsMatch) {
					throw new Error(
						`Model drift detected: requested pinned model '${targetModel}', but Jev endpoint returned '${returnedModel}' (R-007)`,
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
						);
					}
				}

				return {
					model: returnedModel,
					answers,
					usage: result.response.usage,
					latency_ms,
				};
			} catch (error) {
				lastError = error;
				if (error instanceof JevAdapterFailure) {
					throw error;
				}
				// The request we built is not JSON: retrying sends the same defect again.
				if (error instanceof TypeSafeEvidenceError) {
					throw new JevAdapterFailure("invalid_request", error.message, impact);
				}
				if (deadline?.aborted && !options?.signal?.aborted) throw timedOut();
				// If model drift was detected, do not retry
				if (error instanceof Error && error.message.includes("Model drift detected")) {
					throw error;
				}

				// Check if aborted
				if (options?.signal?.aborted) {
					throw error;
				}

				// R-067: Bounded backoff for transient or rate limit errors
				if (attempts < maxAttempts) {
					const backoffMs = Math.min(1000 * 2 ** (attempts - 1) + Math.random() * 200, 5000);
					await this.sleep(backoffMs);
				}
			}
		}

		const original = lastError instanceof Error ? lastError.message : String(lastError);
		const kind = classifyJevFailure(lastError, Boolean(options?.signal?.aborted));
		// Never turn an invalid/incomplete typed response into empty successful answers.
		// Advisory callers catch JevAdapterFailure and continue without a fake evaluation.
		throw new JevAdapterFailure(kind, original, impact);
	}
}
