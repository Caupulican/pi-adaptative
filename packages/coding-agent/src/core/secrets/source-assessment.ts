/**
 * Which one program source file a call prints whole from its first line, so the credential mask may read it as source,
 * and whether a final result really holds that whole output.
 */
import { extractToolPathArguments } from "../autonomy/envelope-enforcement.ts";
import { isProgramSourcePath } from "./program-source-path.ts";
import { type SourceFileOutput, sourceFileOfShellLine } from "./source-output-rule.ts";

/**
 * Which one program source file does a call print whole, from its first line, and nothing else? Only then is the scanner
 * state of the output's first line known (`SOURCE_SCAN_START`); the answer is that file's path, and every other case
 * answers undefined and keeps the data rule. The credential guard asks this after it found no credential risk; the
 * protection of every named path has been judged by then. A `read` and a shell printer are the only shapes left: a
 * process's text is a frame around the output, not the file. A file's name is taken at its word: a copy or a hard link
 * of a data file under a source name is read as source, and what protects such a file is the path policy, not this.
 */

/** A read starts at the file's first line only without a line window, a column window, a filter or an outline. */
function readsFromTheFirstLine(args: Record<string, unknown>): boolean {
	if (args.tail !== undefined || args.mode !== undefined || args.column !== undefined) return false;
	if (args.filter !== undefined && args.filter !== "none") return false;
	return args.offset === undefined || args.offset === 1;
}

/** The one program source file the call prints whole, or undefined. */
export function callPrintsProgramSource(toolName: string, args: Record<string, unknown>): SourceFileOutput | undefined {
	switch (toolName) {
		case "read": {
			const paths = extractToolPathArguments(toolName, args);
			const [path] = paths;
			if (paths.length !== 1 || path === undefined) return undefined;
			return readsFromTheFirstLine(args) && isProgramSourcePath(path)
				? { path, numbered: args.lineNumbers === true }
				: undefined;
		}
		case "bash":
			return typeof args.command === "string" ? sourceFileOfShellLine(args.command) : undefined;
		default:
			return undefined;
	}
}

/**
 * Does a final result hold its whole output from the first line, the one text the source mask may read?
 * It holds it only as exactly one text block: each further block would be read from the start state, so a result of two
 * text blocks is no one text at all. A `read` prints from the file's first line and cuts only after the lines it shows,
 * so it always does. A `bash` does unless its details record a cut (`truncation.truncated`) or a reduction
 * (`outputProjection`). A `run_process` never does: its text is a frame of `outcome`, `exitCode`, `stdout` and `stderr`
 * around the output. Every other tool never does: its text is a shape of its own, not one file from its first line.
 */
export function resultHoldsWholeOutput(
	toolName: string,
	result: { readonly content: readonly { readonly type: string }[]; readonly details?: unknown },
): boolean {
	if (result.content.filter((block) => block.type === "text").length !== 1) return false;
	if (toolName === "read") return true;
	if (toolName !== "bash") return false;
	// A detail is untrusted shape, not a type: each field is read only as far as it is needed.
	const facts = (result.details ?? {}) as {
		readonly truncation?: { readonly truncated?: unknown };
		readonly outputProjection?: unknown;
	};
	return facts.truncation?.truncated !== true && facts.outputProjection === undefined;
}
