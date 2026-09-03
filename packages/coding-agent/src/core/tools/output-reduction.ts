/**
 * Output reduction: the registry of reducers that turn a tool's raw text into a shorter version of
 * the same output. Every reducer is a pure function of (command, raw text, level) with a
 * deterministic result, and every reducer that drops bytes reports what it dropped so the caller can
 * persist the raw output and the census can price the reduction. Nothing here invents a format:
 * reduced output must read as a shorter version of the real command's output.
 *
 * The reducers themselves live next to the family they understand (`search-output-reducer.ts`,
 * `diagnostics-output-reducer.ts`, ...). This module only knows how to pick one and describe the
 * outcome, so the bash tool, the python tool and the census script share exactly one decision.
 */
import { type CommandFamilyClassification, classifyCommandFamily, commandFamilyLabel } from "./command-family.ts";

/** How hard a reducer may cut. The capability tier decides; `standard` is the frontier default. */
export type OutputReductionLevel = "standard" | "compact";

export interface OutputReductionRequest {
	/** Tool that produced the output (`bash`, `python`). */
	tool: string;
	/** The command as the model typed it (bash) or a synthetic label (python). */
	command: string;
	/** Raw text of the finished output. */
	text: string;
	exitCode: number | null;
	level: OutputReductionLevel;
}

/** What a reduction did, persisted in the tool result's `details.outputReduction` for the census. */
export interface OutputReductionDetails {
	/** Reducer name (`search`, `diagnostics`, `generic`, `rule:<name>`). */
	kind: string;
	/** Command family label the reducer was chosen for (`rg`, `git diff`, `cargo check`). */
	family: string;
	inputBytes: number;
	outputBytes: number;
	inputLines: number;
	outputLines: number;
	omittedLines: number;
	/** Path of the persisted raw output when the caller stored it. */
	rawPath?: string;
}

export interface OutputReductionResult {
	text: string;
	details: OutputReductionDetails;
}

export interface OutputReducer {
	/** Stable name; appears in `details.outputReduction.kind` and in the census. */
	name: string;
	/** Whether this reducer understands the command; the first match in registration order wins. */
	applies(classification: CommandFamilyClassification, request: OutputReductionRequest): boolean;
	/**
	 * Reduce the text. Return undefined to leave the output untouched (nothing worth dropping, an
	 * unexpected shape, or the reduction would not be materially smaller).
	 */
	reduce(
		classification: CommandFamilyClassification,
		request: OutputReductionRequest,
	): (Omit<OutputReductionResult, "details"> & { omittedLines: number }) | undefined;
}

const reducers: OutputReducer[] = [];

/** Register a reducer; order is precedence. Idempotent by name so hot reloads never duplicate. */
export function registerOutputReducer(reducer: OutputReducer): void {
	const index = reducers.findIndex((entry) => entry.name === reducer.name);
	if (index >= 0) reducers[index] = reducer;
	else reducers.push(reducer);
}

export function registeredOutputReducers(): readonly OutputReducer[] {
	return reducers;
}

/** A reduction is worth sending only when it removes at least this share of the raw bytes. */
const MIN_REDUCTION_SHARE = 0.2;

function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Pick the reducer for a request and run it. Undefined when no reducer applies, the model asked for
 * verbose output, or the result is not materially smaller. Pure: safe for replay over recorded text.
 */
export function reduceToolOutput(request: OutputReductionRequest): OutputReductionResult | undefined {
	const classification = classifyCommandFamily(request.command);
	if (classification.verbose) return undefined;
	for (const reducer of reducers) {
		if (!reducer.applies(classification, request)) continue;
		const reduced = reducer.reduce(classification, request);
		if (!reduced) return undefined;
		const inputBytes = Buffer.byteLength(request.text, "utf-8");
		const outputBytes = Buffer.byteLength(reduced.text, "utf-8");
		if (outputBytes > inputBytes * (1 - MIN_REDUCTION_SHARE)) return undefined;
		return {
			text: reduced.text,
			details: {
				kind: reducer.name,
				family: commandFamilyLabel(classification),
				inputBytes,
				outputBytes,
				inputLines: countLines(request.text),
				outputLines: countLines(reduced.text),
				omittedLines: reduced.omittedLines,
			},
		};
	}
	return undefined;
}

/** The one-line notice appended to a reduced result; deterministic, no timestamps or random ids. */
export function formatOutputReductionNotice(details: OutputReductionDetails): string {
	const kept = `retained ${details.outputLines} of ${details.inputLines} lines`;
	const recovery = details.rawPath ? ` Full output: ${details.rawPath}` : "";
	return `[${details.family} output filtered: ${kept}.${recovery}]`;
}
