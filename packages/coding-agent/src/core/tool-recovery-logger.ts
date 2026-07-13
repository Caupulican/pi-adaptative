import { Worker } from "node:worker_threads";
import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai";
import {
	createToolArgumentValidationLogRecord,
	type ToolArgumentValidationLogRecord,
	type ToolRecoveryLogWorkerRecord,
} from "./tool-recovery-log-records.ts";

interface ToolRecoveryLogAckMessage {
	type: "ack";
	batchId: number;
	written: number;
	failed: number;
}

export interface ToolRecoveryLoggerStats {
	enabled: boolean;
	queued: number;
	inFlight: number;
	dropped: number;
	failures: number;
	workerStarts: number;
	workerCrashes: number;
	respawns: number;
}

export interface ToolRecoveryLoggerOptions {
	enabled: boolean;
	sessionId: string;
	eventLogPath: string;
	failureCorpusPath: string;
	maxQueue?: number;
	batchSize?: number;
	now?: () => Date;
	debug?: (message: string) => void;
	workerSpecifier?: string | URL;
}

const DEFAULT_MAX_QUEUE = 1000;
const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_FLUSH_TIMEOUT_MS = 200;

function isToolRecoveryLogAckMessage(value: unknown): value is ToolRecoveryLogAckMessage {
	if (!value || typeof value !== "object") return false;
	const message = value as Partial<ToolRecoveryLogAckMessage>;
	return (
		message.type === "ack" &&
		typeof message.batchId === "number" &&
		typeof message.written === "number" &&
		typeof message.failed === "number"
	);
}

function createDefaultWorkerSpecifier(): URL {
	const isTypeScriptRuntime = import.meta.url.endsWith(".ts");
	return new URL(
		isTypeScriptRuntime ? "./tool-recovery-log-worker.ts" : "./tool-recovery-log-worker.js",
		import.meta.url,
	);
}

export class ToolRecoveryLogger {
	private readonly enabled: boolean;
	private readonly sessionId: string;
	private readonly eventLogPath: string;
	private readonly failureCorpusPath: string;
	private readonly maxQueue: number;
	private readonly batchSize: number;
	private readonly now: () => Date;
	private readonly debug: (message: string) => void;
	private readonly workerSpecifier: string | URL;
	private readonly queue: ToolRecoveryLogWorkerRecord[] = [];
	private readonly flushWaiters: Array<() => void> = [];
	private worker: Worker | undefined;
	private inFlight: ToolRecoveryLogWorkerRecord[] = [];
	private batchId = 0;
	private recordSequence = 0;
	private dropped = 0;
	private failures = 0;
	private workerStarts = 0;
	private workerCrashes = 0;
	private respawns = 0;
	private respawnAttempted = false;
	private shuttingDown = false;

	constructor(options: ToolRecoveryLoggerOptions) {
		this.enabled = options.enabled;
		this.sessionId = options.sessionId;
		this.eventLogPath = options.eventLogPath;
		this.failureCorpusPath = options.failureCorpusPath;
		this.maxQueue = options.maxQueue ?? DEFAULT_MAX_QUEUE;
		this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
		this.now = options.now ?? (() => new Date());
		this.debug = options.debug ?? (() => {});
		this.workerSpecifier = options.workerSpecifier ?? createDefaultWorkerSpecifier();
	}

	recordToolArgumentValidation(
		event: ToolArgumentValidationTelemetryEvent,
	): ToolArgumentValidationLogRecord | undefined {
		if (!this.enabled || event.outcome === "clean") return undefined;
		const record = createToolArgumentValidationLogRecord({
			event,
			recordId: `${this.sessionId}:${this.recordSequence++}`,
			sessionId: this.sessionId,
			ts: this.now().toISOString(),
		});
		this.enqueue({ eventLogPath: this.eventLogPath, failureCorpusPath: this.failureCorpusPath, record });
		return record;
	}

	getStats(): ToolRecoveryLoggerStats {
		return {
			enabled: this.enabled,
			queued: this.queue.length,
			inFlight: this.inFlight.length,
			dropped: this.dropped,
			failures: this.failures,
			workerStarts: this.workerStarts,
			workerCrashes: this.workerCrashes,
			respawns: this.respawns,
		};
	}

	flush(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
		if (!this.enabled || (!this.worker && this.queue.length === 0 && this.inFlight.length === 0)) {
			return Promise.resolve();
		}
		this.pump();
		return new Promise((resolve) => {
			let settled = false;
			let timeout: NodeJS.Timeout;
			const finish = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			const waiter = (): void => {
				clearTimeout(timeout);
				finish();
			};
			timeout = setTimeout(() => {
				const index = this.flushWaiters.indexOf(waiter);
				if (index !== -1) this.flushWaiters.splice(index, 1);
				finish();
			}, timeoutMs);
			this.flushWaiters.push(waiter);
			this.resolveFlushWaitersIfIdle();
		});
	}

	async shutdown(timeoutMs: number = DEFAULT_FLUSH_TIMEOUT_MS): Promise<void> {
		await this.flush(timeoutMs);
		this.shuttingDown = true;
		const worker = this.worker;
		this.worker = undefined;
		if (!worker) return;
		try {
			worker.postMessage({ type: "shutdown" });
		} catch {}
		void worker.terminate().catch(() => undefined);
	}

	private enqueue(record: ToolRecoveryLogWorkerRecord): void {
		if (!this.enabled) return;
		this.queue.push(record);
		while (this.queue.length > this.maxQueue) {
			this.queue.shift();
			this.dropped++;
		}
		this.pump();
	}

	private pump(): void {
		if (!this.enabled || this.shuttingDown || this.inFlight.length > 0 || this.queue.length === 0) return;
		const worker = this.ensureWorker();
		if (!worker) return;
		const records = this.queue.splice(0, this.batchSize);
		this.inFlight = records;
		const batchId = this.batchId++;
		try {
			worker.postMessage({ type: "records", batchId, records });
		} catch (error) {
			this.failures++;
			this.dropped += records.length;
			this.inFlight = [];
			this.debug(`tool recovery logger post failed: ${error instanceof Error ? error.message : String(error)}`);
			this.resolveFlushWaitersIfIdle();
		}
	}

	private ensureWorker(): Worker | undefined {
		if (this.worker) return this.worker;
		try {
			const worker = new Worker(this.workerSpecifier);
			worker.unref();
			this.worker = worker;
			this.workerStarts++;
			worker.on("message", (message: unknown) => this.handleWorkerMessage(message));
			worker.on("error", (error) => this.handleWorkerFailure(error));
			worker.on("exit", (code) => {
				if (this.shuttingDown || code === 0) return;
				this.handleWorkerFailure(new Error(`tool recovery logger worker exited with code ${code}`));
			});
			return worker;
		} catch (error) {
			this.failures++;
			this.debug(
				`tool recovery logger worker start failed: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
	}

	private handleWorkerMessage(message: unknown): void {
		if (!isToolRecoveryLogAckMessage(message)) return;
		if (message.failed > 0) {
			this.failures += message.failed;
		}
		this.inFlight = [];
		this.pump();
		this.resolveFlushWaitersIfIdle();
	}

	private handleWorkerFailure(error: Error): void {
		this.failures++;
		this.workerCrashes++;
		this.dropped += this.inFlight.length;
		this.inFlight = [];
		this.worker = undefined;
		this.debug(`tool recovery logger worker failed: ${error.message}`);
		if (!this.respawnAttempted && !this.shuttingDown) {
			this.respawnAttempted = true;
			this.respawns++;
			this.pump();
		}
		this.resolveFlushWaitersIfIdle();
	}

	private resolveFlushWaitersIfIdle(): void {
		if (this.queue.length > 0 || this.inFlight.length > 0) return;
		const waiters = this.flushWaiters.splice(0);
		for (const waiter of waiters) waiter();
	}
}
