import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai";
import {
	createToolValidationFailureCorpusRecord,
	type ToolValidationFailureShapeEntry,
	writeFailureCorpusRecord,
} from "./failure-corpus.ts";
import { updatePersistedToolRecoveryStats } from "./tool-recovery-stats.ts";
import { appendBoundedJsonLineSync, type BoundedJsonlLimits } from "./util/bounded-jsonl.ts";

export const TOOL_RECOVERY_EVENT_LOG_FILE = "tool-recovery-events.jsonl";
export const TOOL_ARGUMENT_VALIDATION_LOG_KIND = "tool_argument_validation";

const TOOL_RECOVERY_EVENT_LIMITS: BoundedJsonlLimits = {
	maxBytes: 4 * 1024 * 1024,
	targetBytes: Math.floor(4 * 1024 * 1024 * 0.75),
	maxRecords: 5_000,
};
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

/**
 * Append + rotate under a single exclusive lock on `eventLogPath`. Without the lock, a concurrent
 * writer (e.g. another session's tool-recovery worker) could append between this call's read and its
 * rotated rewrite, and that append would be silently discarded when the rewrite lands. The shared
 * bounded JSONL sink also uses atomic tmp+rename rotation so readers never observe torn log files.
 */
export function writeToolRecoveryLogRecord(entry: ToolRecoveryLogWorkerRecord): void {
	appendBoundedJsonLineSync(entry.eventLogPath, entry.record, TOOL_RECOVERY_EVENT_LIMITS);
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
