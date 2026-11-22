import { isRecord } from "@caupulican/pi-ai";
import type { ToolResultMessage } from "@caupulican/pi-ai/types";
import type { ToolFailureMemoryRecord } from "./tool-failure-memory.ts";

const MAX_FAILURE_CODE_CHARS = 48;

/** Accept the canonical ASCII code and its existing terminal truncation marker. */
export function isBoundedFailureCode(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= MAX_FAILURE_CODE_CHARS &&
		/^[a-z0-9_.:-]+(?:…)?$/.test(value)
	);
}

/** Canonical bounded failure identity shared by recovery memory and executor receipts. */
export function boundedFailureCode(value: string): string {
	const normalized = value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.:-]+/g, "_")
		.replace(/^_+|_+$/g, "");
	const code = normalized || "tool_error";
	return code.length <= MAX_FAILURE_CODE_CHARS ? code : `${code.slice(0, MAX_FAILURE_CODE_CHARS - 1)}…`;
}

/**
 * bash.ts's own trailer (`appendStatus`) always ends the message with a line like "Command
 * exited with code 1"; a structured result (e.g. run_process) instead puts "exitCode: 1" on its
 * own line near the top. Both are anchored to the START of their own line, with at most one
 * leading tool-name token ("Command"/"Python"/...) — ordinary stdout/stderr prose is never
 * anchored that way, so a captured line like "container will exit 0 on SIGTERM" can never be
 * read as the process exit status. Scan from the end of the message so the tool's own trailer —
 * always the last line it appends — outranks any earlier, non-authoritative line that matches.
 */
const EXIT_STATUS_LINE_PATTERN = /^(?:\S+\s+)?(?:exit(?:ed)?(?:\s+with)?(?:\s+code)?|exitcode)\s*[:=]?\s*(-?\d+)\b/i;

export function processExitFailureCode(message: string): string | undefined {
	// comms-legacy-decoder: a tool's failure output is foreign text; its exit status line has no typed field.
	const lines = message.split(/\r\n|\n/);
	for (let index = lines.length - 1; index >= 0; index--) {
		const match = EXIT_STATUS_LINE_PATTERN.exec(lines[index].trim());
		if (match) return boundedFailureCode(`exit_${match[1]}`);
	}
	return undefined;
}

export function classifyToolFailure(message: string, errorClass?: string): string {
	// A tool-owned terminal status is authoritative; stdout may contain arbitrary all-caps identifiers.
	const exitFailureCode = processExitFailureCode(message);
	if (exitFailureCode) return exitFailureCode;
	// comms-legacy-decoder: a tool's failure output is foreign text; an errno name in it has no typed field.
	const errno = /\b(E[A-Z][A-Z0-9_]{2,})\b/.exec(message)?.[1];
	if (errno) return boundedFailureCode(errno);
	return boundedFailureCode(errorClass ?? "tool_error");
}

/**
 * The `failure_code` a `[harness]` result shows. Only for results written without the typed field the
 * decision needs (a transcript older than `piToolFailureReplay`, or a failure result with no retained
 * record); a current result is read through its `details`.
 */
export function readVisibleToolFailureCode(result: ToolResultMessage): string | undefined {
	for (const block of result.content) {
		if (block.type !== "text") continue;
		// comms-legacy-decoder: persisted results that predate the typed replay marker carry the code only in text.
		const match = /"failure_code"\s*:\s*"([^"]+)"/.exec(block.text);
		if (match) return match[1];
	}
	return undefined;
}

/** A compaction admission refusal expires with its context and cannot own a retry. */
export function isSelfCompactionRefusal(
	record: Pick<ToolFailureMemoryRecord, "state" | "phase" | "failureCode" | "diagnostic">,
): boolean {
	return (
		record.state === "rejected" &&
		record.phase === "policy" &&
		(record.failureCode === "self_compaction_pending" ||
			(record.failureCode === "blocked" && isLegacySelfCompactionDiagnostic(record.diagnostic)))
	);
}

function isLegacySelfCompactionDiagnostic(diagnostic: unknown): boolean {
	return (
		typeof diagnostic === "string" &&
		/^Tool "[^"]+" (?:was not run: self_compact is in the same batch,|is refused: (?:a self_compact note is saved and|context is at the forced self-compaction line \())/.test(
			diagnostic,
		)
	);
}

/**
 * Decode a legacy host refusal from the first result line.
 * @deprecated Use the typed self_compaction_pending directive. Remove when transcripts without typed failure details are retired.
 */
export function isLegacySelfCompactionResult(result: ToolResultMessage, execution?: string): boolean {
	if (result.isError !== true || result.errorKind === "operation_outcome") return false;
	if (execution !== undefined && execution !== "not_started") return false;
	const line = firstToolResultText(result).split("\n", 1)[0];
	if (!line.startsWith("[harness] ")) return false;
	try {
		const envelope: unknown = JSON.parse(line.slice("[harness] ".length));
		return (
			isRecord(envelope) &&
			envelope.MUST === true &&
			envelope.state === "rejected" &&
			envelope.phase === "policy" &&
			envelope.tool === result.toolName &&
			(envelope.failure_code === "blocked" || envelope.failure_code === "repeated_failed_operation") &&
			isLegacySelfCompactionDiagnostic(envelope.diagnostic)
		);
	} catch {
		return false;
	}
}

export function firstToolResultText(message: ToolResultMessage): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		for (let index = 0; index < content.length; index++) {
			const block = content[index];
			if (block.type === "text") return block.text;
		}
	}
	return "";
}
