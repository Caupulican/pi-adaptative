import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai";
import {
	createToolValidationFailureCorpusRecord,
	type ToolValidationFailureShapeEntry,
	writeFailureCorpusRecord,
} from "./failure-corpus.ts";

export const TOOL_RECOVERY_EVENT_LOG_FILE = "tool-recovery-events.jsonl";
export const TOOL_ARGUMENT_VALIDATION_LOG_KIND = "tool_argument_validation";

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

function copyFailureShape(
	shape: readonly ToolValidationFailureShapeEntry[] | undefined,
): ToolValidationFailureShapeEntry[] {
	return (shape ?? []).map((entry) => ({
		path: entry.path,
		expectedType: entry.expectedType,
		receivedType: entry.receivedType,
		...(entry.keyword ? { keyword: entry.keyword } : {}),
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
		failureModes: [...args.event.failureModes],
		repairsApplied: [...args.event.repairsApplied],
		failureShape: copyFailureShape(args.event.failureShape),
		errorKeywords: args.event.errorKeywords ? [...args.event.errorKeywords] : undefined,
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

export function writeToolRecoveryLogRecord(entry: ToolRecoveryLogWorkerRecord): void {
	mkdirSync(dirname(entry.eventLogPath), { recursive: true });
	appendFileSync(entry.eventLogPath, `${JSON.stringify(entry.record)}\n`, "utf-8");
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
