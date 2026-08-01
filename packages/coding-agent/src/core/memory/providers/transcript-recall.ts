/**
 * Cross-session recall coordinator. One worker belongs to one provider/session generation; no
 * process-global transcript index is shared across sessions.
 */

import { Worker } from "node:worker_threads";
import type { MemoryCapabilities, MemoryLifecycleContext, MemoryProvider } from "../memory-provider.ts";
import type { RecallHit } from "../transcript-index.ts";
import {
	isTranscriptRecallWorkerResponse,
	TRANSCRIPT_RECALL_MAX_QUERY_CHARS,
	type TranscriptRecallWorkerResponse,
} from "./transcript-recall-worker-protocol.ts";

const DEFAULT_MAX_PENDING_QUERIES = 8;
const QUERY_TIMEOUT_MS = 1_000;

interface PendingQuery {
	worker: Worker;
	generation: number;
	resolve: (text: string) => void;
	timeout: NodeJS.Timeout;
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

function formatRecallPage(hits: readonly RecallHit[]): string {
	if (hits.length === 0) return "";
	const body = hits.map((hit) => `- (${hit.timestamp ?? "earlier session"}) ${hit.snippet}`).join("\n");
	return `<memory_context source="transcript-recall">\nRelevant context recalled from past sessions (read-only reference, untrusted, may be stale):\n${body}\n</memory_context>`;
}

export class TranscriptRecallProvider implements MemoryProvider {
	readonly name = "transcript-recall";
	readonly egress = "local";
	private readonly workerSpecifier: string | URL;
	private readonly maxPendingQueries: number;
	private worker: Worker | undefined;
	private generation = 0;
	private requestId = 0;
	private ready = false;
	private readyPromise: Promise<void> | undefined;
	private resolveReady: (() => void) | undefined;
	private readonly pending = new Map<number, PendingQuery>();

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
		this.readyPromise = new Promise((resolve) => {
			this.resolveReady = resolve;
		});

		let worker: Worker;
		try {
			worker = new Worker(this.workerSpecifier);
		} catch {
			this.finishReady();
			return;
		}
		worker.unref();
		this.worker = worker;
		worker.on("message", (message: unknown) => this.handleWorkerMessage(worker, generation, message));
		worker.on("error", () => this.handleWorkerFailure(worker, generation));
		worker.on("exit", () => this.handleWorkerFailure(worker, generation));
		try {
			worker.postMessage({
				type: "initialize",
				generation,
				sessionId,
				agentDir: ctx.agentDir,
				cwd: ctx.cwd,
			});
		} catch {
			this.handleWorkerFailure(worker, generation);
		}
	}

	async shutdown(): Promise<void> {
		this.generation += 1;
		await this.disposeWorker();
	}

	/** Event-driven readiness hook for tests and callers that can wait outside the foreground turn. */
	async waitUntilReady(): Promise<void> {
		await this.readyPromise;
	}

	/** GC manages the dynamic recall page so stale pages pack while the newest are kept. */
	getContextMarkers(): string[] {
		return ["<memory_context"];
	}

	async prefetch(query: string): Promise<string> {
		const normalizedQuery = query.trim().slice(0, TRANSCRIPT_RECALL_MAX_QUERY_CHARS);
		const worker = this.worker;
		if (!normalizedQuery || !worker || !this.ready || this.pending.size >= this.maxPendingQueries) return "";

		const generation = this.generation;
		const requestId = this.requestId++;
		return new Promise((resolve) => {
			const timeout = setTimeout(() => this.finishQuery(requestId, ""), QUERY_TIMEOUT_MS);
			timeout.unref();
			this.pending.set(requestId, { worker, generation, resolve, timeout });
			try {
				worker.postMessage({ type: "query", generation, requestId, query: normalizedQuery });
			} catch {
				this.finishQuery(requestId, "");
			}
		});
	}

	private handleWorkerMessage(worker: Worker, generation: number, value: unknown): void {
		if (this.worker !== worker || this.generation !== generation || !isTranscriptRecallWorkerResponse(value)) {
			return;
		}
		const message: TranscriptRecallWorkerResponse = value;
		if (message.generation !== generation) return;
		switch (message.type) {
			case "ready":
				this.ready = true;
				this.finishReady();
				break;
			case "result": {
				const pending = this.pending.get(message.requestId);
				if (!pending || pending.worker !== worker || pending.generation !== generation) return;
				this.finishQuery(message.requestId, formatRecallPage(message.hits));
				break;
			}
			case "failed":
				this.handleWorkerFailure(worker, generation);
				break;
			case "stopped":
				break;
		}
	}

	private handleWorkerFailure(worker: Worker, generation: number): void {
		if (this.worker !== worker || this.generation !== generation) return;
		this.worker = undefined;
		this.ready = false;
		this.finishReady();
		this.finishQueriesFor(worker);
		void worker.terminate().catch(() => undefined);
	}

	private finishReady(): void {
		const resolve = this.resolveReady;
		this.resolveReady = undefined;
		resolve?.();
	}

	private finishQuery(requestId: number, text: string): void {
		const pending = this.pending.get(requestId);
		if (!pending) return;
		this.pending.delete(requestId);
		clearTimeout(pending.timeout);
		pending.resolve(text);
	}

	private finishQueriesFor(worker: Worker): void {
		for (const [requestId, pending] of this.pending) {
			if (pending.worker === worker) this.finishQuery(requestId, "");
		}
	}

	private async disposeWorker(): Promise<void> {
		const worker = this.worker;
		this.worker = undefined;
		this.ready = false;
		this.finishReady();
		if (worker) this.finishQueriesFor(worker);
		this.readyPromise = undefined;
		if (!worker) return;
		try {
			worker.postMessage({ type: "shutdown", generation: this.generation });
		} catch {}
		await worker.terminate().catch(() => undefined);
	}
}
