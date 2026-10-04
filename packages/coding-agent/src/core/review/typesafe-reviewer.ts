import { createHash, randomUUID } from "node:crypto";
import { combineAbortSignals } from "@caupulican/pi-ai/abort-signals";
import { retryProviderRequest } from "@caupulican/pi-ai/provider-retry";
import { classifyFailure } from "../../kernel/reliability/index.ts";
import type { CredentialExposureBoundary } from "../secrets/credential-exposure-guard.ts";
import { redactCredentialContent } from "../secrets/credential-model-content.ts";
import type { SystemOneAccessResolver } from "../system-one/access.ts";
import { getSystemOneProviderDriver, type SystemOneProviderDriver } from "../system-one/provider-driver.ts";
import {
	type SystemOneEvaluationRecord,
	SystemOneReviewError,
	type SystemOneReviewRecord,
	type SystemOneReviewResponseObserver,
	type SystemOneTransportAttempt,
} from "./system-one-review-port.ts";
import {
	type EvaluationInput,
	getEvaluationUsage,
	REVIEW_CONFIDENCE,
	type ReviewInput,
	serializeEvaluation,
	TYPESAFE_API_CREDENTIAL,
	validateEvaluationResponse,
	validateTypeSafeInput,
} from "./typesafe-contract.ts";
import { type PricedTypeSafeUsage, priceTypeSafeUsage } from "./typesafe-usage.ts";

export type { ReviewInput } from "./typesafe-contract.ts";

const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

function redactReviewText(text: string, key: string | undefined): string {
	const redacted = key ? text.split(key).join("[REDACTED]") : text;
	return redacted.replace(new RegExp(TYPESAFE_API_CREDENTIAL.source, "g"), "[REDACTED]");
}

function preserveEvaluationKey(path: readonly (string | number)[], key: string): boolean {
	if (path.length === 0) return key === "model" || key === "state" || key === "questions";
	return path.length === 2 && path[0] === "questions" && ["type", "instructions", "criteria"].includes(key);
}

function preserveResponseKey(path: readonly (string | number)[], key: string): boolean {
	if (path.length === 0) return ["model", "answers", "usage"].includes(key);
	if (path[0] === "usage") return true;
	return (
		path.length === 2 &&
		path[0] === "answers" &&
		["type", "confidence", "choice", "score", "probabilities", "legend"].includes(key)
	);
}

/** Scan original JSON before any projection so duplicate provider members remain adverse evidence. */
function hasDuplicateJsonKeys(text: string): boolean {
	const objects: Set<string>[] = [];
	let duplicateKeys = false;
	text.replace(/"(?:[^"\\]|\\.)*"|[{}[\]]/g, (token: string, offset: number) => {
		if (token === "{" || token === "[") objects.push(new Set());
		else if (token === "}" || token === "]") objects.pop();
		else {
			let next = offset + token.length;
			while (/[ \t\r\n]/.test(text[next] ?? "")) next++;
			if (text[next] === ":") {
				const keys = objects.at(-1)!;
				const decodedKey = JSON.parse(token) as string;
				if (keys.has(decodedKey)) duplicateKeys = true;
				keys.add(decodedKey);
			}
		}
		return token;
	});
	return duplicateKeys;
}

/** Validate original grammar and duplicate keys before projecting decoded string values and keys. */
function decodeReviewResponse(
	text: string,
	key: string | undefined,
	redact: (text: string) => string,
): { raw: unknown; duplicateKeys: boolean } {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { raw: redact(redactReviewText(text, key)), duplicateKeys: false };
	}
	const duplicateKeys = hasDuplicateJsonKeys(text);
	if (duplicateKeys) {
		// Retain both conflicting members in a sanitized receipt rather than letting JSON.parse erase one.
		const projectedText = text.replace(/"(?:[^"\\]|\\.)*"/g, (token: string) => {
			const value = JSON.parse(token) as string;
			return JSON.stringify(redact(redactReviewText(value, key)));
		});
		return { raw: projectedText, duplicateKeys: true };
	}
	return {
		raw: redactCredentialContent(parsed, (value) => redact(redactReviewText(value, key)), preserveResponseKey),
		duplicateKeys: false,
	};
}

export interface TypeSafeUsageReceipt extends PricedTypeSafeUsage {
	readonly receiptId: string;
	readonly provider: string;
	readonly model: string;
	readonly attempt: number;
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
	/** One durable, provider-priced receipt for every response carrying valid usage, retries included. */
	onUsage?(receipt: TypeSafeUsageReceipt): void;
	/** The same host credential boundary that protects model requests and tool output. */
	credentialBoundary?: Pick<
		CredentialExposureBoundary,
		"redactSensitiveText" | "createSensitiveTextRedactor" | "getSensitiveValues"
	>;
}

/** One evaluation's connection: which provider, which model, which key (absent when not configured). */
interface ReviewerConnection {
	readonly driver: SystemOneProviderDriver;
	readonly model: string;
	readonly key: string | undefined;
	readonly setup: string;
}

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
		onResponse?: SystemOneReviewResponseObserver,
	): Promise<SystemOneReviewRecord> {
		signal?.throwIfAborted();
		const snapshot: ReviewInput = JSON.parse(serializeEvaluation(input));
		validateTypeSafeInput("review", snapshot);
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
		const safeQuestionIds = Object.keys(result.request.questions);
		const expected = Object.fromEntries(
			Object.entries(snapshot.questions).map(([id, question], index) => {
				const safeId = safeQuestionIds[index] ?? id;
				const criteriaKeys = Object.keys(question.criteria);
				const safeCriteriaKeys = Object.keys(result.request.questions[safeId]?.criteria ?? {});
				const expectedIndex = criteriaKeys.indexOf(question.expected);
				return [safeId, safeCriteriaKeys[expectedIndex] ?? question.expected];
			}),
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
		onResponse?: SystemOneReviewResponseObserver,
	): Promise<SystemOneEvaluationRecord> {
		signal?.throwIfAborted();
		// Snapshot before any await. No omitted fields or context truncation are permitted.
		const snapshot: EvaluationInput = JSON.parse(serializeEvaluation(input));
		validateTypeSafeInput("evaluation", snapshot);
		const { driver, model, key, setup } = await this.connection();
		signal?.throwIfAborted();
		const sensitiveValues = (await this.deps.credentialBoundary?.getSensitiveValues?.()) ?? [];
		signal?.throwIfAborted();
		const providerName = driver.displayName;
		const endpoint = this.deps.endpoint ?? driver.decisionsEndpoint;
		// One engine version for every path: a caller naming another version is refused, not rerouted.
		if (this.deps.access && snapshot.model !== undefined && !driver.matchesModel(model, snapshot.model))
			throw new Error(`System One runs ${model}; ${snapshot.model} was requested`);
		const request = this.deps.access ? { ...snapshot, model } : { model: snapshot.model ?? model, ...snapshot };
		const rawBody = JSON.stringify(request);
		const serializedKey = key ? JSON.stringify(key).slice(1, -1) : undefined;
		if (key && (rawBody.includes(key) || rawBody.includes(serializedKey!)))
			throw new Error(`${providerName} evidence contains the selected API credential`);
		const redactSensitive =
			this.deps.credentialBoundary?.createSensitiveTextRedactor?.(sensitiveValues) ??
			((text: string) => this.deps.credentialBoundary?.redactSensitiveText(text, sensitiveValues) ?? text);
		const redact = (text: string): string => {
			return redactReviewText(redactSensitive(text), key);
		};
		const safeRequest = redactCredentialContent(request, redact, preserveEvaluationKey);
		validateTypeSafeInput("evaluation", safeRequest);
		const body = JSON.stringify(safeRequest);
		if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
			throw new Error(
				`${providerName} request exceeds 2 MiB; partition with explicit coverage, never truncate evidence`,
			);
		if (!key) throw new Error(`${providerName} is not configured. Use ${setup}`);
		if (TYPESAFE_API_CREDENTIAL.test(body)) throw new Error(`${providerName} evidence contains an API credential`);
		const requestSha256 = createHash("sha256").update(body).digest("hex");
		const evaluationId = randomUUID();
		const timeout = new AbortController();
		const timer = setTimeout(() => timeout.abort(), 50_000);
		const combined = combineAbortSignals([signal, timeout.signal]);
		const started = Date.now();
		let attempts = 0;
		const transportAttempts: SystemOneTransportAttempt[] = [];
		let raw: unknown;
		try {
			raw = await retryProviderRequest(
				async () => {
					combined.signal?.throwIfAborted();
					attempts++;
					raw = undefined;
					const attempt: SystemOneTransportAttempt = { attempt: attempts };
					transportAttempts.push(attempt);
					let response: Response;
					try {
						response = await (this.deps.fetch ?? fetch)(endpoint, {
							method: "POST",
							headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
							body,
							redirect: "error",
							signal: combined.signal,
						});
					} catch (error) {
						const failure = classifyFailure({
							message: error instanceof Error ? error.message : String(error),
							aborted: combined.signal?.aborted,
							provider: driver.id,
						});
						if (!failure.retryable || failure.reason !== "network") throw error;
						// Native fetch errors lack SDK status/header fields. Normalize only classified
						// network failures into the existing provider retry owner; never replay a
						// malformed response, credential error, or local persistence failure.
						throw Object.assign(new Error(`${providerName} network error`, { cause: error }), {
							status: undefined,
							headers: undefined,
						});
					}
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
					const decoded = decodeReviewResponse(text, key, redact);
					raw = decoded.raw;
					attempt.response = raw;
					try {
						const reportedUsage = getEvaluationUsage(raw);
						if (reportedUsage) {
							const priced = priceTypeSafeUsage(driver.id, request.model, reportedUsage);
							this.deps.onUsage?.({
								...priced,
								receiptId: `${evaluationId}:${attempts}`,
								provider: driver.id,
								model: request.model,
								attempt: attempts,
							});
						}
						onResponse?.(transportAttempts, { provider: driver.id, model: request.model });
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
			validateEvaluationResponse(raw, safeRequest);
			this.verifiedKey = key;
			return {
				request: safeRequest,
				requestSha256,
				response: raw,
				attempts,
				transportAttempts,
				elapsedMs: Date.now() - started,
			};
		} catch (error) {
			// Keep arbitrary transport messages out; sanitize the accepted diagnostic with the request snapshot.
			const errorRegex =
				/^(Invalid (?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) response|(?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) HTTP|(?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) network error|(?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) response exceeds|(?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) usage recording failed|Empty (?:TypeSafe|OpenRouter|SystemOne|[A-Za-z0-9_-]+) response|Server requested)/;
			const message = combined.signal?.aborted
				? `${providerName} review cancelled or timed out`
				: error instanceof Error && errorRegex.test(error.message)
					? error.message
					: `${providerName} request failed`;
			throw new SystemOneReviewError(
				redact(message),
				requestSha256,
				safeRequest,
				raw,
				transportAttempts,
				error instanceof Error && error.message === `${providerName} usage recording failed`
					? "usage_recording"
					: "transport",
			);
		} finally {
			clearTimeout(timer);
			combined.cleanup();
		}
	}
}
