import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	createToolArgumentValidationLogRecord,
	writeToolRecoveryLogRecord,
} from "../src/core/tool-recovery-log-records.ts";
import { ToolRecoveryLogger } from "../src/core/tool-recovery-logger.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-tool-recovery-"));
	tempDirs.push(dir);
	return dir;
}

function createEvent(outcome: "clean" | "repaired" | "bounced"): ToolArgumentValidationTelemetryEvent {
	return {
		outcome,
		provider: "test-provider",
		model: "test-model",
		tool: "edit",
		failureModes: outcome === "clean" ? [] : ["jsonStringParse"],
		repairsApplied: outcome === "repaired" ? ["jsonStringParse"] : [],
		failureShape:
			outcome === "bounced"
				? [{ path: "edits", expectedType: "array", receivedType: "string", keyword: "type" }]
				: undefined,
		errorKeywords: outcome === "bounced" ? ["type"] : undefined,
		taught: "none",
		executionOutcome: outcome === "repaired" ? "succeeded" : "not_run",
	};
}

function createLogger(dir: string, options?: { enabled?: boolean; maxQueue?: number; workerSpecifier?: string | URL }) {
	return new ToolRecoveryLogger({
		enabled: options?.enabled ?? true,
		sessionId: "session-1",
		eventLogPath: join(dir, "state", "tool-recovery-events.jsonl"),
		failureCorpusPath: join(dir, "state", "failure-corpus.jsonl"),
		maxQueue: options?.maxQueue,
		batchSize: 1,
		workerSpecifier: options?.workerSpecifier,
		now: () => new Date("2026-07-08T00:00:00Z"),
	});
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("ToolRecoveryLogger", () => {
	it("does not spawn or write when disabled", async () => {
		const dir = makeTempDir();
		const logger = createLogger(dir, { enabled: false });

		expect(logger.recordToolArgumentValidation(createEvent("repaired"))).toBeUndefined();
		await logger.flush();

		expect(existsSync(join(dir, "state", "tool-recovery-events.jsonl"))).toBe(false);
		expect(existsSync(join(dir, "state", "failure-corpus.jsonl"))).toBe(false);
		expect(logger.getStats().workerStarts).toBe(0);
	});

	it("does not spawn or write for a clean validation event", async () => {
		const dir = makeTempDir();
		const logger = createLogger(dir);

		expect(logger.recordToolArgumentValidation(createEvent("clean"))).toBeUndefined();
		await logger.flush();

		expect(existsSync(join(dir, "state", "tool-recovery-events.jsonl"))).toBe(false);
		expect(logger.getStats().workerStarts).toBe(0);
	});

	it("writes repaired recovery records after drain", async () => {
		const dir = makeTempDir();
		const logger = createLogger(dir);

		const record = logger.recordToolArgumentValidation(createEvent("repaired"));
		expect(record?.recordId).toBe("session-1:0");
		await logger.flush(1_000);

		const lines = readFileSync(join(dir, "state", "tool-recovery-events.jsonl"), "utf-8")
			.trim()
			.split("\n");
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0]) as unknown).toMatchObject({
			kind: "tool_argument_validation",
			outcome: "repaired",
			repairsApplied: ["jsonStringParse"],
		});
		expect(existsSync(join(dir, "state", "failure-corpus.jsonl"))).toBe(false);
	});

	it("writes bounced shapes to the failure corpus without argument values", async () => {
		const dir = makeTempDir();
		const logger = createLogger(dir);

		logger.recordToolArgumentValidation(createEvent("bounced"));
		await logger.flush(1_000);

		const corpus = JSON.parse(readFileSync(join(dir, "state", "failure-corpus.jsonl"), "utf-8").trim()) as unknown;
		expect(corpus).toMatchObject({
			kind: "tool_validation",
			tool: "edit",
			shape: [{ path: "edits", expectedType: "array", receivedType: "string", keyword: "type" }],
		});
		expect(JSON.stringify(corpus)).not.toContain("oldText");
	});

	it("bounds queued records and counts dropped entries", async () => {
		const dir = makeTempDir();
		const workerPath = join(dir, "stall-worker.mjs");
		writeFileSync(
			workerPath,
			"import { parentPort } from 'node:worker_threads';\nparentPort.on('message', () => {});\n",
			"utf-8",
		);
		const logger = createLogger(dir, { maxQueue: 1, workerSpecifier: pathToFileURL(workerPath) });

		logger.recordToolArgumentValidation(createEvent("repaired"));
		logger.recordToolArgumentValidation(createEvent("repaired"));
		logger.recordToolArgumentValidation(createEvent("repaired"));
		await logger.flush(10);

		expect(logger.getStats().dropped).toBeGreaterThan(0);
		expect((logger as unknown as { flushWaiters: unknown[] }).flushWaiters).toHaveLength(0);
		await logger.shutdown(10);
	});

	it("ignores a crashed worker's later exit and protects the replacement batch", async () => {
		const dir = makeTempDir();
		const workerPath = join(dir, "crash-once-worker.mjs");
		writeFileSync(
			workerPath,
			`import { existsSync, writeFileSync } from "node:fs";
import { parentPort } from "node:worker_threads";
const marker = ${JSON.stringify(join(dir, "worker-started"))};
if (!existsSync(marker)) {
  writeFileSync(marker, "1");
  parentPort.on("message", (message) => {
    if (message?.type === "records") setTimeout(() => { throw new Error("first worker crash"); }, 10);
  });
} else {
  parentPort.on("message", (message) => {
    if (message?.type === "records") setTimeout(() => parentPort.postMessage({ type: "ack", batchId: message.batchId, written: message.records.length, failed: 0 }), 100);
  });
}
`,
			"utf-8",
		);
		const logger = createLogger(dir, { workerSpecifier: pathToFileURL(workerPath) });
		logger.recordToolArgumentValidation(createEvent("repaired"));
		logger.recordToolArgumentValidation(createEvent("repaired"));
		logger.recordToolArgumentValidation(createEvent("repaired"));

		await logger.flush(2_000);

		expect(logger.getStats()).toMatchObject({
			queued: 0,
			inFlight: 0,
			dropped: 1,
			workerStarts: 2,
			workerCrashes: 1,
			respawns: 1,
		});
		await logger.shutdown(100);
	});

	it("bounds telemetry record arrays and strings before retaining or persisting them", () => {
		const oversized = createEvent("bounced");
		oversized.failureModes = Array.from({ length: 60 }, () => "jsonStringParse" as const);
		oversized.repairsApplied = Array.from({ length: 60 }, () => "jsonStringParse" as const);
		oversized.errorKeywords = Array.from({ length: 60 }, (_, index) => `${index}-${"z".repeat(300)}`);
		oversized.failureShape = Array.from({ length: 60 }, (_, index) => ({
			path: `${index}-${"p".repeat(300)}`,
			expectedType: "e".repeat(300),
			receivedType: "r".repeat(300),
		}));

		const record = createToolArgumentValidationLogRecord({
			event: oversized,
			recordId: "session-1:0",
			sessionId: "session-1",
			ts: "2026-07-08T00:00:00Z",
		});

		expect(record.failureModes).toHaveLength(50);
		expect(record.repairsApplied).toHaveLength(50);
		expect(record.errorKeywords).toHaveLength(50);
		expect(record.failureShape).toHaveLength(50);
		expect(record.errorKeywords?.every((value) => value.length <= 256)).toBe(true);
		expect(record.failureShape?.every((value) => value.path.length <= 256)).toBe(true);
	});

	it("rotates an oversized event log to a low-water mark instead of rewriting on every record", () => {
		const dir = makeTempDir();
		const eventLogPath = join(dir, "state", "tool-recovery-events.jsonl");
		const failureCorpusPath = join(dir, "state", "failure-corpus.jsonl");
		mkdirSync(join(dir, "state"), { recursive: true });
		const oversized = createEvent("repaired");
		oversized.failureModes = Array.from({ length: 60 }, () => "jsonStringParse" as const);
		oversized.repairsApplied = Array.from({ length: 60 }, () => "jsonStringParse" as const);
		oversized.errorKeywords = Array.from({ length: 60 }, (_, index) => `${index}-${"z".repeat(300)}`);
		oversized.failureShape = Array.from({ length: 60 }, (_, index) => ({
			path: `${index}-${"p".repeat(300)}`,
			expectedType: "e".repeat(300),
			receivedType: "r".repeat(300),
		}));
		const record = createToolArgumentValidationLogRecord({
			event: oversized,
			recordId: "session-1:0",
			sessionId: "session-1",
			ts: "2026-07-08T00:00:00Z",
		});
		const encoded = `${JSON.stringify(record)}\n`;
		writeFileSync(eventLogPath, encoded.repeat(Math.ceil((5 * 1024 * 1024) / Buffer.byteLength(encoded))), "utf-8");

		writeToolRecoveryLogRecord({ eventLogPath, failureCorpusPath, record });
		const rotatedSize = statSync(eventLogPath).size;
		writeToolRecoveryLogRecord({ eventLogPath, failureCorpusPath, record });

		expect(rotatedSize).toBeLessThanOrEqual(Math.floor(4 * 1024 * 1024 * 0.75));
		expect(statSync(eventLogPath).size).toBe(rotatedSize + Buffer.byteLength(encoded));
		// Rotation rewrites via tmp+rename — no leftover tmp file after a completed rotation.
		expect(existsSync(`${eventLogPath}.tmp`)).toBe(false);
	});

	/**
	 * Two REAL OS threads appending (and, for one of them, rotating) the SAME event log
	 * concurrently must not tear a line or lose a record — `writeToolRecoveryLogRecord` now runs its
	 * append+rotate under one exclusive lock on `eventLogPath` instead of racing unlocked appends
	 * against an in-place (non-atomic) rotation rewrite.
	 */
	it("two OS threads writing the same event log concurrently never tear or lose a record", async () => {
		const dir = makeTempDir();
		const eventLogPath = join(dir, "state", "tool-recovery-events.jsonl");
		const failureCorpusPath = join(dir, "state", "failure-corpus.jsonl");
		mkdirSync(join(dir, "state"), { recursive: true });

		const modulePath = new URL("../src/core/tool-recovery-log-records.ts", import.meta.url).pathname;
		const workerPath = join(dir, "recovery-log-worker.mjs");
		writeFileSync(
			workerPath,
			`import { createToolArgumentValidationLogRecord, writeToolRecoveryLogRecord } from ${JSON.stringify(modulePath)};
import { parentPort, workerData } from "node:worker_threads";
const { eventLogPath, failureCorpusPath, workerId, iterations } = workerData;
for (let i = 0; i < iterations; i++) {
	const record = createToolArgumentValidationLogRecord({
		event: {
			outcome: "repaired",
			provider: "test-provider",
			model: "test-model",
			tool: "edit",
			failureModes: ["jsonStringParse"],
			repairsApplied: ["jsonStringParse"],
			taught: "none",
			executionOutcome: "succeeded",
		},
		recordId: \`w\${workerId}:\${i}\`,
		sessionId: "session-1",
		ts: "2026-07-08T00:00:00Z",
	});
	writeToolRecoveryLogRecord({ eventLogPath, failureCorpusPath, record });
}
parentPort.postMessage({ done: true });
`,
			"utf-8",
		);

		const iterationsPerWorker = 40;
		const workers = [1, 2].map(
			(workerId) =>
				new Worker(pathToFileURL(workerPath), {
					workerData: { eventLogPath, failureCorpusPath, workerId, iterations: iterationsPerWorker },
				}),
		);
		await Promise.all(
			workers.map(
				(worker) =>
					new Promise<void>((resolve, reject) => {
						worker.on("message", () => resolve());
						worker.on("error", reject);
					}),
			),
		);
		await Promise.all(workers.map((worker) => worker.terminate()));

		const lines = readFileSync(eventLogPath, "utf-8")
			.trim()
			.split("\n")
			.filter((line) => line.length > 0);
		// Every line parses as JSON — a torn/interleaved write would produce a malformed line here.
		const recordIds = lines.map((line) => (JSON.parse(line) as { recordId: string }).recordId);
		expect(recordIds).toHaveLength(iterationsPerWorker * 2);
		expect(new Set(recordIds).size).toBe(iterationsPerWorker * 2); // no duplicate/corrupted entries
	}, 20_000);

	it("contains worker write failures without throwing into the caller", async () => {
		const dir = makeTempDir();
		writeFileSync(join(dir, "state"), "not a directory", "utf-8");
		const logger = new ToolRecoveryLogger({
			enabled: true,
			sessionId: "session-1",
			eventLogPath: join(dir, "state", "tool-recovery-events.jsonl"),
			failureCorpusPath: join(dir, "state", "failure-corpus.jsonl"),
			batchSize: 1,
			now: () => new Date("2026-07-08T00:00:00Z"),
		});

		expect(() => logger.recordToolArgumentValidation(createEvent("repaired"))).not.toThrow();
		await logger.flush(1_000);

		expect(logger.getStats().failures).toBeGreaterThan(0);
		await logger.shutdown(10);
	});
});
