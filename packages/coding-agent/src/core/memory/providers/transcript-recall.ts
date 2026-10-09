/**
 * Cross-session recall coordinator. One worker belongs to one provider/session generation; no
 * process-global transcript index is shared across sessions.
 *
 * The provider is the lifecycle {@link MemoryProvider} (worker ownership, initialize/shutdown) and the
 * exact read backend ({@link TranscriptLineageReader}): search and source reads return typed results,
 * so a caller can tell "still loading", "worker failed" and "no match" apart. It injects nothing into
 * the prompt itself: past-session evidence reaches it through the provider-neutral retrieval path
 * (`context/transcript-memory-provider.ts`).
 */

import { Worker } from "node:worker_threads";
import type { SessionEntriesPersistedEvent } from "../../../kernel/node.ts";
import type { MemoryProvider } from "../../extensions/types.ts";
import { getDirectoryResourceProfileInfo } from "../../settings/settings-rules.ts";
import type { MemoryCapabilities, MemoryLifecycleContext } from "../memory-provider.ts";
import type {
	TranscriptCoverage,
	TranscriptIndexChangeEvent,
	TranscriptLineageReader,
	TranscriptLineageSpansRequest,
	TranscriptLineageSpansResult,
	TranscriptReadUnavailable,
	TranscriptSearchRequest,
	TranscriptSearchResult,
	TranscriptSessionSummary,
	TranscriptSourcePageRequest,
	TranscriptSourcePageResult,
} from "../transcript-memory-contracts.ts";
import {
	isTranscriptRecallWorkerResponse,
	TRANSCRIPT_RECALL_MAX_ERROR_CHARS,
	TRANSCRIPT_RECALL_MAX_HITS,
	TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS,
	TRANSCRIPT_RECALL_MAX_QUERY_CHARS,
	TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES,
	TRANSCRIPT_RECALL_MIN_SOURCE_PAGE_BYTES,
	type TranscriptRecallWorkerRequest,
	type TranscriptRecallWorkerResponse,
} from "./transcript-recall-worker-protocol.ts";

const DEFAULT_MAX_PENDING_QUERIES = 8;
/** Foreground reads (search, source) must not hold a turn: one second. */
const QUERY_TIMEOUT_MS = 1_000;
/**
 * Background reads for the summary hierarchy (session listing, lineage pages) run off the foreground
 * path, so they get a longer bound: the worker may be busy ingesting or loading while it answers.
 */
const BACKGROUND_READ_TIMEOUT_MS = 30_000;

type PendingKind = "result" | "source" | "sessions" | "lineage";
type PendingResponse = Extract<TranscriptRecallWorkerResponse, { type: PendingKind }>;

interface PendingRequest {
	worker: Worker;
	generation: number;
	expect: PendingKind;
	resolve: (outcome: PendingResponse | TranscriptReadUnavailable) => void;
	timeout: NodeJS.Timeout;
}

interface QueuedIngest {
	sessionId: string;
	rewritten: boolean;
}

/**
 * Whether the history index is serving, still loading its initial scan, or down (with the real cause).
 * A stopped transport and a slow one are different facts: `stoppedAt` marks the worker that ended,
 * `readTimeouts` the reads that gave up on a worker that is still there.
 */
export interface TranscriptRecallHealth {
	state: "ready" | "loading" | "failed";
	reason?: string;
	/** When the worker stopped serving; absent while it serves and when it never started. */
	stoppedAt?: string;
	/** Reads of this worker generation that timed out, with when the latest did. */
	readTimeouts?: { count: number; lastAt: string };
}

export interface TranscriptRecallProviderOptions {
	workerSpecifier?: string | URL;
	maxPendingQueries?: number;
}

function createDefaultWorkerSpecifier(): string | URL {
	if (typeof process.versions.bun === "string") {
		return "./src/core/memory/providers/transcript-recall-worker.ts";
	}
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	return new URL(
		isTypeScriptRuntime ? "./transcript-recall-worker.ts" : "./transcript-recall-worker.js",
		import.meta.url,
	);
}

function describeError(error: unknown): string {
	return (error instanceof Error ? error.message : String(error)).slice(0, TRANSCRIPT_RECALL_MAX_ERROR_CHARS);
}

function describeMalformedResponse(value: unknown): string {
	const type = typeof value === "object" && value !== null ? (value as { type?: unknown }).type : undefined;
	return typeof type === "string" ? `a malformed '${type.slice(0, 32)}' response` : "a malformed response";
}

/** Clamp a caller-supplied number into an integer range; non-finite input takes `fallback`. */
function clampInteger(value: number, min: number, max: number, fallback: number): number {
	return Number.isFinite(value) ? Math.max(min, Math.min(max, Math.trunc(value))) : fallback;
}

export class TranscriptRecallProvider implements MemoryProvider, TranscriptLineageReader {
	readonly name = "transcript-recall";
	readonly egress = "local";
	private readonly workerSpecifier: string | URL;
	private readonly maxPendingQueries: number;
	private worker: Worker | undefined;
	private generation = 0;
	private requestId = 0;
	private ready = false;
	private projectId: string | undefined;
	private failure: string | undefined;
	private stoppedAt: string | undefined;
	private readTimeouts: { count: number; lastAt: string } | undefined;
	private latestCoverage: TranscriptCoverage | undefined;
	private readyPromise: Promise<void> | undefined;
	private resolveReady: (() => void) | undefined;
	private readonly pending = new Map<number, PendingRequest>();
	/** Persisted-entry announcements received before the worker finished its initial scan, one per file. */
	private readonly queuedIngests = new Map<string, QueuedIngest>();
	private readonly indexListeners = new Set<(event: TranscriptIndexChangeEvent) => void>();

	constructor(options: TranscriptRecallProviderOptions = {}) {
		this.workerSpecifier = options.workerSpecifier ?? createDefaultWorkerSpecifier();
		this.maxPendingQueries = Math.max(1, Math.trunc(options.maxPendingQueries ?? DEFAULT_MAX_PENDING_QUERIES));
	}

	isAvailable(): boolean {
		return true;
	}

	getCapabilities(): MemoryCapabilities {
		return { surfaces: ["context"] };
	}

	async initialize(sessionId: string, ctx: MemoryLifecycleContext): Promise<void> {
		await this.disposeWorker();
		const generation = ++this.generation;
		this.ready = false;
		this.failure = undefined;
		this.stoppedAt = undefined;
		this.readTimeouts = undefined;
		this.latestCoverage = undefined;
		this.projectId = undefined;
		this.queuedIngests.clear();
		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});

		let projectId: string;
		try {
			projectId = getDirectoryResourceProfileInfo(ctx.cwd, ctx.agentDir).hash;
		} catch (error) {
			this.failure = `Project identity could not be resolved: ${describeError(error)}`;
			this.finishReady();
			return;
		}
		this.projectId = projectId;

		let worker: Worker;
		try {
			worker = new Worker(this.workerSpecifier);
		} catch (error) {
			this.failure = `Transcript recall worker could not start: ${describeError(error)}`;
			this.finishReady();
			return;
		}
		worker.unref();
		this.worker = worker;
		worker.on("message", (message: unknown) => this.handleWorkerMessage(worker, generation, message));
		worker.on("error", (error: Error) =>
			this.handleWorkerFailure(worker, generation, `Transcript recall worker error: ${describeError(error)}`),
		);
		worker.on("exit", (code: number) =>
			this.handleWorkerFailure(worker, generation, `Transcript recall worker exited with code ${code}.`),
		);
		this.post(worker, generation, {
			type: "initialize",
			generation,
			sessionId,
			agentDir: ctx.agentDir,
			cwd: ctx.cwd,
			projectId,
		});
	}

	async shutdown(): Promise<void> {
		this.generation += 1;
		await this.disposeWorker();
	}

	/** Event-driven readiness hook for tests and callers that can wait outside the foreground turn. */
	async waitUntilReady(): Promise<void> {
		await this.readyPromise;
	}

	/**
	 * Announce entries that reached durable session storage. The worker reads only the appended
	 * lines (or the whole file when it was rewritten). Ignored before initialization and after
	 * shutdown: a fresh worker reads the file from disk.
	 */
	notifyEntriesPersisted(event: SessionEntriesPersistedEvent): void {
		const worker = this.worker;
		if (!worker) return;
		if (!this.ready) {
			// The worker is still scanning; hold one coalesced announcement per file and replay it on ready.
			const queued = this.queuedIngests.get(event.sessionFile);
			this.queuedIngests.set(event.sessionFile, {
				sessionId: event.sessionId,
				rewritten: (queued?.rewritten ?? false) || event.rewritten,
			});
			return;
		}
		this.postIngest(worker, event.sessionId, event.sessionFile, event.rewritten);
	}

	private postIngest(worker: Worker, sessionId: string, sessionFile: string, rewritten: boolean): void {
		this.post(worker, this.generation, {
			type: "ingest",
			generation: this.generation,
			sessionId,
			sessionFile,
			rewritten,
		});
	}

	health(): TranscriptRecallHealth {
		const health: TranscriptRecallHealth =
			this.worker === undefined
				? {
						state: "failed",
						reason: this.failure ?? "Transcript recall has not been initialized for this session.",
					}
				: { state: this.ready ? "ready" : "loading" };
		if (this.stoppedAt !== undefined) health.stoppedAt = this.stoppedAt;
		if (this.readTimeouts !== undefined) health.readTimeouts = { ...this.readTimeouts };
		return health;
	}

	coverage(): TranscriptCoverage | undefined {
		return this.latestCoverage;
	}

	async search(request: TranscriptSearchRequest): Promise<TranscriptSearchResult> {
		const query = request.query.trim().slice(0, TRANSCRIPT_RECALL_MAX_QUERY_CHARS);
		const maxResults = clampInteger(request.maxResults, 1, TRANSCRIPT_RECALL_MAX_HITS, TRANSCRIPT_RECALL_MAX_HITS);
		const gate = this.admit();
		if (gate) return gate;
		if (!query) return { status: "ok", hits: [], coverage: this.latestCoverage ?? emptyCoverage() };

		const outcome = await this.request("result", (generation, requestId) => ({
			type: "query",
			generation,
			requestId,
			query,
			maxResults,
			includeAlternateBranches: request.includeAlternateBranches === true,
			includeCurrentSession: request.includeCurrentSession === true,
		}));
		if ("status" in outcome) return outcome;
		return { status: "ok", hits: outcome.hits, coverage: this.latestCoverage ?? emptyCoverage() };
	}

	async readSource(request: TranscriptSourcePageRequest): Promise<TranscriptSourcePageResult> {
		if (this.projectId !== undefined && request.ref.projectId !== this.projectId) {
			return { status: "forbidden", reason: "The source handle belongs to another project." };
		}
		const gate = this.admit();
		if (gate) return gate;

		const maxBytes = clampInteger(
			request.maxBytes,
			TRANSCRIPT_RECALL_MIN_SOURCE_PAGE_BYTES,
			TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES,
			TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES,
		);
		const cursor = clampInteger(request.cursor ?? 0, 0, Number.MAX_SAFE_INTEGER, 0);
		const outcome = await this.request("source", (generation, requestId) => ({
			type: "source",
			generation,
			requestId,
			sessionId: request.ref.sessionId,
			entryId: request.ref.entryId,
			part: request.ref.part,
			digest: request.ref.digest,
			cursor,
			maxBytes,
		}));
		return "status" in outcome ? outcome : outcome.result;
	}

	async listSessions(): Promise<{ status: "ok"; sessions: TranscriptSessionSummary[] } | TranscriptReadUnavailable> {
		const gate = this.admit();
		if (gate) return gate;
		const outcome = await this.request("sessions", (generation, requestId) => ({
			type: "sessions",
			generation,
			requestId,
		}));
		return "status" in outcome ? outcome : outcome.result;
	}

	async listLineageSpans(request: TranscriptLineageSpansRequest): Promise<TranscriptLineageSpansResult> {
		const gate = this.admit();
		if (gate) return gate;
		const fromIndex = clampInteger(request.fromIndex, 0, Number.MAX_SAFE_INTEGER, 0);
		const maxSpans = clampInteger(
			request.maxSpans,
			1,
			TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS,
			TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS,
		);
		const outcome = await this.request("lineage", (generation, requestId) => ({
			type: "lineage",
			generation,
			requestId,
			sessionId: request.sessionId,
			fromIndex,
			maxSpans,
		}));
		return "status" in outcome ? outcome : outcome.result;
	}

	onIndexChanged(listener: (event: TranscriptIndexChangeEvent) => void): () => void {
		this.indexListeners.add(listener);
		return () => {
			this.indexListeners.delete(listener);
		};
	}

	/** Deliver an index change to subscribers; a listener's failure never reaches the provider. */
	private emitIndexChange(event: TranscriptIndexChangeEvent): void {
		for (const listener of [...this.indexListeners]) {
			try {
				listener(event);
			} catch {
				// An observer of the derived index never breaks the index it observes.
			}
		}
	}

	/** Why a read cannot even be posted right now, or undefined when the worker is ready for it. */
	private admit(): TranscriptReadUnavailable | undefined {
		if (!this.worker) {
			return {
				status: "unavailable",
				reason: this.failure ?? "Transcript recall has not been initialized for this session.",
			};
		}
		if (!this.ready) return { status: "pending", reason: "The transcript history index is still loading." };
		if (this.pending.size >= this.maxPendingQueries) {
			return { status: "unavailable", reason: "Too many transcript reads are already in flight." };
		}
		return undefined;
	}

	private request<K extends PendingKind>(
		expect: K,
		build: (generation: number, requestId: number) => TranscriptRecallWorkerRequest,
	): Promise<Extract<PendingResponse, { type: K }> | TranscriptReadUnavailable> {
		const worker = this.worker;
		if (!worker) {
			return Promise.resolve({
				status: "unavailable",
				reason: this.failure ?? "Transcript recall has not been initialized for this session.",
			});
		}
		const generation = this.generation;
		const requestId = this.requestId++;
		const timeoutMs = expect === "sessions" || expect === "lineage" ? BACKGROUND_READ_TIMEOUT_MS : QUERY_TIMEOUT_MS;
		return new Promise((resolve) => {
			const timeout = setTimeout(() => {
				if (!this.pending.has(requestId)) return;
				this.readTimeouts = { count: (this.readTimeouts?.count ?? 0) + 1, lastAt: new Date().toISOString() };
				this.finishRequest(requestId, {
					status: "unavailable",
					reason: `Transcript read timed out after ${timeoutMs} ms.`,
				});
			}, timeoutMs);
			timeout.unref();
			// `handleWorkerMessage` resolves a pending request only with a response of the kind it expects.
			const settle = (outcome: PendingResponse | TranscriptReadUnavailable): void =>
				resolve(outcome as Extract<PendingResponse, { type: K }> | TranscriptReadUnavailable);
			this.pending.set(requestId, { worker, generation, expect, resolve: settle, timeout });
			this.post(worker, generation, build(generation, requestId));
		});
	}

	/** Post to the worker; a post that throws is a worker failure with its real cause. */
	private post(worker: Worker, generation: number, request: TranscriptRecallWorkerRequest): void {
		try {
			worker.postMessage(request);
		} catch (error) {
			this.handleWorkerFailure(
				worker,
				generation,
				`Transcript recall worker rejected a message: ${describeError(error)}`,
			);
		}
	}

	private handleWorkerMessage(worker: Worker, generation: number, value: unknown): void {
		if (this.worker !== worker || this.generation !== generation) return;
		if (!isTranscriptRecallWorkerResponse(value)) {
			// A reply outside the protocol can never settle its read; stop the channel with that cause
			// instead of leaving every pending read to time out with no explanation.
			this.handleWorkerFailure(
				worker,
				generation,
				`Transcript recall worker sent ${describeMalformedResponse(value)}.`,
			);
			return;
		}
		const message: TranscriptRecallWorkerResponse = value;
		if (message.generation !== generation) return;
		switch (message.type) {
			case "ready":
				this.ready = true;
				this.latestCoverage = message.coverage;
				for (const [sessionFile, queued] of this.queuedIngests) {
					this.postIngest(worker, queued.sessionId, sessionFile, queued.rewritten);
				}
				this.queuedIngests.clear();
				this.finishReady();
				if (message.change) this.emitIndexChange(message.change);
				break;
			case "coverage":
				this.latestCoverage = message.coverage;
				if (message.change) this.emitIndexChange(message.change);
				break;
			case "result":
			case "source":
			case "sessions":
			case "lineage": {
				const pending = this.pending.get(message.requestId);
				if (!pending || pending.worker !== worker || pending.generation !== generation) return;
				if (pending.expect !== message.type) return;
				this.finishRequest(message.requestId, message);
				break;
			}
			case "queryFailed": {
				const pending = this.pending.get(message.requestId);
				if (!pending || pending.worker !== worker || pending.generation !== generation) return;
				this.finishRequest(message.requestId, {
					status: "unavailable",
					reason: `Transcript query failed: ${message.error}`,
				});
				break;
			}
			case "failed":
				this.handleWorkerFailure(worker, generation, `Transcript recall worker failed: ${message.error}`);
				break;
			case "stopped":
				break;
		}
	}

	private handleWorkerFailure(worker: Worker, generation: number, reason: string): void {
		if (this.worker !== worker || this.generation !== generation) return;
		this.worker = undefined;
		this.ready = false;
		this.latestCoverage = undefined;
		this.failure = reason;
		this.stoppedAt = new Date().toISOString();
		this.queuedIngests.clear();
		this.finishReady();
		this.finishRequestsFor(worker, { status: "unavailable", reason });
		void worker.terminate().catch(() => undefined);
	}

	private finishReady(): void {
		const resolve = this.resolveReady;
		this.resolveReady = undefined;
		resolve?.();
	}

	private finishRequest(requestId: number, outcome: PendingResponse | TranscriptReadUnavailable): void {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId);
		clearTimeout(pending.timeout);
		pending.resolve(outcome);
	}

	private finishRequestsFor(worker: Worker, outcome: TranscriptReadUnavailable): void {
		for (const [requestId, pending] of this.pending) {
			if (pending.worker === worker) this.finishRequest(requestId, outcome);
		}
	}

	private async disposeWorker(): Promise<void> {
		const worker = this.worker;
		this.worker = undefined;
		this.ready = false;
		this.latestCoverage = undefined;
		this.queuedIngests.clear();
		this.finishReady();
		if (worker) {
			this.finishRequestsFor(worker, {
				status: "unavailable",
				reason: "Transcript recall was shut down before the read completed.",
			});
		}
		this.readyPromise = undefined;
		if (!worker) return;
		try {
			worker.postMessage({ type: "shutdown", generation: this.generation });
		} catch {}
		await worker.terminate().catch(() => undefined);
	}
}

function emptyCoverage(): TranscriptCoverage {
	return {
		sessionsEligible: 0,
		sessionsIndexed: 0,
		sessionsUnsupported: 0,
		sessionsSkipped: 0,
		spansIndexed: 0,
		spansUncaptured: 0,
		skipped: {},
		unsupported: {},
		uncaptured: {},
		activeFailures: 0,
		truncated: false,
	};
}
