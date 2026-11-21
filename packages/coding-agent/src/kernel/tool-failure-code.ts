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
