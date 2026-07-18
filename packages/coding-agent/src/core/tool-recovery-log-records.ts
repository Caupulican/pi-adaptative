import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai";
import {
	createToolValidationFailureCorpusRecord,
	type ToolValidationFailureShapeEntry,
	writeFailureCorpusRecord,
} from "./failure-corpus.ts";
import { updatePersistedToolRecoveryStats } from "./tool-recovery-stats.ts";
import { withFileLockSync, writeFileAtomicSync } from "./util/atomic-file.ts";

export const TOOL_RECOVERY_EVENT_LOG_FILE = "tool-recovery-events.jsonl";
export const TOOL_ARGUMENT_VALIDATION_LOG_KIND = "tool_argument_validation";

const MAX_EVENT_LOG_BYTES = 4 * 1024 * 1024;
const ROTATED_EVENT_LOG_TARGET_BYTES = Math.floor(MAX_EVENT_LOG_BYTES * 0.75);
const MAX_ROTATED_EVENT_LOG_RECORDS = 5_000;
const MAX_TELEMETRY_LIST_ITEMS = 50;
const MAX_TELEMETRY_TEXT_CHARS = 256;

export interface ToolArgumentValidationLogRecord extends ToolArgumentValidationTelemetryEvent {
	kind: typeof TOOL_ARGUMENT_VALIDATION_LOG_KIND;
	version: 1;
	recordId: string;
	ts: string;
	sessionId: string;
}

export interface ToolRecoveryLogWorkerRecord {
	eventLogPath: string;
	failureCorpusPath: string;
	record: ToolArgumentValidationLogRecord;
}

function boundedText(value: string): string {
	return value.slice(0, MAX_TELEMETRY_TEXT_CHARS);
}

function boundedList<T extends string>(values: readonly T[] | undefined): T[] | undefined {
	return values?.slice(0, MAX_TELEMETRY_LIST_ITEMS);
}

function boundedTextList(values: readonly string[] | undefined): string[] | undefined {
	return values?.slice(0, MAX_TELEMETRY_LIST_ITEMS).map(boundedText);
}

function copyFailureShape(
	shape: readonly ToolValidationFailureShapeEntry[] | undefined,
): ToolValidationFailureShapeEntry[] {
	return (shape ?? []).slice(0, MAX_TELEMETRY_LIST_ITEMS).map((entry) => ({
		path: boundedText(entry.path),
		expectedType: boundedText(entry.expectedType),
		receivedType: boundedText(entry.receivedType),
		...(entry.keyword ? { keyword: boundedText(entry.keyword) } : {}),
	}));
}

export function createToolArgumentValidationLogRecord(args: {
	event: ToolArgumentValidationTelemetryEvent;
	recordId: string;
	sessionId: string;
	ts: string;
}): ToolArgumentValidationLogRecord {
	return {
		kind: TOOL_ARGUMENT_VALIDATION_LOG_KIND,
		version: 1,
		recordId: args.recordId,
		ts: args.ts,
		sessionId: args.sessionId,
		outcome: args.event.outcome,
		provider: args.event.provider,
		model: args.event.model,
		tool: args.event.tool,
		source: args.event.source,
		failureModes: boundedList(args.event.failureModes) ?? [],
		repairsApplied: boundedList(args.event.repairsApplied) ?? [],
		failureShape: copyFailureShape(args.event.failureShape),
		errorKeywords: boundedTextList(args.event.errorKeywords),
		taught: args.event.taught,
		executionOutcome: args.event.executionOutcome,
	};
}

export function isToolArgumentValidationLogRecord(value: unknown): value is ToolArgumentValidationLogRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ToolArgumentValidationLogRecord>;
	return (
		record.kind === TOOL_ARGUMENT_VALIDATION_LOG_KIND &&
		record.version === 1 &&
		typeof record.recordId === "string" &&
		typeof record.ts === "string" &&
		typeof record.sessionId === "string" &&
		(record.outcome === "repaired" || record.outcome === "bounced") &&
		typeof record.tool === "string" &&
		Array.isArray(record.failureModes) &&
		Array.isArray(record.repairsApplied)
	);
}

function rotateToolRecoveryEventLogIfNeeded(filePath: string): void {
	if (!existsSync(filePath) || statSync(filePath).size <= MAX_EVENT_LOG_BYTES) return;
	const lines = readFileSync(filePath, "utf-8")
		.split("\n")
		.filter((line) => line.trim().length > 0);
	const retained: string[] = [];
	let retainedBytes = 0;
	for (let index = lines.length - 1; index >= 0 && retained.length < MAX_ROTATED_EVENT_LOG_RECORDS; index--) {
		const line = lines[index];
		const lineBytes = Buffer.byteLength(line, "utf-8") + 1;
		if (lineBytes > MAX_EVENT_LOG_BYTES) continue;
		if (retained.length > 0 && retainedBytes + lineBytes > ROTATED_EVENT_LOG_TARGET_BYTES) break;
		retained.push(line);
		retainedBytes += lineBytes;
		if (retainedBytes >= ROTATED_EVENT_LOG_TARGET_BYTES) break;
	}
	retained.reverse();
	writeFileAtomicSync(filePath, retained.length > 0 ? `${retained.join("\n")}\n` : "");
}

/**
 * Append + rotate under a single exclusive lock on `eventLogPath`. Without the lock, a concurrent
 * writer (e.g. another session's tool-recovery worker) could append between this call's read and its
 * rotated rewrite, and that append would be silently discarded when the rewrite lands; the atomic
 * tmp+rename in {@link rotateToolRecoveryEventLogIfNeeded} additionally ensures a reader never observes
 * a partially-rewritten (torn) log file.
 */
export function writeToolRecoveryLogRecord(entry: ToolRecoveryLogWorkerRecord): void {
	withFileLockSync(entry.eventLogPath, () => {
		appendFileSync(entry.eventLogPath, `${JSON.stringify(entry.record)}\n`, "utf-8");
		rotateToolRecoveryEventLogIfNeeded(entry.eventLogPath);
	});
	try {
		updatePersistedToolRecoveryStats(entry.eventLogPath, entry.record);
	} catch {
		// The bounded event log remains the recovery source if the cumulative summary cannot be updated.
	}
	if (entry.record.outcome !== "bounced") return;
	writeFailureCorpusRecord(
		entry.failureCorpusPath,
		createToolValidationFailureCorpusRecord({
			ts: entry.record.ts,
			provider: entry.record.provider,
			modelId: entry.record.model,
			tool: entry.record.tool,
			failureModes: entry.record.failureModes,
			shape: copyFailureShape(entry.record.failureShape),
			errorKeywords: entry.record.errorKeywords,
		}),
	);
}
