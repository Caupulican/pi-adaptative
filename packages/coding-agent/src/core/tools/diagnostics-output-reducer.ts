/**
 * Diagnostics reducer for compiler and linter output (rustc through cargo, tsc, biome) and build
 * progress. Measured on a live session one `cargo check` was 780 lines for 91 warnings: 370 lines
 * of code frames and gutters, 94 locations, 62 notes. The model needs the file, the position, the
 * code and the message of every diagnostic; it needs the frame only when something failed.
 *
 * Output shape (a shorter version of the real report, grouped by file):
 *
 *   src/module.rs
 *     warning[unused_variables]: unused variable: `tmp`  at 42:9, 57:9, 90:13
 *     88:5 error[E0308]: mismatched types
 *       88 |     let n: u32 = "text";
 *          |                  ^^^^^^ expected `u32`, found `&str`
 *   warning: `demo` generated 30 warnings
 *
 * Unknown lines are kept verbatim in place (never dropped silently); only recognized progress
 * lines, code frames of warnings, notes/help and fix previews are removed. The caller persists the
 * raw output so any frame is one read away.
 */
import type { CommandFamilyClassification } from "./command-family.ts";
import type { OutputReducer, OutputReductionLevel, OutputReductionRequest } from "./output-reduction.ts";

/**
 * Frames are kept for errors, but not for every repeat of the same error: measured on a live
 * session one `cargo check` carried 81 errors of two messages, each with a 10-line frame, and the
 * frames were 89 % of the bytes. The first instances of each distinct message keep their frame; the
 * rest are one-liners, and the raw output holds every frame.
 */
const FRAMED_ERRORS_PER_MESSAGE: Record<OutputReductionLevel, number> = { standard: 2, compact: 1 };
const FRAMED_ERRORS_TOTAL: Record<OutputReductionLevel, number> = { standard: 8, compact: 3 };

interface Diagnostic {
	path: string;
	line: number;
	column?: number;
	severity: "error" | "warning" | "info";
	code?: string;
	message: string;
	/** Frame and note lines kept for errors, already indented for the grouped layout. */
	frame: string[];
}

interface ParsedDiagnostics {
	diagnostics: Diagnostic[];
	/** Lines that belong to no diagnostic and are not progress noise, in order. */
	other: string[];
	droppedLines: number;
}

const PROGRESS_LINE_RE =
	/^\s*(?:Compiling|Checking|Downloading|Downloaded|Updating|Fresh|Blocking|Building|Documenting|Installing|Locking|Adding|Removing|Waiting)\b/u;
const NPM_PROGRESS_RE = /^\s*[▐▌█░#=>-]*\s*(?:progress|reify|idealTree|fetchMetadata)\b/iu;

function isProgressLine(line: string): boolean {
	return PROGRESS_LINE_RE.test(line) || NPM_PROGRESS_RE.test(line);
}

// ---------------------------------------------------------------------------------------------
// rustc (human format, as cargo check/build/clippy print it)
// ---------------------------------------------------------------------------------------------

const RUSTC_HEADER_RE = /^(error|warning)(?:\[([A-Za-z0-9_:]+)\])?: (.+)$/u;
const RUSTC_LOCATION_RE = /^\s*-->\s+(.+?):(\d+):(\d+)\s*$/u;
const RUSTC_LINT_NOTE_RE = /^\s*=\s+note: `#\[(?:warn|deny|forbid)\(([A-Za-z0-9_:]+)\)\]`/u;
const RUSTC_SUMMARY_RE =
	/^(?:warning: `[^`]+` \([^)]*\) generated \d+ warnings?|error: could not compile|error: aborting due to|warning: build failed|error: (?:test failed|process didn't exit successfully)|\s*Finished\b)/u;

function parseRustc(lines: string[]): ParsedDiagnostics | undefined {
	const diagnostics: Diagnostic[] = [];
	const other: string[] = [];
	let dropped = 0;
	let current: Diagnostic | undefined;
	let pendingHeader: { severity: "error" | "warning"; code?: string; message: string } | undefined;
	const flush = () => {
		if (current) diagnostics.push(current);
		current = undefined;
	};
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/u, "");
		if (RUSTC_SUMMARY_RE.test(line)) {
			flush();
			pendingHeader = undefined;
			other.push(line);
			continue;
		}
		const header = RUSTC_HEADER_RE.exec(line);
		if (header) {
			flush();
			pendingHeader = { severity: header[1] as "error" | "warning", code: header[2], message: header[3] };
			continue;
		}
		const location = RUSTC_LOCATION_RE.exec(line);
		if (location && pendingHeader) {
			current = {
				path: location[1],
				line: Number.parseInt(location[2], 10),
				column: Number.parseInt(location[3], 10),
				severity: pendingHeader.severity,
				code: pendingHeader.code,
				message: pendingHeader.message,
				frame: [],
			};
			pendingHeader = undefined;
			continue;
		}
		if (current) {
			// Frame gutters (`   |`, `42 |`), secondary spans (`:::`, `-->`), notes and help belong to
			// the current diagnostic.
			if (
				/^\s*(?:\d+\s*)?\|/u.test(line) ||
				/^\s*(?:=\s+(?:note|help)|:::\s|-->\s)/u.test(line) ||
				line.trim() === ""
			) {
				// rustc names the lint only in the note: `#[warn(unused_variables)] on by default`.
				const lintName = RUSTC_LINT_NOTE_RE.exec(line);
				if (lintName && current.code === undefined) current.code = lintName[1];
				if (current.severity === "error" && line.trim() !== "") current.frame.push(`    ${line.trimEnd()}`);
				else if (line.trim() !== "") dropped++;
				continue;
			}
			// A sub-diagnostic (`note:`, `help:`) attached to the current one.
			if (/^\s*(?:note|help|warning|error):\s/u.test(line) && !RUSTC_HEADER_RE.test(line)) {
				if (current.severity === "error") current.frame.push(`    ${line.trim()}`);
				else dropped++;
				continue;
			}
			flush();
		}
		if (pendingHeader) {
			// A header without a location (e.g. `error: linking failed`): keep it verbatim.
			other.push(
				`${pendingHeader.severity}${pendingHeader.code ? `[${pendingHeader.code}]` : ""}: ${pendingHeader.message}`,
			);
			pendingHeader = undefined;
		}
		if (line.trim() === "") continue;
		if (isProgressLine(line)) {
			dropped++;
			continue;
		}
		other.push(line);
	}
	flush();
	if (pendingHeader) other.push(`${pendingHeader.severity}: ${pendingHeader.message}`);
	if (diagnostics.length === 0 && dropped === 0) return undefined;
	return { diagnostics, other, droppedLines: dropped };
}

// ---------------------------------------------------------------------------------------------
// tsc (non-pretty): path(line,col): error TS1234: message
// ---------------------------------------------------------------------------------------------

const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/u;
const TSC_SUMMARY_RE = /^Found \d+ errors?(?: in .+)?\.$/u;
const TSC_TABLE_RE = /^(?:Errors\s+Files|\s+\d+\s+\S.*:\d+)$/u;

function parseTsc(lines: string[]): ParsedDiagnostics | undefined {
	const diagnostics: Diagnostic[] = [];
	const other: string[] = [];
	let dropped = 0;
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/u, "");
		if (line.trim() === "") continue;
		const match = TSC_LINE_RE.exec(line);
		if (match) {
			diagnostics.push({
				path: match[1],
				line: Number.parseInt(match[2], 10),
				column: Number.parseInt(match[3], 10),
				severity: match[4] as "error" | "warning",
				code: match[5],
				message: match[6],
				frame: [],
			});
			continue;
		}
		if (TSC_TABLE_RE.test(line)) {
			dropped++;
			continue;
		}
		if (TSC_SUMMARY_RE.test(line) || !isProgressLine(line)) other.push(line);
		else dropped++;
	}
	if (diagnostics.length === 0) return undefined;
	return { diagnostics, other, droppedLines: dropped };
}

// ---------------------------------------------------------------------------------------------
// biome (default reporter without colors): `path:line:col rule [FIXABLE] ━━━`, then `× message`
// ---------------------------------------------------------------------------------------------

const BIOME_HEADER_RE = /^(\S+?):(\d+):(\d+) (\S+)(?:\s+FIXABLE)?\s+━+\s*$/u;
const BIOME_MESSAGE_RE = /^\s*([×!i])\s+(.+)$/u;
const BIOME_FRAME_RE = /^\s*>?\s*\d*\s*│/u;
const BIOME_ADVICE_RE = /^\s*i\s+\S/u;
const BIOME_SUMMARY_RE =
	/^(?:Checked \d+ files? in .+|Found \d+ (?:errors?|warnings?)\.?|Formatter would have printed|Skipped \d+ files?\.?)/u;

function parseBiome(lines: string[]): ParsedDiagnostics | undefined {
	const diagnostics: Diagnostic[] = [];
	const other: string[] = [];
	let dropped = 0;
	let current: Diagnostic | undefined;
	let awaitingMessage = false;
	let inAdvice = false;
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/u, "");
		const header = BIOME_HEADER_RE.exec(line);
		if (header) {
			if (current) diagnostics.push(current);
			inAdvice = false;
			current = {
				path: header[1],
				line: Number.parseInt(header[2], 10),
				column: Number.parseInt(header[3], 10),
				severity: "warning",
				code: header[4],
				message: "",
				frame: [],
			};
			awaitingMessage = true;
			continue;
		}
		if (current) {
			if (line.trim() === "") continue;
			const message = BIOME_MESSAGE_RE.exec(line);
			if (awaitingMessage && message) {
				current.severity = message[1] === "×" ? "error" : message[1] === "!" ? "warning" : "info";
				current.message = message[2];
				awaitingMessage = false;
				continue;
			}
			if (BIOME_SUMMARY_RE.test(line)) {
				diagnostics.push(current);
				current = undefined;
				other.push(line);
				continue;
			}
			// Frames (`│`) are kept for errors up to the first advice line; advice (`i …`) and fix
			// previews are dropped for every severity.
			if (BIOME_ADVICE_RE.test(line)) inAdvice = true;
			if (current.severity === "error" && !inAdvice && BIOME_FRAME_RE.test(line)) {
				current.frame.push(`    ${line.trimEnd()}`);
				continue;
			}
			dropped++;
			continue;
		}
		if (line.trim() === "") continue;
		if (isProgressLine(line)) {
			dropped++;
			continue;
		}
		other.push(line);
	}
	if (current) diagnostics.push(current);
	if (diagnostics.length === 0) return undefined;
	return { diagnostics, other, droppedLines: dropped };
}

// ---------------------------------------------------------------------------------------------
// Grouped rendering shared by every toolchain
// ---------------------------------------------------------------------------------------------

function renderGrouped(parsed: ParsedDiagnostics, level: OutputReductionLevel): string {
	const framedPerMessage = new Map<string, number>();
	let framedTotal = 0;
	const byFile = new Map<string, Diagnostic[]>();
	for (const diagnostic of parsed.diagnostics) {
		const list = byFile.get(diagnostic.path);
		if (list) list.push(diagnostic);
		else byFile.set(diagnostic.path, [diagnostic]);
	}
	const out: string[] = [];
	for (const [path, list] of byFile) {
		out.push(path);
		// Within a file, diagnostics with the same severity, code and message merge into one line that
		// lists every position (`at 12:5, 40:5`); the positions are what differs, so nothing is lost.
		const merged = new Map<string, { diagnostic: Diagnostic; positions: string[]; frames: string[][] }>();
		for (const diagnostic of list) {
			const key = `${diagnostic.severity}\0${diagnostic.code ?? ""}\0${diagnostic.message}`;
			const position =
				diagnostic.column !== undefined ? `${diagnostic.line}:${diagnostic.column}` : `${diagnostic.line}`;
			const entry = merged.get(key);
			if (entry) {
				entry.positions.push(position);
				entry.frames.push(diagnostic.frame);
			} else merged.set(key, { diagnostic, positions: [position], frames: [diagnostic.frame] });
		}
		for (const { diagnostic, positions, frames } of merged.values()) {
			const code = diagnostic.code ? `[${diagnostic.code}]` : "";
			const label = `${diagnostic.severity}${code}: ${diagnostic.message}`;
			if (positions.length === 1) out.push(`  ${positions[0]} ${label}`);
			else out.push(`  ${label}  at ${positions.join(", ")}`);
			// Frames survive for the first instances of each distinct message, within a total budget.
			const messageKey = `${diagnostic.code ?? ""}\0${diagnostic.message}`;
			for (const frame of frames) {
				if (frame.length === 0) continue;
				const framedForMessage = framedPerMessage.get(messageKey) ?? 0;
				if (framedForMessage >= FRAMED_ERRORS_PER_MESSAGE[level] || framedTotal >= FRAMED_ERRORS_TOTAL[level])
					break;
				framedPerMessage.set(messageKey, framedForMessage + 1);
				framedTotal++;
				for (const frameLine of frame) out.push(frameLine);
			}
		}
	}
	// Summary and unrecognized lines close the report so counts and failures stay visible.
	for (const line of parsed.other) out.push(line);
	return `${out.join("\n")}\n`;
}

function parserFor(
	classification: CommandFamilyClassification,
): ((lines: string[]) => ParsedDiagnostics | undefined) | undefined {
	switch (classification.tool) {
		case "cargo":
		case "rustc":
		case "clippy-driver":
			return parseRustc;
		case "tsc":
			return parseTsc;
		case "biome":
			return parseBiome;
		default:
			return undefined;
	}
}

export interface DiagnosticsReduction {
	text: string;
	omittedLines: number;
}

/** Reduce a compiler or linter report to grouped one-line diagnostics; undefined when none are found. */
export function reduceDiagnosticsOutput(
	classification: CommandFamilyClassification,
	text: string,
	level: OutputReductionLevel = "standard",
): DiagnosticsReduction | undefined {
	const parse = parserFor(classification);
	if (!parse) return undefined;
	const lines = text.split("\n");
	if (lines.at(-1) === "") lines.pop();
	const parsed = parse(lines);
	if (!parsed) return undefined;
	const rendered = renderGrouped(parsed, level);
	const renderedLines = rendered.split("\n").length - 1;
	return { text: rendered, omittedLines: Math.max(0, lines.length - renderedLines) };
}

export const diagnosticsOutputReducer: OutputReducer = {
	name: "diagnostics",
	applies(classification: CommandFamilyClassification): boolean {
		return classification.family === "diagnostics" && parserFor(classification) !== undefined;
	},
	reduce(classification: CommandFamilyClassification, request: OutputReductionRequest) {
		return reduceDiagnosticsOutput(classification, request.text, request.level);
	},
};
