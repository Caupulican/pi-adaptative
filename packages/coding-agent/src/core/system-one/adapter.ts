import { SYSTEM_ONE_PINNED_MODEL } from "./catalog.ts";
import { DEFAULT_SYSTEM_ONE_CONFIG, type SystemOneConfig } from "./config.ts";
import { containsCredential } from "./projector.ts";
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

export interface JevAdapter {
	evaluate(input: JevEvaluationRequest, options?: JevAdapterEvaluateOptions): Promise<JevEvaluationResponse>;
}

export interface TypeSafeReviewerLike {
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

export interface SystemOneJevAdapterDeps {
	sleep?: (ms: number) => Promise<void>;
	getApiKey?: () => Promise<string | undefined> | string | undefined;
	getUserKeys?: () => Promise<readonly string[]> | readonly string[];
}

/**
 * SystemOneJevAdapter: TypeSafe System One client with pinned model enforcement and failure policy.
 * R-006: Pin Jev to jev-1.13.0 in production.
 * R-007: Log the concrete model version and reject unexpected model drift.
 * R-032: Secrets, tokens, credentials, private keys, and user keys MUST NOT be leaked.
 * R-066: If Jev is unavailable, repo mutation and high-impact actions MUST fail closed.
 * R-067: Rate-limit retries MUST use bounded backoff.
 */
export class SystemOneJevAdapter implements JevAdapter {
	private readonly reviewer: TypeSafeReviewerLike;
	private readonly config: SystemOneConfig;
	private readonly pinnedModel: string;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly deps: SystemOneJevAdapterDeps;

	constructor(
		reviewer: TypeSafeReviewerLike,
		config: SystemOneConfig = DEFAULT_SYSTEM_ONE_CONFIG,
		deps: SystemOneJevAdapterDeps = {},
	) {
		this.reviewer = reviewer;
		this.config = config;
		this.pinnedModel = config.model.production || SYSTEM_ONE_PINNED_MODEL;
		this.deps = deps;
		this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	async evaluate(input: JevEvaluationRequest, options?: JevAdapterEvaluateOptions): Promise<JevEvaluationResponse> {
		const targetModel = input.model ?? this.pinnedModel;
		const started = Date.now();
		const impact = options?.impact ?? "read_only";

		// 1. Mandatory user credential requirement: always require non-empty user API key (no bypass, no fallback)
		const getApiKey = this.deps.getApiKey ?? (() => process.env.TYPESAFE_API_KEY);
		const userKey = (await getApiKey())?.trim();
		if (!userKey) {
			throw new Error(
				"TypeSafe System One requires an API key configured by the user (use /login typesafe or TYPESAFE_API_KEY). No fallback or default credential is permitted.",
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

		while (attempts < maxAttempts) {
			options?.signal?.throwIfAborted();
			attempts++;

			try {
				const result = await this.reviewer.evaluate(
					{
						model: targetModel,
						state: input.state,
						questions: input.questions,
					},
					options?.signal,
				);

				const returnedModel = result.response.model;
				const latency_ms = result.elapsedMs ?? Date.now() - started;

				// R-007: Log the concrete model version returned and reject unexpected model drift
				if (this.config.model.pin_required && returnedModel !== targetModel) {
					throw new Error(
						`Model drift detected: requested pinned model '${targetModel}', but Jev endpoint returned '${returnedModel}' (R-007)`,
					);
				}

				return {
					model: returnedModel,
					answers: result.response.answers,
					usage: result.response.usage,
					latency_ms,
				};
			} catch (error) {
				lastError = error;
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

		// R-066: Failure policy handling
		// If read-only and configured to allow with audit:
		if (impact === "read_only" && this.config.failure_policy.jev_unavailable_read_only === "allow_with_audit") {
			return {
				model: targetModel,
				answers: {},
				latency_ms: Date.now() - started,
			};
		}

		// Otherwise fail closed (repo mutation or external side effect)
		throw new Error(
			`Jev System One unavailable for impact '${impact}': ${lastError instanceof Error ? lastError.message : String(lastError)} (R-066)`,
		);
	}
}
