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
import { reduceGenericOutput } from "./generic-output-reducer.ts";
import type { ShellOutputProjection, ShellOutputProjectorLike } from "./shell-output-projection.ts";

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
	/** Reducer name (`search`, `diagnostics`, `generic`, `rule:<name>`); `+generic` when the generic stage also cut lines. */
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
	/**
	 * Whether the caller should persist the raw output and append the recovery notice: true when a
	 * family or rule reducer reshaped the output or the generic stage dropped lines, and the cut is
	 * large enough to be worth a file. Pure cleaning (ANSI, whitespace, resolved progress frames)
	 * leaves it false: nothing to recover.
	 */
	persistRaw: boolean;
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
	): (Omit<OutputReductionResult, "details"> & { omittedLines: number; kind?: string }) | undefined;
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

/** A family or rule reduction is worth sending only when it removes at least this share of the raw bytes. */
const MIN_REDUCTION_SHARE = 0.2;
/** The generic stage alone is worth sending when it removes at least this many bytes. */
const MIN_GENERIC_SAVED_BYTES = 128;
/** Below this many dropped bytes the raw output is not worth a managed file. */
const MIN_PERSIST_SAVED_BYTES = 512;

/** Operator-facing switches shared by the bash and python tools (settings `toolOutput`). */
export interface OutputReductionToolOptions {
	/** `false` turns every stage off for the tool; the model's `fullOutput` does the same per call. */
	enabled?: boolean;
	level?: OutputReductionLevel;
	/** Extra rule files (settings `toolOutput.rulesFile`), loaded after the user and project files. */
	rulesFiles?: readonly string[];
	/** Agent directory holding the user rule file; defaults to the runtime's agent directory. */
	agentDir?: string;
}

export interface ReduceToolOutputOptions {
	/** Reducers tried after the registered ones (the tool instance's rule reducer). */
	extraReducers?: readonly OutputReducer[];
}

function countLines(text: string): number {
	if (text.length === 0) return 0;
	return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

/**
 * Run the pipeline for a request: the generic stage first (ANSI, progress frames, whitespace,
 * repeated lines), then the first family or rule reducer that applies on the cleaned text. Undefined
 * when nothing changed, the model asked for verbose output, or the result is not materially smaller.
 * Pure: safe for replay over recorded text.
 */
export function reduceToolOutput(
	request: OutputReductionRequest,
	options?: ReduceToolOutputOptions,
): OutputReductionResult | undefined {
	const classification = classifyCommandFamily(request.command);
	if (classification.verbose) return undefined;
	const inputBytes = Buffer.byteLength(request.text, "utf-8");
	const generic = reduceGenericOutput(request.text, request.level);
	const cleaned: OutputReductionRequest = { ...request, text: generic.text };
	let text = generic.text;
	let omittedLines = generic.omittedLines;
	let kind: string | undefined;
	for (const reducer of [...reducers, ...(options?.extraReducers ?? [])]) {
		if (!reducer.applies(classification, cleaned)) continue;
		const reduced = reducer.reduce(classification, cleaned);
		if (!reduced) break;
		const reducedBytes = Buffer.byteLength(reduced.text, "utf-8");
		// A family cut that saves less than the floor is not worth a different spelling of the output.
		if (reducedBytes > inputBytes * (1 - MIN_REDUCTION_SHARE)) break;
		text = reduced.text;
		omittedLines += reduced.omittedLines;
		kind = reduced.kind ?? reducer.name;
		break;
	}
	const outputBytes = Buffer.byteLength(text, "utf-8");
	const saved = inputBytes - outputBytes;
	if (kind === undefined) {
		if (!generic.changed) return undefined;
		if (saved < MIN_GENERIC_SAVED_BYTES && outputBytes > inputBytes * (1 - MIN_REDUCTION_SHARE)) return undefined;
		kind = "generic";
	} else if (generic.omittedLines > 0) {
		kind = `${kind}+generic`;
	}
	return {
		text,
		details: {
			kind,
			family: commandFamilyLabel(classification),
			inputBytes,
			outputBytes,
			inputLines: countLines(request.text),
			outputLines: countLines(text),
			omittedLines,
			// A family or rule reducer changed the shape of the output; the generic stage only cleaned it
			// unless it dropped lines. Either way a small cut is not worth a file.
			persistRaw: saved >= MIN_PERSIST_SAVED_BYTES && (omittedLines > 0 || kind !== "generic"),
		},
	};
}

/**
 * The one-line notice appended to a reduced result; deterministic, no timestamps or random ids.
 * Undefined when no line was dropped and no raw file was written: cleaning needs no announcement.
 */
export function formatOutputReductionNotice(details: OutputReductionDetails): string | undefined {
	if (details.omittedLines === 0 && !details.rawPath) return undefined;
	const kept =
		details.omittedLines === 0
			? `${details.inputLines} lines regrouped, none omitted`
			: `retained ${details.outputLines} of ${details.inputLines} lines`;
	const recovery = details.rawPath ? ` Full output: ${details.rawPath}` : "";
	return `[${details.family} output filtered: ${kept}.${recovery}]`;
}

/** Reducers see the whole output; beyond this the raw path (caps and managed file) takes over. */
const MAX_BUFFERED_REDUCTION_BYTES = 8 * 1024 * 1024;

/** Whether a family reducer (registered or extra) would consider this command; the generic stage always applies. */
export function outputReductionApplies(command: string, options?: ReduceToolOutputOptions): boolean {
	const classification = classifyCommandFamily(command);
	if (classification.verbose) return false;
	const probe: OutputReductionRequest = { tool: "bash", command, text: "", exitCode: 0, level: "standard" };
	return [...reducers, ...(options?.extraReducers ?? [])].some((reducer) => reducer.applies(classification, probe));
}

/**
 * Streaming adapter over the pure reducers for the bash tool: buffers the output as it arrives and
 * reduces it once the command finished, in the same shape as the test projector so the tool's
 * persistence and notice flow applies unchanged. Gives up (undefined) when the output outgrows the
 * buffer or the reducer declines; the raw path then handles the result exactly as before.
 */
export function createReductionProjector(
	tool: string,
	command: string,
	level: OutputReductionLevel,
	options?: ReduceToolOutputOptions,
): ShellOutputProjectorLike | undefined {
	if (classifyCommandFamily(command).verbose) return undefined;
	const chunks: Buffer[] = [];
	let bufferedBytes = 0;
	let overflowed = false;
	let finished: ShellOutputProjection | null | undefined;
	return {
		append(data: Buffer): void {
			if (overflowed) return;
			bufferedBytes += data.length;
			if (bufferedBytes > MAX_BUFFERED_REDUCTION_BYTES) {
				overflowed = true;
				chunks.length = 0;
				return;
			}
			chunks.push(data);
		},
		finish(exitCode: number | null): ShellOutputProjection | undefined {
			if (finished !== undefined) return finished ?? undefined;
			if (overflowed) {
				finished = null;
				return undefined;
			}
			const text = Buffer.concat(chunks).toString("utf-8");
			const result = reduceToolOutput({ tool, command, text, exitCode, level }, options);
			if (!result) {
				finished = null;
				return undefined;
			}
			finished = {
				kind: "reduction",
				content: result.text,
				inputLines: result.details.inputLines,
				inputBytes: result.details.inputBytes,
				outputLines: result.details.outputLines,
				outputBytes: result.details.outputBytes,
				omittedLines: result.details.omittedLines,
				collapsedPassingLines: 0,
				reduction: result.details,
				persistRaw: result.details.persistRaw,
			};
			return finished;
		},
	};
}
