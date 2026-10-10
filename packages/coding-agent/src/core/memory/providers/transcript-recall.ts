/**
 * Cross-session recall coordinator. One worker belongs to one provider/session generation; no
 * process-global transcript index is shared across sessions. The worker starts at most once per
 * generation: at initialization (`start: "eager"`), or on demand (the default) at the first read or an
 * explicit {@link TranscriptRecallProvider.start}, so an unused history scans no session bodies.
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
import {
	TRANSCRIPT_FOREGROUND_READ_MS,
	TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS,
	type TranscriptCoverage,
	type TranscriptIndexChangeEvent,
	type TranscriptIndexObservation,
	type TranscriptLineageReader,
	type TranscriptLineageSpansRequest,
	type TranscriptLineageSpansResult,
	type TranscriptLineageVerifyRequest,
	type TranscriptLineageVerifyResult,
	type TranscriptObservationVerdict,
	type TranscriptReadUnavailable,
	type TranscriptSearchRequest,
	type TranscriptSearchResult,
	type TranscriptSourcePageRequest,
	type TranscriptSourcePageResult,
} from "../transcript-memory-contracts.ts";
import {
	isTranscriptRecallRangeCheck,
	isTranscriptRecallWorkerResponse,
	TRANSCRIPT_RECALL_MAX_ERROR_CHARS,
	TRANSCRIPT_RECALL_MAX_HITS,
	TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS,
	TRANSCRIPT_RECALL_MAX_QUERY_CHARS,
	TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES,
	TRANSCRIPT_RECALL_MIN_SOURCE_PAGE_BYTES,
	type TranscriptRecallLineageBump,
	type TranscriptRecallSessionsResult,
	type TranscriptRecallWorkerRequest,
	type TranscriptRecallWorkerResponse,
} from "./transcript-recall-worker-protocol.ts";

const DEFAULT_MAX_PENDING_QUERIES = 8;
/**
 * Background reads for the summary hierarchy (session listing, background lineage pages) run off the foreground
 * path, so they get a longer bound: the worker may be busy ingesting or loading while it answers.
 */
const BACKGROUND_READ_TIMEOUT_MS = 30_000;

const NOT_INITIALIZED_REASON = "Transcript recall has not been initialized for this session.";
const LOADING_REASON = "The transcript history index is still loading.";
const SHUT_DOWN_REASON = "Transcript recall was shut down before the read completed.";
const TOO_MANY_READS_REASON = "Too many transcript reads are already in flight.";
/**
 * Lineage revision bumps remembered per session. An observation older than the remembered history is judged
 * changed: conservative, never served on a guess.
 */
const MAX_LINEAGE_BUMP_HISTORY = 64;
/** A genuine timeout of the caller's whole operation (`deadlineAt`); worded for the timeout retry class. */
const OPERATION_TIMEOUT_REASON = "The history operation timed out: its deadline passed before the read completed.";

type PendingKind = "result" | "source" | "sessions" | "lineage" | "verify";
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

/** What an initialized generation needs to start its worker; held until the one start consumes it. */
interface StartRequest {
	sessionId: string;
	agentDir: string;
	cwd: string;
	projectId: string;
}

/**
 * One read's whole time budget, fixed at the read's start; readiness wait and reply share it. `deadline` is the
 * sooner of the read's own bound (`timeoutMs` from its start) and the caller's operation deadline (`deadlineAt`);
 * `operation` records that the operation deadline is the binding one, so its expiry is reported as that timeout.
 */
interface ReadBudget {
	generation: number;
	timeoutMs: number;
	deadline: number;
	operation: boolean;
}

/** Bumps of one session's lineage revision this generation: the latest revision and a bounded recent history. */
interface SessionLineageBumps {
	revision: number;
	/** Consecutive revisions, oldest first, each with the lowest selected-lineage position its change can have affected. */
	history: Array<{ revision: number; lowestChanged: number }>;
}

/** A read waiting for its generation's ready event; settled once with the outcome that ended the wait. */
interface ReadinessWaiter {
	settle: (outcome: TranscriptReadUnavailable | undefined) => void;
}

/**
 * Whether the history index is not started yet, serving, still loading its initial scan, or down (with
 * the real cause). A stopped transport and a slow one are different facts: `stoppedAt` marks the worker
 * that ended, `readTimeouts` the reads that gave up on a worker that is still there.
 */
export interface TranscriptRecallHealth {
	/** `idle`: initialized, worker not started, no failure. A read or `start()` starts it. */
	state: "idle" | "loading" | "ready" | "failed";
	reason?: string;
	/** When the worker stopped serving; absent while it serves and when it never started. */
	stoppedAt?: string;
	/** Reads of this worker generation that timed out, with when the latest did. */
	readTimeouts?: { count: number; lastAt: string };
}

export interface TranscriptRecallProviderOptions {
	workerSpecifier?: string | URL;
	maxPendingQueries?: number;
	/**
	 * When a generation's worker starts its initial scan: `eager` at initialization, `on_demand` (the
	 * default) at the first read or an explicit `start()`.
	 */
	start?: "eager" | "on_demand";
	/**
	 * The active session's file, resolved when the worker starts. The start scan reads the project's default
	 * session directories; naming the active file lets it capture a session stored elsewhere as well.
	 */
	activeSessionFile?: () => string | undefined;
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
	private readonly startMode: "eager" | "on_demand";
	private readonly activeSessionFile: (() => string | undefined) | undefined;
	private worker: Worker | undefined;
	/** Present while this generation is initialized and its worker has not been started. */
	private startRequest: StartRequest | undefined;
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
	private readonly readinessWaiters = new Set<ReadinessWaiter>();
	/** Persisted-entry announcements received before the worker finished its initial scan, one per file. */
	private readonly queuedIngests = new Map<string, QueuedIngest>();
	private readonly indexListeners = new Set<(event: TranscriptIndexChangeEvent) => void>();
	/** Ingest sequence of this generation, assigned when an ingest is posted (including the replay at ready). */
	private ingestSeq = 0;
	/** The last ingest sequence posted per session id, this generation. */
	private readonly lastIngestSeq = new Map<string, number>();
	/** Lineage revision bumps learned from this generation's coverage messages, per session id. */
	private readonly lineageBumps = new Map<string, SessionLineageBumps>();

	constructor(options: TranscriptRecallProviderOptions = {}) {
		this.workerSpecifier = options.workerSpecifier ?? createDefaultWorkerSpecifier();
		this.maxPendingQueries = Math.max(1, Math.trunc(options.maxPendingQueries ?? DEFAULT_MAX_PENDING_QUERIES));
		this.startMode = options.start ?? "on_demand";
		this.activeSessionFile = options.activeSessionFile;
	}

	isAvailable(): boolean {
		return true;
	}

	getCapabilities(): MemoryCapabilities {
		return { surfaces: ["context"] };
	}

	async initialize(sessionId: string, ctx: MemoryLifecycleContext): Promise<void> {
		await this.disposeWorker();
		this.generation += 1;
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
			this.finishReady({ status: "unavailable", reason: this.failure });
			return;
		}
		this.projectId = projectId;
		this.startRequest = { sessionId, agentDir: ctx.agentDir, cwd: ctx.cwd, projectId };
		if (this.startMode === "eager") this.start();
	}

	/**
	 * Start this generation's worker and its initial scan. Idempotent: a generation starts its worker at
	 * most once, and a worker that failed is not restarted. A no-op before `initialize()` has resolved the
	 * project and after `shutdown()`.
	 */
	start(): void {
		const request = this.startRequest;
		if (!request) return;
		this.startRequest = undefined;
		const generation = this.generation;
		// Resolved now, not at initialization: the active session may have been written or moved since.
		const sessionFile = this.activeSessionFile?.();
		let worker: Worker;
		try {
			worker = new Worker(this.workerSpecifier);
		} catch (error) {
			this.failure = `Transcript recall worker could not start: ${describeError(error)}`;
			this.finishReady({ status: "unavailable", reason: this.failure });
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
			sessionId: request.sessionId,
			agentDir: request.agentDir,
			cwd: request.cwd,
			projectId: request.projectId,
			...(sessionFile ? { sessionFile } : {}),
		});
	}

	async shutdown(): Promise<void> {
		this.generation += 1;
		await this.disposeWorker();
	}

	/**
	 * Event-driven readiness hook for tests and callers that can wait outside the foreground turn. Settles
	 * when this generation's worker is ready, fails or is shut down; it does not start the worker.
	 */
	async waitUntilReady(): Promise<void> {
		await this.readyPromise;
	}

	/**
	 * Announce entries that reached durable session storage. The worker reads only the appended
	 * lines (or the whole file when it was rewritten). Ignored before initialization, while the
	 * generation is idle (not started) and after shutdown: a worker that starts later reads canonical
	 * storage, the project's session directories plus the active session file named by
	 * `activeSessionFile`, wherever it is stored.
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
		const seq = ++this.ingestSeq;
		this.lastIngestSeq.set(sessionId, seq);
		this.post(worker, this.generation, {
			type: "ingest",
			generation: this.generation,
			sessionId,
			sessionFile,
			rewritten,
			seq,
		});
	}

	health(): TranscriptRecallHealth {
		const health: TranscriptRecallHealth =
			this.worker !== undefined
				? { state: this.ready ? "ready" : "loading" }
				: this.startRequest !== undefined
					? { state: "idle" }
					: { state: "failed", reason: this.failure ?? NOT_INITIALIZED_REASON };
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
		const budget = await this.admit(TRANSCRIPT_FOREGROUND_READ_MS, request.deadlineAt);
		if ("status" in budget) return budget;
		if (!query) return { status: "ok", hits: [], coverage: this.latestCoverage ?? emptyCoverage() };

		const outcome = await this.request("result", budget, (generation, requestId) => ({
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
		const budget = await this.admit(TRANSCRIPT_FOREGROUND_READ_MS, request.deadlineAt);
		if ("status" in budget) return budget;

		const maxBytes = clampInteger(
			request.maxBytes,
			TRANSCRIPT_RECALL_MIN_SOURCE_PAGE_BYTES,
			TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES,
			TRANSCRIPT_RECALL_MAX_SOURCE_PAGE_BYTES,
		);
		const cursor = clampInteger(request.cursor ?? 0, 0, Number.MAX_SAFE_INTEGER, 0);
		const outcome = await this.request("source", budget, (generation, requestId) => ({
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

	async listSessions(): Promise<TranscriptRecallSessionsResult> {
		const budget = await this.admit(BACKGROUND_READ_TIMEOUT_MS);
		if ("status" in budget) return budget;
		const outcome = await this.request("sessions", budget, (generation, requestId) => ({
			type: "sessions",
			generation,
			requestId,
		}));
		return "status" in outcome ? outcome : outcome.result;
	}

	async listLineageSpans(request: TranscriptLineageSpansRequest): Promise<TranscriptLineageSpansResult> {
		// An explicit history read waits on this page in the foreground; summary construction does not.
		const budget = await this.admit(
			request.priority === "foreground" ? TRANSCRIPT_FOREGROUND_READ_MS : BACKGROUND_READ_TIMEOUT_MS,
			request.deadlineAt,
		);
		if ("status" in budget) return budget;
		const fromIndex = clampInteger(request.fromIndex, 0, Number.MAX_SAFE_INTEGER, 0);
		const maxSpans = clampInteger(
			request.maxSpans,
			1,
			TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS,
			TRANSCRIPT_RECALL_MAX_LINEAGE_SPANS,
		);
		const outcome = await this.request("lineage", budget, (generation, requestId) => ({
			type: "lineage",
			generation,
			requestId,
			sessionId: request.sessionId,
			fromIndex,
			maxSpans,
		}));
		return "status" in outcome ? outcome : outcome.result;
	}

	async verifyLineageRanges(request: TranscriptLineageVerifyRequest): Promise<TranscriptLineageVerifyResult> {
		if (request.checks.length > TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS) {
			return {
				status: "unavailable",
				reason: `${request.checks.length} lineage range checks exceed the limit of ${TRANSCRIPT_LINEAGE_MAX_RANGE_CHECKS} per request.`,
			};
		}
		const invalid = request.checks.findIndex((check) => !isTranscriptRecallRangeCheck(check));
		if (invalid !== -1) {
			return {
				status: "unavailable",
				reason: `Lineage range check ${invalid} is invalid: it needs a session id, fromIndex >= 0, count >= 1 and a 32-digit hex range digest.`,
			};
		}
		if (request.checks.length === 0) {
			return { status: "unavailable", reason: "A lineage range verification needs at least one check." };
		}
		const budget = await this.admit(
			request.priority === "foreground" ? TRANSCRIPT_FOREGROUND_READ_MS : BACKGROUND_READ_TIMEOUT_MS,
			request.deadlineAt,
		);
		if ("status" in budget) return budget;
		const checks = request.checks.map(({ sessionId, fromIndex, count, digest }) => ({
			sessionId,
			fromIndex,
			count,
			digest,
		}));
		const outcome = await this.request("verify", budget, (generation, requestId) => ({
			type: "verify",
			generation,
			requestId,
			checks,
		}));
		if ("status" in outcome) return outcome;
		if (outcome.result.status === "ok" && outcome.result.verdicts.length !== checks.length) {
			return {
				status: "unavailable",
				reason: `The transcript recall worker answered ${outcome.result.verdicts.length} verdicts for ${checks.length} range checks.`,
			};
		}
		return outcome.result;
	}

	/**
	 * Judge an observation against what this process knows now, synchronously (no I/O, no await), in order:
	 * 1. the backend that answered is gone, failed or replaced (one worker per generation, so the same generation
	 *    with a live worker is the same worker): `unavailable` with the cause;
	 * 2. an ingest of an observed session was posted after the answer's highest received one: `changed` (the parent
	 *    cannot tell an append from a branch switch before the index applies it);
	 * 3. an observed session's lineage revision moved with a change below the position the answer depended on:
	 *    `changed`; a move older than the remembered bump history is judged changed too.
	 * Freshness is against notified and indexed state only, and relies on the worker's messages arriving in post
	 * order (the platform's MessagePort FIFO), so every bump preceding an answer is already applied here.
	 */
	observationCurrent(observation: TranscriptIndexObservation): TranscriptObservationVerdict {
		if (observation.generation !== this.generation) {
			return {
				status: "unavailable",
				reason: `The transcript history index that answered was replaced (generation ${observation.generation}, now ${this.generation}).`,
			};
		}
		if (!this.worker) return { status: "unavailable", reason: this.failure ?? SHUT_DOWN_REASON };
		for (const session of observation.sessions) {
			if ((this.lastIngestSeq.get(session.sessionId) ?? 0) > observation.ingestSeq) {
				return {
					status: "changed",
					reason: `Session ${session.sessionId} has a notified change the index had not applied when it answered.`,
				};
			}
		}
		for (const session of observation.sessions) {
			const bumps = this.lineageBumps.get(session.sessionId);
			const revision = bumps?.revision ?? 0;
			if (revision === session.lineageRevision) continue;
			const oldest = bumps?.history[0]?.revision;
			if (
				!bumps ||
				revision < session.lineageRevision ||
				oldest === undefined ||
				oldest > session.lineageRevision + 1
			) {
				return {
					status: "changed",
					reason: `Session ${session.sessionId}'s selected lineage changed beyond the remembered revision history.`,
				};
			}
			for (const bump of bumps.history) {
				if (bump.revision > session.lineageRevision && bump.lowestChanged < session.dependsThrough) {
					return {
						status: "changed",
						reason: `Session ${session.sessionId}'s selected lineage changed at position ${bump.lowestChanged}, inside what the answer depended on.`,
					};
				}
			}
		}
		return { status: "current" };
	}

	/** Record a lineage revision bump of this generation's worker, keeping a bounded consecutive history. */
	private noteLineageBump(bump: TranscriptRecallLineageBump): void {
		const known = this.lineageBumps.get(bump.sessionId) ?? { revision: 0, history: [] };
		if (bump.lineageRevision <= known.revision) return;
		known.revision = bump.lineageRevision;
		known.history.push({ revision: bump.lineageRevision, lowestChanged: bump.lowestChanged });
		if (known.history.length > MAX_LINEAGE_BUMP_HISTORY) known.history.shift();
		this.lineageBumps.set(bump.sessionId, known);
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

	/**
	 * Admit a read and fix its `timeoutMs` budget from now, or say why it cannot be served. An idle
	 * generation is started here. Any read that finds the index loading, whoever started it, waits for this
	 * generation's ready event within its own budget: `pending` when the deadline comes first, the real
	 * cause when the worker fails or the generation is replaced. Waiting reads count against
	 * `maxPendingQueries` like posted ones; the posted-read limit itself is applied where a read is posted.
	 * `deadlineAt` (the caller's whole-operation deadline) bounds the budget when it is sooner, and its expiry
	 * is the operation's timeout, never `pending`. The generation fence (shutdown, re-initialization) is the
	 * cancellation fence for every admitted read.
	 */
	private async admit(timeoutMs: number, deadlineAt?: number): Promise<ReadBudget | TranscriptReadUnavailable> {
		const now = Date.now();
		const operation = deadlineAt !== undefined && Number.isFinite(deadlineAt) && deadlineAt < now + timeoutMs;
		const budget: ReadBudget = {
			generation: this.generation,
			timeoutMs,
			deadline: operation ? deadlineAt : now + timeoutMs,
			operation,
		};
		if (budget.deadline <= now) return { status: "unavailable", reason: OPERATION_TIMEOUT_REASON };
		this.start();
		if (this.worker && !this.ready) {
			if (this.readinessWaiters.size >= this.maxPendingQueries) {
				return { status: "unavailable", reason: TOO_MANY_READS_REASON };
			}
			const outcome = await this.awaitReady(budget);
			if (outcome) return outcome;
			// Ready settled this generation's wait; a generation that replaced it never serves this read.
			if (this.generation !== budget.generation) return { status: "unavailable", reason: SHUT_DOWN_REASON };
		}
		if (!this.worker) return { status: "unavailable", reason: this.failure ?? NOT_INITIALIZED_REASON };
		if (!this.ready) return { status: "pending", reason: LOADING_REASON };
		return budget;
	}

	/**
	 * Wait for this generation's ready event until the read's deadline: `pending` when the read's own bound comes
	 * first, the operation timeout when `deadlineAt` does.
	 */
	private awaitReady(budget: ReadBudget): Promise<TranscriptReadUnavailable | undefined> {
		return new Promise((resolve) => {
			let timeout: NodeJS.Timeout | undefined;
			const waiter: ReadinessWaiter = {
				settle: (outcome) => {
					clearTimeout(timeout);
					this.readinessWaiters.delete(waiter);
					resolve(outcome);
				},
			};
			this.readinessWaiters.add(waiter);
			timeout = setTimeout(
				() =>
					waiter.settle(
						budget.operation
							? { status: "unavailable", reason: OPERATION_TIMEOUT_REASON }
							: { status: "pending", reason: LOADING_REASON },
					),
				Math.max(0, budget.deadline - Date.now()),
			);
			timeout.unref();
		});
	}

	private request<K extends PendingKind>(
		expect: K,
		budget: ReadBudget,
		build: (generation: number, requestId: number) => TranscriptRecallWorkerRequest,
	): Promise<Extract<PendingResponse, { type: K }> | TranscriptReadUnavailable> {
		// The read was admitted for its generation; a generation that replaced it never serves the read.
		if (this.generation !== budget.generation) {
			return Promise.resolve({ status: "unavailable", reason: SHUT_DOWN_REASON });
		}
		const worker = this.worker;
		if (!worker) {
			return Promise.resolve({ status: "unavailable", reason: this.failure ?? NOT_INITIALIZED_REASON });
		}
		// Checked here, in the same turn as the read is registered: reads released together (one ready event,
		// or concurrent callers past their admission) can never post more than the limit.
		if (this.pending.size >= this.maxPendingQueries) {
			return Promise.resolve({ status: "unavailable", reason: TOO_MANY_READS_REASON });
		}
		const generation = budget.generation;
		const requestId = this.requestId++;
		return new Promise((resolve) => {
			const timeout = setTimeout(
				() => {
					if (!this.pending.has(requestId)) return;
					this.readTimeouts = {
						count: (this.readTimeouts?.count ?? 0) + 1,
						lastAt: new Date().toISOString(),
					};
					this.finishRequest(requestId, {
						status: "unavailable",
						// A genuine timeout of a posted read, worded for the timeout retry class either way.
						reason: budget.operation
							? OPERATION_TIMEOUT_REASON
							: `Transcript read request timed out after ${budget.timeoutMs} ms.`,
					});
				},
				Math.max(0, budget.deadline - Date.now()),
			);
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
				this.finishReady(undefined);
				if (message.change) this.emitIndexChange(message.change);
				break;
			case "coverage":
				this.latestCoverage = message.coverage;
				for (const bump of message.bumps ?? []) this.noteLineageBump(bump);
				if (message.change) this.emitIndexChange(message.change);
				break;
			case "result":
			case "source":
			case "sessions":
			case "lineage":
			case "verify": {
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
		this.finishReady({ status: "unavailable", reason });
		this.finishRequestsFor(worker, { status: "unavailable", reason });
		void worker.terminate().catch(() => undefined);
	}

	/**
	 * This generation's readiness is settled: ready (`undefined`), or ended with its real cause (start or
	 * worker failure, shutdown, re-initialization). Releases `waitUntilReady` and every read waiting for it.
	 */
	private finishReady(outcome: TranscriptReadUnavailable | undefined): void {
		const resolve = this.resolveReady;
		this.resolveReady = undefined;
		resolve?.();
		for (const waiter of [...this.readinessWaiters]) waiter.settle(outcome);
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
		this.startRequest = undefined;
		this.ready = false;
		this.latestCoverage = undefined;
		this.queuedIngests.clear();
		// Sequences and revisions belong to the generation that ends here.
		this.ingestSeq = 0;
		this.lastIngestSeq.clear();
		this.lineageBumps.clear();
		this.finishReady({ status: "unavailable", reason: SHUT_DOWN_REASON });
		if (worker) this.finishRequestsFor(worker, { status: "unavailable", reason: SHUT_DOWN_REASON });
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
