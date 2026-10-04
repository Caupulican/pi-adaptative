import type { ToolArgumentValidationTelemetryEvent } from "@caupulican/pi-ai";
import type { ToolFailurePhase } from "@caupulican/pi-ai/tool-repair-registry";

export const TOOL_ARGUMENT_VALIDATION_LOG_KIND = "tool_argument_validation";
export const TOOL_EXECUTION_FAILURE_LOG_KIND = "tool_execution_failure";

export interface ToolArgumentValidationLogRecord extends ToolArgumentValidationTelemetryEvent {
	kind: typeof TOOL_ARGUMENT_VALIDATION_LOG_KIND;
	version: 1;
	recordId: string;
	ts: string;
	sessionId: string;
}

export interface ToolExecutionFailureLogRecord {
	kind: typeof TOOL_EXECUTION_FAILURE_LOG_KIND;
	version: 1;
	recordId: string;
	ts: string;
	sessionId: string;
	provider?: string;
	model?: string;
	tool: string;
	state: "failed" | "rejected";
	phase: ToolFailurePhase;
	failureCode: string;
	diagnostic?: string;
	nextAction: string;
}

export type ToolRecoveryLogRecord = ToolArgumentValidationLogRecord | ToolExecutionFailureLogRecord;

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

export function isToolExecutionFailureLogRecord(value: unknown): value is ToolExecutionFailureLogRecord {
	if (!value || typeof value !== "object") return false;
	const record = value as Partial<ToolExecutionFailureLogRecord>;
	return (
		record.kind === TOOL_EXECUTION_FAILURE_LOG_KIND &&
		record.version === 1 &&
		typeof record.recordId === "string" &&
		typeof record.ts === "string" &&
		typeof record.sessionId === "string" &&
		typeof record.tool === "string" &&
		(record.state === "failed" || record.state === "rejected") &&
		typeof record.phase === "string" &&
		typeof record.failureCode === "string" &&
		typeof record.nextAction === "string"
	);
}
