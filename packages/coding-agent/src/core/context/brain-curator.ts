import { runBoundedCompletion } from "../autonomy/bounded-completion.ts";

/**
 * Brain-assisted context curation (see docs/model-router-rework/brain-context-curation-design.md):
 * a SIDECAR curator that consumes reports the context pipeline already produces and feeds back
 * small, typed advisories. It is never a pipeline stage: every consumer must behave byte-for-byte
 * identically when a result is absent (missing digest -> today's stub; missing relevance ->
 * today's enforcement decision). The curator itself is provider-free — the completion executor is
 * injected per drain, so it works against any registered local model and faux providers in tests.
 *
 * Memory bounds are explicit: the queue and result map are both capped, and drops are counted in
 * telemetry rather than silent. Results are keyed for idempotency (digests by the GC record's
 * content hash, relevance by the audit item id), so re-enqueueing the same work is free.
 */

export const CURATION_DIGEST_SYSTEM_PROMPT = [
	"You digest tool-output chunks for a coding agent's context curator. You never solve the task.",
	"Given a chunk, respond with STRICT JSON only - no prose:",
	'{"digest":"<one or two sentences, max 200 characters, keeping exact identifiers>"}',
	"Keep exact file paths, symbol names, error codes, and version strings verbatim.",
].join("\n");

export const CURATION_RELEVANCE_SYSTEM_PROMPT = [
	"You judge whether a stale tool output is still relevant to the user's current goal.",
	"You never solve the task. Respond with STRICT JSON only - no prose:",
	'{"relevant":true|false,"confidence":<0..1>}',
	"relevant=false means the chunk is about something the current goal no longer needs.",
	"When uncertain, answer relevant=true with low confidence - keeping content is the safe default.",
].join("\n");

export const CURATION_COMPACTION_DIGEST_SYSTEM_PROMPT = [
	"You pre-digest a chunk of an agent conversation for compaction. You never continue the conversation.",
	"Extract ONLY durable facts: decisions made, file paths and symbols touched, errors and their causes,",
	"user requirements, and outcomes. Respond with STRICT JSON only - no prose:",
	'{"digest":"<bullet-style summary, max 700 characters, exact identifiers verbatim>"}',
].join("\n");

export function parseCompactionChunkDigest(text: string): string | undefined {
	const parsed = extractJsonObject(text);
	if (!parsed) return undefined;
	const digest = (parsed as { digest?: unknown }).digest;
	if (typeof digest !== "string") return undefined;
	const trimmed = digest.trim();
	if (trimmed.length === 0 || trimmed.length > 800) return undefined;
	return trimmed;
}

export interface PreDigestResult {
	text: string;
	totalChunks: number;
	digested: number;
	failed: number;
}

const PRE_DIGEST_CHUNK_CHARS = 24_000;
const PRE_DIGEST_KEEP_RECENT_CHARS = 16_000;
const PRE_DIGEST_CHUNK_WALL_CLOCK_MS = 25_000;

/**
 * Compaction pre-digest (design surface 3): shrink the conversation text sent to the frontier
 * summarizer by digesting OLD chunks locally, keeping the recent tail verbatim. Chunk digestion
 * is mechanical extraction — the frontier model still writes the summary. Partial assist, never
 * partial loss: any chunk whose digest fails (parse/timeout) passes through verbatim.
 */
export async function preDigestConversationText(args: {
	text: string;
	complete: CurationComplete;
	signal?: AbortSignal;
	chunkChars?: number;
	keepRecentChars?: number;
}): Promise<PreDigestResult> {
	const chunkChars = args.chunkChars ?? PRE_DIGEST_CHUNK_CHARS;
	const keepRecentChars = args.keepRecentChars ?? PRE_DIGEST_KEEP_RECENT_CHARS;
	if (args.text.length <= chunkChars + keepRecentChars) {
		return { text: args.text, totalChunks: 0, digested: 0, failed: 0 };
	}
	const cut = args.text.length - keepRecentChars;
	const prefix = args.text.slice(0, cut);
	const tail = args.text.slice(cut);
	const chunks: string[] = [];
	for (let offset = 0; offset < prefix.length; offset += chunkChars) {
		chunks.push(prefix.slice(offset, offset + chunkChars));
	}
	let digested = 0;
	let failed = 0;
	const parts: string[] = [];
	for (const [index, chunk] of chunks.entries()) {
		if (args.signal?.aborted) {
			parts.push(chunk);
			failed++;
			continue;
		}
		const bounded = await runBoundedCompletion({
			maxWallClockMs: PRE_DIGEST_CHUNK_WALL_CLOCK_MS,
			signal: args.signal,
			execute: (signal) =>
				args.complete({ systemPrompt: CURATION_COMPACTION_DIGEST_SYSTEM_PROMPT, userPrompt: chunk, signal }),
		});
		const digest =
			bounded.completion && !bounded.failure ? parseCompactionChunkDigest(bounded.completion.text) : undefined;
		if (digest !== undefined) {
			digested++;
			parts.push(`[locally pre-digested chunk ${index + 1}/${chunks.length} (${chunk.length} chars):]\n${digest}`);
		} else {
			failed++;
			parts.push(chunk);
		}
	}
	return { text: `${parts.join("\n\n")}${tail}`, totalChunks: chunks.length, digested, failed };
}

export interface CurationJob {
	kind: "stub_digest" | "relevance";
	/** Idempotency key: digest jobs use the GC record's content hash, relevance jobs the item id. */
	key: string;
	/** Bounded chunk the local model must actually be able to process (sliced on enqueue). */
	content: string;
	/** Relevance jobs only: the goal/intent line the chunk is judged against. */
	goal?: string;
}

export interface CurationResult {
	key: string;
	kind: CurationJob["kind"];
	ok: boolean;
	digest?: string;
	relevant?: boolean;
	confidence?: number;
	ms: number;
}

export interface CurationTelemetrySnapshot {
	jobsRun: number;
	parseFailures: number;
	droppedJobs: number;
	/** Times a computed digest was actually RENDERED into a GC stub on a real turn — the
	 * pays-for-itself proxy: every serve is packed content the frontier model got a semantic
	 * handle on without re-running tools. */
	digestsServed: number;
	/** Chars processed locally (an honest proxy for frontier tokens NOT spent on this work). */
	localChars: number;
	queued: number;
	resultsHeld: number;
}

export type CurationComplete = (input: {
	systemPrompt: string;
	userPrompt: string;
	signal?: AbortSignal;
}) => Promise<{ text: string; costUsd: number; stopReason: string }>;

const MAX_QUEUE = 32;
const MAX_RESULTS = 200;
const MAX_JOB_CONTENT_CHARS = 8_000;
const DIGEST_MAX_WALL_CLOCK_MS = 20_000;
const RELEVANCE_MAX_WALL_CLOCK_MS = 8_000;
export const CURATION_RELEVANCE_MIN_CONFIDENCE = 0.8;

function extractJsonObject(text: string): unknown | undefined {
	const trimmed = text.trim();
	const candidates: string[] = [trimmed];
	const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
	if (fenced?.[1]) candidates.push(fenced[1].trim());
	const start = trimmed.indexOf("{");
	const end = trimmed.lastIndexOf("}");
	if (start >= 0 && end > start) candidates.push(trimmed.slice(start, end + 1));
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		} catch {
			// try next candidate
		}
	}
	return undefined;
}

export function parseCurationDigest(text: string): string | undefined {
	const parsed = extractJsonObject(text);
	if (!parsed) return undefined;
	const digest = (parsed as { digest?: unknown }).digest;
	if (typeof digest !== "string") return undefined;
	const trimmed = digest.trim().replace(/\s+/g, " ");
	if (trimmed.length === 0 || trimmed.length > 240) return undefined;
	return trimmed;
}

export function parseCurationRelevance(text: string): { relevant: boolean; confidence: number } | undefined {
	const parsed = extractJsonObject(text);
	if (!parsed) return undefined;
	const record = parsed as { relevant?: unknown; confidence?: unknown };
	if (typeof record.relevant !== "boolean") return undefined;
	const confidence =
		typeof record.confidence === "number" && Number.isFinite(record.confidence)
			? Math.max(0, Math.min(1, record.confidence))
			: 0;
	return { relevant: record.relevant, confidence };
}

export class BrainCurator {
	private readonly _queue = new Map<string, CurationJob>();
	private readonly _results = new Map<string, CurationResult>();
	private _jobsRun = 0;
	private _parseFailures = 0;
	private _droppedJobs = 0;
	private _localChars = 0;
	private _digestsServed = 0;
	private _draining = false;

	enqueue(job: CurationJob): void {
		if (this._results.has(job.key) || this._queue.has(job.key)) return;
		if (this._queue.size >= MAX_QUEUE) {
			// Drop the OLDEST queued job (newer work reflects the current goal better) and count it.
			const oldest = this._queue.keys().next().value;
			if (oldest !== undefined) this._queue.delete(oldest);
			this._droppedJobs++;
		}
		this._queue.set(job.key, { ...job, content: job.content.slice(0, MAX_JOB_CONTENT_CHARS) });
	}

	getDigest(key: string): string | undefined {
		const result = this._results.get(key);
		return result?.ok && result.kind === "stub_digest" ? result.digest : undefined;
	}

	/** Callers report when a digest was rendered into a real (sent) prompt stub. */
	noteDigestServed(): void {
		this._digestsServed++;
	}

	getRelevance(key: string): { relevant: boolean; confidence: number } | undefined {
		const result = this._results.get(key);
		if (!result?.ok || result.kind !== "relevance" || result.relevant === undefined) return undefined;
		return { relevant: result.relevant, confidence: result.confidence ?? 0 };
	}

	hasWork(): boolean {
		return this._queue.size > 0;
	}

	get isDraining(): boolean {
		return this._draining;
	}

	telemetry(): CurationTelemetrySnapshot {
		return {
			jobsRun: this._jobsRun,
			parseFailures: this._parseFailures,
			droppedJobs: this._droppedJobs,
			digestsServed: this._digestsServed,
			localChars: this._localChars,
			queued: this._queue.size,
			resultsHeld: this._results.size,
		};
	}

	/**
	 * Run up to `maxJobs` queued jobs through the injected local-model completer. Single-flight:
	 * a concurrent drain call returns [] immediately rather than double-running jobs. Every call
	 * is wall-clock bounded; a failed/unparseable job is recorded as a not-ok result (so it is
	 * not retried forever) and counted in telemetry.
	 */
	async drain(args: {
		complete: CurationComplete;
		maxJobs: number;
		signal?: AbortSignal;
		now?: () => number;
	}): Promise<CurationResult[]> {
		if (this._draining) return [];
		this._draining = true;
		const now = args.now ?? Date.now;
		const completed: CurationResult[] = [];
		try {
			const jobs = [...this._queue.values()].slice(0, Math.max(0, args.maxJobs));
			for (const job of jobs) {
				if (args.signal?.aborted) break;
				this._queue.delete(job.key);
				const started = now();
				const bounded = await runBoundedCompletion({
					maxWallClockMs: job.kind === "stub_digest" ? DIGEST_MAX_WALL_CLOCK_MS : RELEVANCE_MAX_WALL_CLOCK_MS,
					signal: args.signal,
					execute: (signal) =>
						args.complete({
							systemPrompt:
								job.kind === "stub_digest" ? CURATION_DIGEST_SYSTEM_PROMPT : CURATION_RELEVANCE_SYSTEM_PROMPT,
							userPrompt:
								job.kind === "stub_digest"
									? job.content
									: `Current goal: ${job.goal ?? "(unknown)"}\n\nStale chunk:\n${job.content}`,
							signal,
						}),
				});
				const ms = now() - started;
				this._jobsRun++;
				this._localChars += job.content.length;
				let result: CurationResult = { key: job.key, kind: job.kind, ok: false, ms };
				if (bounded.completion && !bounded.failure) {
					if (job.kind === "stub_digest") {
						const digest = parseCurationDigest(bounded.completion.text);
						result = digest !== undefined ? { ...result, ok: true, digest } : result;
					} else {
						const relevance = parseCurationRelevance(bounded.completion.text);
						result =
							relevance !== undefined
								? { ...result, ok: true, relevant: relevance.relevant, confidence: relevance.confidence }
								: result;
					}
				}
				if (!result.ok) this._parseFailures++;
				this._storeResult(result);
				completed.push(result);
			}
		} finally {
			this._draining = false;
		}
		return completed;
	}

	private _storeResult(result: CurationResult): void {
		if (this._results.size >= MAX_RESULTS) {
			const oldest = this._results.keys().next().value;
			if (oldest !== undefined) this._results.delete(oldest);
		}
		this._results.set(result.key, result);
	}
}
