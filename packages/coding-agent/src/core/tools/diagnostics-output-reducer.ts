/**
 * Diagnostics reducer for compiler and linter output (rustc through cargo, tsc, biome) and build
 * progress. Measured on a live session one `cargo check` was 780 lines for 91 warnings: 370 lines
 * of code frames and gutters, 94 locations, 62 notes. The model needs the file, the position, the
 * code and the message of every diagnostic; it needs the frame only when something failed.
 *
 * Output shape (a shorter version of the real report, grouped by file, or by message when the same
 * messages repeat across files):
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

/** cmake/make/ninja/go/dotnet/fpc build progress: `[ 12%] Building CXX object …`, `go: downloading …`. */
const BUILD_PROGRESS_RE =
	/^\s*(?:\[\s*\d+%\]|\[\d+\/\d+\]|go: (?:downloading|finding|extracting)\b|make(?:\[\d+\])?: (?:Entering|Leaving) directory|Restored\b|Determining projects to restore|Free Pascal Compiler version|Target (?:OS|CPU):|Compiling \S+\.p(?:as|p)$|Linking\b|\d+ lines compiled,)/u;

function isProgressLine(line: string): boolean {
	return PROGRESS_LINE_RE.test(line) || NPM_PROGRESS_RE.test(line) || BUILD_PROGRESS_RE.test(line);
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
// tsc: `path(line,col): error TS1234: message` (plain) or `path:line:col - error TS1234: message`
// followed by a code frame (--pretty, colors already stripped by the generic stage)
// ---------------------------------------------------------------------------------------------

const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/u;
const TSC_PRETTY_LINE_RE = /^(.+?):(\d+):(\d+) - (error|warning) (TS\d+): (.+)$/u;
const TSC_SUMMARY_RE = /^Found \d+ errors?(?: in .+)?\.$/u;
const TSC_TABLE_RE = /^(?:Errors\s+Files|\s+\d+\s+\S.*:\d+)$/u;
/** Type-heavy messages run to thousands of characters; the head names the types, the raw output has the rest. */
const MAX_MESSAGE_CHARS = 300;

function clipMessage(message: string): string {
	return message.length <= MAX_MESSAGE_CHARS
		? message
		: `${message.slice(0, MAX_MESSAGE_CHARS)}… [+${message.length - MAX_MESSAGE_CHARS} chars]`;
}

function parseTsc(lines: string[]): ParsedDiagnostics | undefined {
	const diagnostics: Diagnostic[] = [];
	const other: string[] = [];
	let dropped = 0;
	let current: Diagnostic | undefined;
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/u, "");
		const match = TSC_LINE_RE.exec(line) ?? TSC_PRETTY_LINE_RE.exec(line);
		if (match) {
			current = {
				path: match[1],
				line: Number.parseInt(match[2], 10),
				column: Number.parseInt(match[3], 10),
				severity: match[4] as "error" | "warning",
				code: match[5],
				message: clipMessage(match[6]),
				frame: [],
			};
			diagnostics.push(current);
			continue;
		}
		if (line.trim() === "") continue;
		if (TSC_TABLE_RE.test(line)) {
			dropped++;
			continue;
		}
		if (TSC_SUMMARY_RE.test(line)) {
			current = undefined;
			other.push(line);
			continue;
		}
		// --pretty prints the source line and a `~~~` marker under each diagnostic; a continuation of a
		// multi-line message is indented too. All of it belongs to the current diagnostic's frame.
		if ((current && /^\s/u.test(line)) || (current && /^\d+\s/u.test(line))) {
			current.frame.push(`    ${line.trimEnd()}`);
			continue;
		}
		if (isProgressLine(line)) dropped++;
		else other.push(line);
	}
	if (diagnostics.length === 0) return undefined;
	return { diagnostics, other, droppedLines: dropped };
}

// ---------------------------------------------------------------------------------------------
// eslint (stylish): a path line, then `  line:col  severity  message  rule`, then `✖ N problems`
// ---------------------------------------------------------------------------------------------

const ESLINT_LINE_RE = /^\s+(\d+):(\d+)\s+(error|warning|✖|⚠)\s+(.+?)\s{2,}(\S+)$/u;
const ESLINT_SUMMARY_RE = /^\s*(?:✖|✔|×)?\s*\d+ problems?\b/u;

function parseEslint(lines: string[]): ParsedDiagnostics | undefined {
	const diagnostics: Diagnostic[] = [];
	const other: string[] = [];
	let dropped = 0;
	let path: string | undefined;
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/u, "");
		if (line.trim() === "") continue;
		const match = ESLINT_LINE_RE.exec(line);
		if (match && path) {
			diagnostics.push({
				path,
				line: Number.parseInt(match[1], 10),
				column: Number.parseInt(match[2], 10),
				severity: match[3] === "warning" || match[3] === "⚠" ? "warning" : "error",
				code: match[5],
				message: clipMessage(match[4]),
				frame: [],
			});
			continue;
		}
		if (ESLINT_SUMMARY_RE.test(line)) {
			path = undefined;
			other.push(line.trim());
			continue;
		}
		if (!/^\s/u.test(line) && !line.includes(" ")) {
			path = line;
			continue;
		}
		if (/potentially fixable/u.test(line)) {
			dropped++;
			continue;
		}
		if (isProgressLine(line)) dropped++;
		else other.push(line);
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
// Language-agnostic grammars: what nearly every compiler and linter prints, one diagnostic per
// line with a location. gcc/clang/mypy/pylint/htmlhint (GNU), MSVC and Free Pascal/Delphi
// (parenthesised), Go (no severity word), PHP (`… in path on line N`), ruff/flake8 (code first).
// Frames (indented source echoes, `~~~`/`^` markers) follow their diagnostic and are budgeted.
// ---------------------------------------------------------------------------------------------

type Severity = Diagnostic["severity"];

function severityOf(word: string | undefined, fallback: Severity = "error"): Severity {
	const lower = (word ?? "").toLowerCase();
	if (lower.includes("error")) return "error";
	if (lower.includes("warn")) return "warning";
	if (["note", "info", "hint", "remark", "notice", "deprecated"].includes(lower)) return "info";
	return fallback;
}

interface LocationGrammar {
	name: string;
	pattern: RegExp;
	build(match: RegExpExecArray): Omit<Diagnostic, "frame">;
}

const LOCATION_GRAMMARS: LocationGrammar[] = [
	{
		// PHP: `PHP Fatal error:  Uncaught Error: … in /app/x.php on line 12` (with or without the prefix).
		name: "php",
		pattern:
			/^(?:PHP )?(Parse error|Fatal error|Warning|Notice|Deprecated|Error):\s+(.+?) in (\S+) on line (\d+)\s*$/u,
		build: (match) => ({
			path: match[3],
			line: Number.parseInt(match[4], 10),
			severity: severityOf(match[1], "error"),
			message: clipMessage(match[2]),
		}),
	},
	{
		// ruff / flake8 / pycodestyle: `src/app.py:12:5: F401 'os' imported but unused`.
		name: "code-first",
		pattern: /^(\S[^:\n]*?):(\d+):(\d+): ([A-Z]{1,4}\d{3,4}) (.+)$/u,
		build: (match) => ({
			path: match[1],
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
			severity: /^[EF]/u.test(match[4]) ? "error" : "warning",
			code: match[4],
			message: clipMessage(match[5]),
		}),
	},
	{
		// GNU: `src/main.cpp:12:5: error: 'x' was not declared in this scope`; mypy `x.py:3: error: msg  [name-defined]`;
		// pylint `x.py:3:0: C0114: Missing module docstring (missing-module-docstring)`.
		name: "gnu",
		pattern:
			/^(\S[^:\n]*?):(\d+)(?::(\d+))?:\s*(fatal error|error|warning|note|info|remark|hint|[CRWEF]\d{4}):\s*(.+)$/iu,
		build: (match) => {
			const word = match[4];
			const codeLike = /^[CRWEF]\d{4}$/u.test(word);
			const bracketed = /\s+\[([A-Za-z0-9_.-]+)\]$/u.exec(match[5]);
			return {
				path: match[1],
				line: Number.parseInt(match[2], 10),
				...(match[3] !== undefined ? { column: Number.parseInt(match[3], 10) } : {}),
				severity: codeLike ? (/^[EF]/u.test(word) ? "error" : "warning") : severityOf(word),
				...(codeLike ? { code: word } : bracketed ? { code: bracketed[1] } : {}),
				message: clipMessage(bracketed ? match[5].slice(0, -bracketed[0].length) : match[5]),
			};
		},
	},
	{
		// MSVC / Free Pascal / Delphi: `main.cpp(12,5): error C2065: 'x': undeclared identifier`,
		// `unit1.pas(12,5) Error: Identifier not found "x"`, `Unit1.pas(12) Fatal: Syntax error`.
		name: "parenthesised",
		pattern:
			/^(\S[^(\n]*?)\((\d+)(?:,(\d+))?\)\s*:?\s*(fatal error|fatal|error|warning|hint|note|info)\s*:?\s*(?:([A-Z]{1,3}\d{3,5}):\s*)?(.+)$/iu,
		build: (match) => ({
			path: match[1],
			line: Number.parseInt(match[2], 10),
			...(match[3] !== undefined ? { column: Number.parseInt(match[3], 10) } : {}),
			severity: severityOf(match[4]),
			...(match[5] ? { code: match[5] } : {}),
			message: clipMessage(match[6]),
		}),
	},
	{
		// Go build/vet: `./main.go:12:5: undefined: x` (no severity word; a `.go` path is the tell).
		name: "go",
		pattern: /^(\S+\.go):(\d+):(\d+): (.+)$/u,
		build: (match) => ({
			path: match[1],
			line: Number.parseInt(match[2], 10),
			column: Number.parseInt(match[3], 10),
			severity: "error",
			message: clipMessage(match[4]),
		}),
	},
];

const FRAME_LINE_RE = /^(?:\s+\S|\s*\d+\s*\||\s*[~^]+)/u;
/** A report is worth restructuring when at least this many lines are diagnostics. */
const MIN_GENERIC_DIAGNOSTICS = 3;

function matchLocation(line: string): Omit<Diagnostic, "frame"> | undefined {
	for (const grammar of LOCATION_GRAMMARS) {
		const match = grammar.pattern.exec(line);
		if (match) return grammar.build(match);
	}
	return undefined;
}

/** Count of lines any grammar accepts, stopping early: the cheap test `applies` runs on unknown commands. */
export function countDiagnosticLines(text: string, stopAt = MIN_GENERIC_DIAGNOSTICS): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (matchLocation(line.replace(/\r$/u, "")) !== undefined && ++count >= stopAt) break;
	}
	return count;
}

function parseGeneric(lines: string[]): ParsedDiagnostics | undefined {
	const diagnostics: Diagnostic[] = [];
	const other: string[] = [];
	let dropped = 0;
	let current: Diagnostic | undefined;
	for (const rawLine of lines) {
		const line = rawLine.replace(/\r$/u, "");
		const located = matchLocation(line);
		if (located) {
			current = { ...located, frame: [] };
			diagnostics.push(current);
			continue;
		}
		if (line.trim() === "") continue;
		if (current && FRAME_LINE_RE.test(line)) {
			// Indented source echoes and caret markers belong to the diagnostic above; a top-level line
			// (gcc's `In function 'main':`, clang's `1 error generated.`) does not.
			if (current.severity === "error") current.frame.push(`    ${line.trimEnd()}`);
			else dropped++;
			continue;
		}
		if (isProgressLine(line)) {
			dropped++;
			continue;
		}
		other.push(line);
	}
	if (diagnostics.length < MIN_GENERIC_DIAGNOSTICS) return undefined;
	return { diagnostics, other, droppedLines: dropped };
}

// ---------------------------------------------------------------------------------------------
// Python tracebacks: keep the exception, the first frame and the last frames; the middle is a count.
// ---------------------------------------------------------------------------------------------

const TRACEBACK_HEADER_RE = /^Traceback \(most recent call last\):\s*$/u;
const TRACEBACK_FRAME_RE = /^\s+File "(.+?)", line (\d+)(?:, in (.+))?$/u;
const TRACEBACK_KEPT_TAIL: Record<OutputReductionLevel, number> = { standard: 3, compact: 2 };

export interface TracebackReduction {
	text: string;
	omittedLines: number;
}

/** Reduce every traceback in the text; undefined when there is none or nothing to cut. */
export function reducePythonTracebacks(
	text: string,
	level: OutputReductionLevel = "standard",
): TracebackReduction | undefined {
	const lines = text.split("\n");
	const hadTrailingNewline = lines.at(-1) === "";
	if (hadTrailingNewline) lines.pop();
	const out: string[] = [];
	let omitted = 0;
	let changed = false;
	let index = 0;
	while (index < lines.length) {
		if (!TRACEBACK_HEADER_RE.test(lines[index])) {
			out.push(lines[index]);
			index++;
			continue;
		}
		out.push(lines[index]);
		index++;
		// A frame is `  File "…", line N, in f` plus its indented source echo (and marker) lines.
		const frames: string[][] = [];
		while (index < lines.length && TRACEBACK_FRAME_RE.test(lines[index])) {
			const frame = [lines[index++]];
			while (index < lines.length && /^\s{4,}\S/u.test(lines[index]) && !TRACEBACK_FRAME_RE.test(lines[index])) {
				frame.push(lines[index++]);
			}
			frames.push(frame);
		}
		const keepTail = TRACEBACK_KEPT_TAIL[level];
		if (frames.length > keepTail + 1) {
			const hidden = frames.slice(1, frames.length - keepTail);
			out.push(...frames[0]);
			out.push(`  [… ${hidden.length} more frames]`);
			for (const frame of frames.slice(frames.length - keepTail)) out.push(...frame);
			omitted += hidden.reduce((count, frame) => count + frame.length, 0) - 1;
			changed = true;
		} else {
			for (const frame of frames) out.push(...frame);
		}
	}
	if (!changed) return undefined;
	let result = out.join("\n");
	if (hadTrailingNewline) result += "\n";
	return { text: result, omittedLines: Math.max(0, omitted) };
}

// ---------------------------------------------------------------------------------------------
// Grouped rendering shared by every toolchain
// ---------------------------------------------------------------------------------------------

function positionOf(diagnostic: Diagnostic): string {
	return diagnostic.column !== undefined ? `${diagnostic.line}:${diagnostic.column}` : `${diagnostic.line}`;
}

function messageKey(diagnostic: Diagnostic): string {
	return `${diagnostic.severity}\0${diagnostic.code ?? ""}\0${diagnostic.message}`;
}

function labelOf(diagnostic: Diagnostic): string {
	const code = diagnostic.code ? `[${diagnostic.code}]` : "";
	return `${diagnostic.severity}${code}: ${diagnostic.message}`;
}

/** Frames survive for the first instances of each distinct message, within a total budget. */
class FrameBudget {
	private readonly perMessage = new Map<string, number>();
	private total = 0;
	private readonly level: OutputReductionLevel;
	constructor(level: OutputReductionLevel) {
		this.level = level;
	}
	take(diagnostic: Diagnostic): boolean {
		if (diagnostic.frame.length === 0) return false;
		const key = `${diagnostic.code ?? ""}\0${diagnostic.message}`;
		const used = this.perMessage.get(key) ?? 0;
		if (used >= FRAMED_ERRORS_PER_MESSAGE[this.level] || this.total >= FRAMED_ERRORS_TOTAL[this.level]) return false;
		this.perMessage.set(key, used + 1);
		this.total++;
		return true;
	}
}

/**
 * Grouped by file: one line per distinct message within a file, listing every position
 * (`at 12:5, 40:5`), frames for the first framed errors. Used when messages are mostly distinct.
 */
function renderByFile(parsed: ParsedDiagnostics, budget: FrameBudget, out: string[]): void {
	const byFile = new Map<string, Diagnostic[]>();
	for (const diagnostic of parsed.diagnostics) {
		const list = byFile.get(diagnostic.path);
		if (list) list.push(diagnostic);
		else byFile.set(diagnostic.path, [diagnostic]);
	}
	for (const [path, list] of byFile) {
		out.push(path);
		const merged = new Map<string, { diagnostic: Diagnostic; positions: string[]; frames: Diagnostic[] }>();
		for (const diagnostic of list) {
			const entry = merged.get(messageKey(diagnostic));
			if (entry) {
				entry.positions.push(positionOf(diagnostic));
				entry.frames.push(diagnostic);
			} else {
				merged.set(messageKey(diagnostic), {
					diagnostic,
					positions: [positionOf(diagnostic)],
					frames: [diagnostic],
				});
			}
		}
		for (const { diagnostic, positions, frames } of merged.values()) {
			if (positions.length === 1) out.push(`  ${positions[0]} ${labelOf(diagnostic)}`);
			else out.push(`  ${labelOf(diagnostic)}  at ${positions.join(", ")}`);
			for (const framed of frames) {
				if (!budget.take(framed)) break;
				for (const frameLine of framed.frame) out.push(frameLine);
			}
		}
	}
}

/**
 * Grouped by message: one label line per distinct message with its total count, then one line per
 * file listing the positions. Used when the same messages repeat across files (a type change that
 * breaks twenty call sites, a lint rule firing everywhere): the message is the information, the
 * positions are the list.
 */
function renderByMessage(parsed: ParsedDiagnostics, budget: FrameBudget, out: string[]): void {
	const byMessage = new Map<string, Diagnostic[]>();
	for (const diagnostic of parsed.diagnostics) {
		const list = byMessage.get(messageKey(diagnostic));
		if (list) list.push(diagnostic);
		else byMessage.set(messageKey(diagnostic), [diagnostic]);
	}
	for (const list of byMessage.values()) {
		const first = list[0];
		out.push(list.length === 1 ? `${labelOf(first)}` : `${labelOf(first)}  (${list.length} places)`);
		const byFile = new Map<string, string[]>();
		for (const diagnostic of list) {
			const positions = byFile.get(diagnostic.path);
			if (positions) positions.push(positionOf(diagnostic));
			else byFile.set(diagnostic.path, [positionOf(diagnostic)]);
		}
		for (const [path, positions] of byFile) out.push(`  ${path} ${positions.join(", ")}`);
		for (const framed of list) {
			if (!budget.take(framed)) break;
			for (const frameLine of framed.frame) out.push(frameLine);
		}
	}
}

function renderGrouped(parsed: ParsedDiagnostics, level: OutputReductionLevel): string {
	const out: string[] = [];
	const budget = new FrameBudget(level);
	const files = new Set(parsed.diagnostics.map((diagnostic) => diagnostic.path)).size;
	const messages = new Set(parsed.diagnostics.map(messageKey)).size;
	// Repetition across files decides the layout: when the distinct messages are at most half the
	// diagnostics and more than one file is involved, the message is the unit; otherwise the file is.
	if (files > 1 && messages * 2 <= parsed.diagnostics.length) renderByMessage(parsed, budget, out);
	else renderByFile(parsed, budget, out);
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
		case "eslint":
		case "stylelint":
			return parseEslint;
		case "biome":
			return parseBiome;
		default:
			return parseGeneric;
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
	applies(classification: CommandFamilyClassification, request: OutputReductionRequest): boolean {
		if (classification.family === "diagnostics") return true;
		if (classification.family === "search" || classification.family === "git") return false;
		// Any other command (make, a build script, a python run) whose output reads as diagnostics.
		return (
			countDiagnosticLines(request.text) >= MIN_GENERIC_DIAGNOSTICS ||
			request.text.includes("Traceback (most recent call last):")
		);
	},
	reduce(classification: CommandFamilyClassification, request: OutputReductionRequest) {
		const tracebacks = reducePythonTracebacks(request.text, request.level);
		const text = tracebacks?.text ?? request.text;
		const reduced = reduceDiagnosticsOutput(classification, text, request.level);
		if (reduced) {
			return { text: reduced.text, omittedLines: reduced.omittedLines + (tracebacks?.omittedLines ?? 0) };
		}
		return tracebacks
			? { text: tracebacks.text, omittedLines: tracebacks.omittedLines, kind: "traceback" }
			: undefined;
	},
};
