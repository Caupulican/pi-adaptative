import { createHash } from "node:crypto";
import { combineAbortSignals } from "@caupulican/pi-ai/abort-signals";
import { retryProviderRequest } from "@caupulican/pi-ai/provider-retry";
import { Value } from "typebox/value";
import {
	type EvaluationInput,
	type EvaluationResponse,
	evaluationInputSchema,
	REVIEW_CONFIDENCE,
	type ReviewInput,
	reviewInputSchema,
	serializeEvaluation,
	TYPESAFE_ENDPOINT,
	TYPESAFE_MODEL,
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

/** Separate judge port: does not generate code, choose tools, or authorize side effects. */
export class TypeSafeReviewer {
	private readonly deps: { getApiKey(): Promise<string | undefined>; fetch?: typeof fetch };
	constructor(deps: { getApiKey(): Promise<string | undefined>; fetch?: typeof fetch }) {
		this.deps = deps;
	}
	private async resolveKey(): Promise<string | undefined> {
		let key: string | undefined;
		try {
			key = (await this.deps.getApiKey())?.trim();
		} catch {
			throw new Error("TypeSafe credential lookup failed; check /login typesafe");
		}
		if (key && !/^[\x21-\x7e]+$/.test(key)) throw new Error("Invalid TypeSafe credential");
		return key || undefined;
	}

	async status() {
		const key = await this.resolveKey();
		return {
			enabled: Boolean(key?.trim()),
			model: TYPESAFE_MODEL,
			confidence: REVIEW_CONFIDENCE,
			setup: "/login typesafe or TYPESAFE_API_KEY",
			authenticationVerified: false,
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
		if (!Value.Check(evaluationInputSchema, snapshot)) throw new Error("Invalid TypeSafe evaluation input");
		const request = { model: TYPESAFE_MODEL, ...snapshot };
		const body = JSON.stringify(request);
		if (Buffer.byteLength(body) > MAX_REQUEST_BYTES)
			throw new Error("TypeSafe request exceeds 2 MiB; partition with explicit coverage, never truncate evidence");
		const key = await this.resolveKey();
		signal?.throwIfAborted();
		if (!key) throw new Error("TypeSafe is not configured. Use /login typesafe or TYPESAFE_API_KEY");
		if (body.includes(JSON.stringify(key).slice(1, -1)) || API_CREDENTIAL.test(body))
			throw new Error("TypeSafe evidence contains an API credential");
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
					const response = await (this.deps.fetch ?? fetch)(TYPESAFE_ENDPOINT, {
						method: "POST",
						headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
						body,
						redirect: "error",
						signal: combined.signal,
					});
					attempt.status = response.status;
					if (!response.body) throw new Error("Empty TypeSafe response");
					const reader = response.body.getReader();
					const chunks: Uint8Array[] = [];
					let bytes = 0;
					try {
						for (;;) {
							const { done, value } = await reader.read();
							if (done) break;
							bytes += value.byteLength;
							if (bytes > MAX_RESPONSE_BYTES) throw new Error("TypeSafe response exceeds 256 KiB");
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
						throw new Error("TypeSafe usage recording failed");
					}
					if (decoded.duplicateKeys) throw new Error("Invalid TypeSafe response: duplicate JSON member");
					if (!response.ok) {
						const error = Object.assign(new Error(`TypeSafe HTTP ${response.status}`), {
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
			const message = combined.signal?.aborted
				? "TypeSafe review cancelled or timed out"
				: error instanceof Error &&
						/^(Invalid TypeSafe response|TypeSafe HTTP|TypeSafe response exceeds|TypeSafe usage recording failed|Empty TypeSafe response|Server requested)/.test(
							error.message,
						)
					? error.message
					: "TypeSafe request failed";
			throw new TypeSafeReviewError(redactReviewText(message, key), requestSha256, request, raw, transportAttempts);
		} finally {
			clearTimeout(timer);
			combined.cleanup();
		}
	}
}
