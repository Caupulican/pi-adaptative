import { createHash } from "node:crypto";
import { combineAbortSignals } from "@caupulican/pi-ai/abort-signals";
import { retryProviderRequest } from "@caupulican/pi-ai/provider-retry";
import { Value } from "typebox/value";
import type { SystemOneAccessResolver } from "../system-one/access.ts";
import { getSystemOneProviderDriver, type SystemOneProviderDriver } from "../system-one/provider-driver.ts";
import {
	type EvaluationInput,
	type EvaluationResponse,
	evaluationInputSchema,
	REVIEW_CONFIDENCE,
	type ReviewInput,
	reviewInputSchema,
	serializeEvaluation,
	validateEvaluationResponse,
} from "./typesafe-contract.ts";

export type { ReviewInput } from "./typesafe-contract.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;
const API_CREDENTIAL = /apikey_[A-Za-z0-9_-]+/;

function redactReviewText(text: string, key: string): string {
	return text
		.split(JSON.stringify(key).slice(1, -1))
		.join("[REDACTED]")
		.split(key)
		.join("[REDACTED]")
		.replace(/apikey_[A-Za-z0-9_-]+/g, "[REDACTED]");
}

/** Validate grammar with the native parser, then preserve/reject ambiguous object members. */
function decodeReviewResponse(text: string, key: string): { raw: unknown; duplicateKeys: boolean } {
	try {
		JSON.parse(text);
	} catch {
		return { raw: redactReviewText(text, key), duplicateKeys: false };
	}
	const objects: Set<string>[] = [];
	let duplicateKeys = false;
	// Strings are single tokens, so braces, escaped quotes and colons inside values cannot
	// change the nesting. Native JSON.parse above already checked the complete grammar.
	const normalized = text.replace(/"(?:[^"\\]|\\.)*"|[{}[\]]/g, (token: string, offset: number) => {
		if (token === "{" || token === "[") objects.push(new Set());
		else if (token === "}" || token === "]") objects.pop();
		else {
			const value = redactReviewText(JSON.parse(token), key);
			let next = offset + token.length;
			while (/[ \t\r\n]/.test(text[next] ?? "")) next++;
			if (text[next] === ":") {
				const keys = objects.at(-1)!;
				if (keys.has(value)) duplicateKeys = true;
				keys.add(value);
			}
			return JSON.stringify(value);
		}
		return token;
	});
	// Keep both conflicting values in the redacted error record; do not lose one via JSON.parse.
	return { raw: duplicateKeys ? normalized : JSON.parse(normalized), duplicateKeys };
}

export interface TypeSafeTransportAttempt {
	attempt: number;
	status?: number;
	response?: unknown;
}

export interface EvaluationRecord {
	request: EvaluationInput & { model: string };
	requestSha256: string;
	response: EvaluationResponse;
	attempts: number;
	transportAttempts: TypeSafeTransportAttempt[];
	elapsedMs: number;
}

export interface ReviewRecord extends EvaluationRecord {
	threshold: number;
	expected: Record<string, string>;
	accepted: boolean;
	failures: string[];
}

export class TypeSafeReviewError extends Error {
	readonly response: unknown;
	readonly requestSha256: string;
	readonly request: EvaluationRecord["request"];
	readonly transportAttempts: TypeSafeTransportAttempt[];
	constructor(
		message: string,
		requestSha256: string,
		request: EvaluationRecord["request"],
		response: unknown,
		transportAttempts: TypeSafeTransportAttempt[],
	) {
		super(message);
		this.name = "TypeSafeReviewError";
		this.requestSha256 = requestSha256;
		this.request = request;
		this.response = response;
		this.transportAttempts = transportAttempts;
	}
}

export interface SystemOneReviewerDeps {
	/**
	 * The session's System One access: provider, pinned model and key, resolved at every call so a
	 * provider switch applies to the next evaluation. Production reviewers take this; the fixed fields
	 * below describe one pinned connection (tests, a single-provider tool).
	 */
	access?: SystemOneAccessResolver;
	getApiKey?(): Promise<string | undefined>;
	fetch?: typeof fetch;
	provider?: string;
	driver?: SystemOneProviderDriver;
	model?: string;
	endpoint?: string;
	modelsEndpoint?: string;
}

/** One evaluation's connection: which provider, which model, which key (absent when not configured). */
interface ReviewerConnection {
	readonly driver: SystemOneProviderDriver;
	readonly model: string;
	readonly key: string | undefined;
	readonly setup: string;
}

export type TypeSafeReviewerDeps = SystemOneReviewerDeps;

/** Separate judge port: does not generate code, choose tools, or authorize side effects. */
export class SystemOneReviewer {
	private readonly deps: SystemOneReviewerDeps;
	private readonly driver: SystemOneProviderDriver;
	private verifiedKey?: string;

	constructor(deps: SystemOneReviewerDeps) {
		this.deps = deps;
		this.driver = deps.driver ?? getSystemOneProviderDriver(deps.provider);
		if (!deps.access && !deps.getApiKey) throw new Error("A System One reviewer needs an access resolver or a key");
	}

	private async connection(): Promise<ReviewerConnection> {
		let driver = this.driver;
		let model = this.deps.model ?? this.driver.model;
		let key: string | undefined;
		let setup = this.driver.formatSetupHelp();
		try {
			if (this.deps.access) {
				const outcome = await this.deps.access.resolve();
				if (outcome.kind === "ready") {
					({ driver, model } = outcome.access);
					key = outcome.access.apiKey;
					setup = driver.formatSetupHelp();
				} else setup = outcome.setup;
			} else key = (await this.deps.getApiKey?.())?.trim();
		} catch {
			throw new Error(`${driver.displayName} credential lookup failed; check ${setup}`);
		}
		if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error(`Invalid ${driver.displayName} credential`);
		return { driver, model, key: key || undefined, setup };
	}

	async status(signal?: AbortSignal) {
		const { driver, model, key, setup } = await this.connection();
		const providerName = driver.displayName;
		const enabled = Boolean(key?.trim());
		if (!enabled || !key) {
			return {
				enabled: false,
				model,
				confidence: REVIEW_CONFIDENCE,
				setup,
				authenticationVerified: false,
				message: `${providerName} is not configured. Use ${setup}.`,
			};
		}
		if (this.verifiedKey !== key) {
			const timeout = new AbortController();
			const timer = setTimeout(() => timeout.abort(), 10_000);
			const combined = combineAbortSignals([signal, timeout.signal]);
			try {
				const response = await (this.deps.fetch ?? fetch)(this.deps.modelsEndpoint ?? driver.modelsEndpoint, {
					method: "GET",
					headers: { Authorization: `Bearer ${key}` },
					redirect: "error",
					signal: combined.signal,
				});
				if (response.ok) {
					this.verifiedKey = key;
				} else if (response.status === 401 || response.status === 403) {
					this.verifiedKey = undefined;
					return {
						enabled: true,
						model,
						confidence: REVIEW_CONFIDENCE,
						setup,
						authenticationVerified: false,
						message: `${providerName} authentication failed. Check ${setup}.`,
					};
				}
			} catch {
				return {
					enabled: true,
					model,
					confidence: REVIEW_CONFIDENCE,
					setup,
					authenticationVerified: false,
					message: `${providerName} endpoint unreachable.`,
				};
			} finally {
				clearTimeout(timer);
				combined.cleanup();
			}
		}
		const authenticationVerified = this.verifiedKey === key;
		return {
			enabled: true,
			model,
			confidence: REVIEW_CONFIDENCE,
			setup,
			authenticationVerified,
			message: authenticationVerified
				? `${providerName} authenticated and verified.`
				: `${providerName} key configured but verification failed.`,
		};
	}

	async review(
		input: ReviewInput,
		signal?: AbortSignal,
		onResponse?: (attempts: readonly TypeSafeTransportAttempt[]) => void,
	): Promise<ReviewRecord> {
		signal?.throwIfAborted();
		const snapshot: ReviewInput = JSON.parse(serializeEvaluation(input));
		if (!Value.Check(reviewInputSchema, snapshot)) throw new Error("Invalid TypeSafe review input");
		for (const question of Object.values(snapshot.questions)) {
			if (!Object.hasOwn(question.criteria, question.expected))
				throw new Error("Expected verdict must be a declared option");
		}
		const result = await this.evaluate(
			{
				state: snapshot.state,
				questions: Object.fromEntries(
					Object.entries(snapshot.questions).map(([id, question]) => [
						id,
						{ type: "choice", instructions: question.instructions, criteria: question.criteria },
					]),
				),
			},
			signal,
			onResponse,
		);
		const threshold = REVIEW_CONFIDENCE[snapshot.confidence ?? "high"];
		const expected = Object.fromEntries(
			Object.entries(snapshot.questions).map(([id, question]) => [id, question.expected]),
		);
		const failures = Object.entries(result.response.answers)
			.filter(
				([id, answer]) =>
					answer.type !== "choice" || answer.choice !== expected[id] || answer.confidence < threshold,
			)
			.map(([id]) => id);
		return { ...result, threshold, expected, accepted: failures.length === 0, failures };
	}

	async evaluate(
		input: EvaluationInput,
		signal?: AbortSignal,
		onResponse?: (attempts: readonly TypeSafeTransportAttempt[]) => void,
	): Promise<EvaluationRecord> {
		signal?.throwIfAborted();
		// Snapshot before any await. No omitted fields or context truncation are permitted.
		const snapshot: EvaluationInput = JSON.parse(serializeEvaluation(input));
		const { driver, model, key, setup } = await this.connection();
		signal?.throwIfAborted();
		const providerName = driver.displayName;
		const endpoint = this.deps.endpoint ?? driver.decisionsEndpoint;
		if (!Value.Check(evaluationInputSchema, snapshot)) throw new Error(`Invalid ${providerName} evaluation input`);
		// One engine version for every path: a caller naming another version is refused, not rerouted.
		if (this.deps.access && snapshot.model !== undefined && !driver.matchesModel(model, snapshot.model))
			throw new Error(`System One runs ${model}; ${snapshot.model} was requested`);
		const request = this.deps.access ? { ...snapshot, model } : { model: snapshot.model ?? model, ...snapshot };
		const body = JSON.stringify(request);
		if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
			throw new Error(
				`${providerName} request exceeds 2 MiB; partition with explicit coverage, never truncate evidence`,
			);
		if (!key) throw new Error(`${providerName} is not configured. Use ${setup}`);
		if (body.includes(JSON.stringify(key).slice(1, -1)) || API_CREDENTIAL.test(body))
			throw new Error(`${providerName} evidence contains an API credential`);
		const requestSha256 = createHash("sha256").update(body).digest("hex");
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), 50_000);
		const combined = combineAbortSignals([signal, timeout.signal]);
		const started = Date.now();
		let attempts = 0;
		const transportAttempts: TypeSafeTransportAttempt[] = [];
		let raw: unknown;
		try {
			raw = await retryProviderRequest(
				async () => {
					combined.signal?.throwIfAborted();
					attempts++;
					raw = undefined;
					const attempt: TypeSafeTransportAttempt = { attempt: attempts };
					transportAttempts.push(attempt);
					const response = await (this.deps.fetch ?? fetch)(endpoint, {
						method: "POST",
						headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
						body,
						redirect: "error",
						signal: combined.signal,
					});
					attempt.status = response.status;
					if (!response.body) throw new Error(`Empty ${providerName} response`);
					const reader = response.body.getReader();
					const chunks: Uint8Array[] = [];
					let bytes = 0;
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							bytes += value.byteLength;
							if (bytes > MAX_RESPONSE_BYTES) throw new Error(`${providerName} response exceeds 256 KiB`);
							chunks.push(value);
						}
					} finally {
						await reader.cancel().catch(() => {});
						reader.releaseLock();
					}
					const text = Buffer.concat(chunks).toString("utf8");
					const decoded = decodeReviewResponse(text, key);
					raw = decoded.raw;
					attempt.response = raw;
					try {
						onResponse?.(transportAttempts);
					} catch {
						// A local persistence failure must never inherit provider retry metadata.
						throw new Error(`${providerName} usage recording failed`);
					}
					if (decoded.duplicateKeys) throw new Error(`Invalid ${providerName} response: duplicate JSON member`);
					if (!response.ok) {
						if (response.status === 401 || response.status === 403) {
							this.verifiedKey = undefined;
						}
						const error = Object.assign(new Error(`${providerName} HTTP ${response.status}`), {
							status: response.status,
							headers: response.headers,
						});
						throw error;
					}
					return raw;
				},
				{ maxRetries: 2, maxRetryDelayMs: 15_000, signal: combined.signal },
			);
			combined.signal?.throwIfAborted();
			validateEvaluationResponse(raw, snapshot);
			this.verifiedKey = key;
			return {
				request,
				requestSha256,
				response: raw,
				attempts,
				transportAttempts,
				elapsedMs: Date.now() - started,
			};
		} catch (error) {
			// Never project arbitrary transport messages: they can contain the Authorization header.
			const errorRegex =
				/^(Invalid (?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) response|(?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) HTTP|(?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) response exceeds|(?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) usage recording failed|Empty (?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) response|Server requested)/;
			const message = combined.signal?.aborted
				? `${providerName} review cancelled or timed out`
				: error instanceof Error && errorRegex.test(error.message)
					? error.message
					: `${providerName} request failed`;
			throw new TypeSafeReviewError(redactReviewText(message, key), requestSha256, request, raw, transportAttempts);
		} finally {
			clearTimeout(timer);
			combined.cleanup();
		}
	}
}

export const TypeSafeReviewer = SystemOneReviewer;
export type TypeSafeReviewer = SystemOneReviewer;
export type SystemOneReviewError = TypeSafeReviewError;
