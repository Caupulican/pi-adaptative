/**
 * Classifies the stretches of one source line as code, string content or comment, so a credential mask can treat
 * string and comment text as data and leave code tokens alone. It masks nothing and reads no files.
 *
 * A language is in the table below only when every form of it that can hold free text across lines is handled. A
 * language left out keeps the data rule for all of its text. A mistake may turn code into string, never free text
 * into code. Rule 6, whether a `/` divides or opens a regular expression, lives in `slash-position.ts`.
 */

import { createSlashReader, type SlashState } from "./slash-position.ts";

/** How one language family writes strings and comments. Chosen from the file extension. */
export type SourceDialect = "javascript" | "go" | "rust" | "java" | "python";

type LongForm = (line: string, index: number) => StringOpening | undefined;
/**
 * A dialect row: its file extensions (space separated), its line-comment marker and whether such a comment can run on
 * into the next line (rule 9), how its block comments behave (rule 2), whether a `/` opens a regular expression
 * (rule 6, in `slash-position.ts`), and its forms that hold free text, tried in order.
 */
type SourceTraits = readonly [
	extensions: string,
	lineComment: string,
	blockComments: "none" | "flat" | "nested",
	regularExpressions: boolean,
	forms: readonly LongForm[],
];

/**
 * `.cs` (a verbatim `@"..."` string spans lines and escapes with a doubled quote, and its interpolated and raw forms
 * multiply the cases), `.scala` (XML literals hold free text), `.swift` (a `#"..."#` or `#"""…"""#` string may hold
 * plain quotes and `"""`, so the scanner would end it early), `.js`, `.tsx` and `.jsx` (the text between JSX tags is
 * free text that no quote delimits, and JSX is written in `.js` too), `c` and `c++` (`#if 0`, `#error` and `#warning`
 * hold free text, and `1'024` opens a character literal) and `kotlin` (a raw string ends only at the end of a run of
 * quotes, and a `${}` template inside an ordinary string holds code with its own strings) are out of this table on
 * purpose: they keep the data rule until their forms are scanned.
 */
const DIALECT_TRAITS: Readonly<Record<SourceDialect, SourceTraits>> = {
	javascript: [".ts .mts .cts .mjs .cjs", "//", "flat", true, [backtickAt(true), quotesAt("\"'", "backslash")]],
	go: [".go", "//", "flat", false, [backtickAt(false), quotesAt("\"'", "backslash")]],
	rust: [".rs", "//", "nested", false, [rustStringAt, rustCharAt]],
	java: [".java", "//", "flat", false, [textBlockAt, quotesAt("\"'", "never")]],
	python: [".py .pyi", "#", "none", false, [pythonStringAt]],
};

/** Undefined: the path is not a language this scanner knows; the caller must not treat the text as source. */
export function sourceDialectOf(path: string): SourceDialect | undefined {
	const dot = path.lastIndexOf(".");
	const extension = dot < 0 ? "" : path.slice(dot).toLowerCase();
	return (Object.keys(DIALECT_TRAITS) as SourceDialect[]).find((dialect) =>
		DIALECT_TRAITS[dialect][0].split(" ").includes(extension),
	);
}

export type SourceStretchKind = "code" | "string" | "comment";
/** The two facts a string stretch carries beyond its offsets (rule 2). */
type StretchFacts = { readonly delimiterStart?: number; readonly terminated?: boolean };

export interface SourceStretch extends StretchFacts {
	readonly start: number;
	readonly end: number;
	readonly kind: SourceStretchKind;
}

/** How far a quoted literal reaches past the end of a line: not at all, after a `\`, or always (rule 3). */
type StringCarry = "never" | "backslash" | "always";

/** One quoted literal: what ends its content, whether `\` escapes, where it may end, and whether `${` opens code. */
interface StringForm {
	readonly kind: "string";
	readonly close: string;
	readonly escapes: boolean;
	readonly carry: StringCarry;
	/** A template literal: `${` ends the text and opens a code expression (rule 5). */
	readonly interpolates?: true;
}

/** A literal found at a known offset: everything before `contentStart` is its code delimiter (rule 2). */
interface StringOpening extends StringForm {
	readonly contentStart: number;
}

/** What the scanner carries from one line to the next. Plain immutable data, comparable with JSON.stringify. */
export type SourceScanState = {
	/** Set only in the start state: the next line is the text's first (rule 3). */
	readonly first?: true;
	/** Constructs still open at the end of the last line, innermost last. */
	readonly open: readonly (
		| { readonly kind: "block-comment"; readonly depth: number }
		| StringForm
		| { readonly kind: "expression"; readonly depth: number }
	)[];
	/** What a `/` meets (rule 6); only the dialect that reads `/` sets it. */
	readonly slash?: SlashState;
};

export const SOURCE_SCAN_START: SourceScanState = { open: [], first: true };
type OpenConstruct = SourceScanState["open"][number];

const WORD_CHAR_RE = /[A-Za-z0-9_$]/u;
/** Python writes a prefix (`r`, `b`, `f`, `u`, alone or in pairs, any case) directly before the quote (rule 8). */
const PYTHON_STRING_RE = /(?:[rbfuRBFU]{1,2})?('''|"""|'|")/uy;
/** A rust raw string: an optional `b` or `c`, then `r`, any `#` run, then `"`, closed by `"` and that run (rule 3). */
const RUST_RAW_RE = /(?:b|c)?r(#*)"/uy;
/** A rust string with a byte or C prefix: `b"..."`, `c"..."`; the prefix letters belong to the delimiter (rule 2). */
const RUST_PLAIN_RE = /(?:b|c)?"/uy;

function isWordChar(char: string | undefined): boolean {
	return char !== undefined && WORD_CHAR_RE.test(char);
}

/** Neighbours of the same kind are one stretch, and no zero-length stretch exists (rule 1). */
function appendStretch(
	stretches: SourceStretch[],
	start: number,
	end: number,
	kind: SourceStretchKind,
	facts?: StretchFacts,
): void {
	if (end <= start) return;
	const last = stretches.at(-1);
	if (last?.kind === kind && last.end === start) stretches[stretches.length - 1] = { ...last, end };
	else stretches.push({ start, end, kind, ...facts });
}

/** Offsets no stretch covers were read as code, so the stretches cover the line from 0 to its length (rule 1). */
function withCodeGaps(stretches: readonly SourceStretch[], length: number): SourceStretch[] {
	const covered: SourceStretch[] = [];
	let end = 0;
	for (const stretch of stretches) {
		appendStretch(covered, end, stretch.start, "code");
		appendStretch(covered, stretch.start, stretch.end, stretch.kind, stretch);
		end = stretch.end;
	}
	appendStretch(covered, end, length, "code");
	return covered;
}

/** An unclosed literal carries over when the form spans lines, or after a `\` that escapes the newline (rule 3). */
function carriesOn(line: string, form: StringForm): boolean {
	return form.carry === "always" || (form.carry === "backslash" && /(?:^|[^\\])(?:\\\\)*\\$/u.test(line));
}

/** Where a literal's content ends: escapes, its terminator, and `${` for a template (rules 3, 4 and 5). */
function stringContentEnd(
	line: string,
	from: number,
	form: StringForm,
): { contentEnd: number; next: "end" | "expression" | "close" } {
	for (let index = from; index < line.length; index += 1) {
		const opensCode = form.interpolates === true && line.startsWith("${", index);
		if (form.escapes && line[index] === "\\") index += 1;
		else if (opensCode) return { contentEnd: index, next: "expression" };
		else if (line.startsWith(form.close, index)) return { contentEnd: index, next: "close" };
	}
	return { contentEnd: line.length, next: "end" };
}

/** The end of a regular expression body: a `/` outside a `[...]` class; it cannot span lines (rule 6). */
function regexContentEnd(line: string, from: number): { contentEnd: number; closed: boolean } {
	let inClass = false;
	for (let index = from; index < line.length; index += 1) {
		const char = line[index];
		if (char === "\\") index += 1;
		else if (char === "[") inClass = true;
		else if (char === "]") inClass = false;
		else if (char === "/" && !inClass) return { contentEnd: index, closed: true };
	}
	return { contentEnd: line.length, closed: false };
}

/** Where a block comment ends from `from`, counting the nesting rust and kotlin allow (rule 2). */
function blockCommentEnd(line: string, from: number, depth: number, nests: boolean): { end: number; depth: number } {
	let level = depth;
	for (let index = from; index < line.length; index += 1) {
		const opens = nests && line.startsWith("/*", index);
		if (!opens && !line.startsWith("*/", index)) continue;
		level += opens ? 1 : -1;
		index += 1;
		if (level === 0) return { end: index + 1, depth: 0 };
	}
	return { end: line.length, depth: level };
}

/** A quoted literal: `close` ends the content, and `${` opens code only in a template (rules 2, 4 and 5). */
function quotedAt(quote: string, index: number, carry: StringCarry, interpolates?: true): StringOpening {
	return { contentStart: index + quote.length, kind: "string", close: quote, escapes: true, carry, interpolates };
}
/** `'a'` and `'\n'` are character literals; `'a` in `Foo<'a>` is a lifetime and stays code (rule 7). */
function rustCharAt(line: string, index: number): StringOpening | undefined {
	if (line[index] !== "'") return undefined;
	const next = line[index + 1];
	const literal = { contentStart: index + 1, kind: "string", close: "'", carry: "never" } as const;
	if (next === "\\" || !isWordChar(next)) return { ...literal, escapes: true };
	return line[index + 2] === "'" ? { ...literal, escapes: false } : undefined;
}
/** An ordinary quoted literal: `chars` open it, a backslash escapes, and `carry` says how far it goes (rules 2-4). */
function quotesAt(chars: string, carry: StringCarry): LongForm {
	return (line, index) => {
		const char = line[index] ?? "";
		return char !== "" && chars.includes(char) ? quotedAt(char, index, carry) : undefined;
	};
}
/** A rust string, its prefix in the delimiter: `"..."`, `b"..."`, `r#"..."#`, `br"..."`, `cr#"..."#` (rules 2-4). */
function rustStringAt(line: string, index: number): StringOpening | undefined {
	RUST_RAW_RE.lastIndex = index;
	const raw = RUST_RAW_RE.exec(line);
	if (raw !== null) {
		const hashes = raw[1] ?? "";
		const close = `"${hashes}`;
		return { contentStart: index + raw[0].length, kind: "string", close, escapes: false, carry: "always" };
	}
	RUST_PLAIN_RE.lastIndex = index;
	const plain = RUST_PLAIN_RE.exec(line);
	// A prefix behind an identifier character is the tail of that identifier, not a prefix.
	if (plain === null || (plain[0].length > 1 && isWordChar(line[index - 1]))) return undefined;
	return { contentStart: index + plain[0].length, kind: "string", close: '"', escapes: true, carry: "always" };
}
function pythonStringAt(line: string, index: number): StringOpening | undefined {
	PYTHON_STRING_RE.lastIndex = index;
	const match = PYTHON_STRING_RE.exec(line);
	if (match === null) return undefined;
	const quote = match[1] ?? "";
	const prefixLength = match[0].length - quote.length;
	// A prefix behind an identifier character is the tail of that identifier, not a prefix.
	if (prefixLength > 0 && isWordChar(line[index - 1])) return undefined;
	const escapes = !/[rR]/u.test(match[0].slice(0, prefixLength));
	const carry = quote.length === 3 ? "always" : "backslash";
	return { ...quotedAt(quote, index + prefixLength, carry), escapes };
}
/** A backtick literal: a javascript template that `${` interrupts, or a raw go string (rules 3-5). */
function backtickAt(interpolates: boolean): LongForm {
	return (line, index) => {
		if (line[index] !== "`") return undefined;
		const form = quotedAt("`", index, "always");
		return interpolates ? { ...form, interpolates: true } : { ...form, escapes: false };
	};
}
/** The `"""` text block of java and kotlin, which carries over line ends and keeps escapes (rule 3). */
function textBlockAt(line: string, index: number): StringOpening | undefined {
	return line.startsWith('"""', index) ? quotedAt('"""', index, "always") : undefined;
}
/** The literal that starts at `index`: the first form of the dialect that matches (rule 2). */
function stringOpeningAt(line: string, index: number, forms: readonly LongForm[]): StringOpening | undefined {
	for (const form of forms) {
		const opening = form(line, index);
		if (opening !== undefined) return opening;
	}
}

/** Classifies one line (without its line terminator) given the state before it. */
export function scanSourceLine(
	line: string,
	state: SourceScanState,
	dialect: SourceDialect,
): { readonly stretches: readonly SourceStretch[]; readonly state: SourceScanState } {
	const stretches: SourceStretch[] = [];
	// A first line that starts with `#!` is a comment: a shebang names an interpreter, not code (rule 3).
	if (state.first === true && line.startsWith("#!")) {
		if (line.length > 0) appendStretch(stretches, 0, line.length, "comment");
		return { stretches, state: { open: [] } };
	}
	const [, lineComment, blockComments, regularExpressions, forms] = DIALECT_TRAITS[dialect];
	const open: OpenConstruct[] = [...state.open];
	/** Where each open literal's delimiter began on this line, by stack depth; erased once its content is stretched. */
	const delimiters: (number | undefined)[] = [];
	let index = 0;
	/** Only the dialect that reads `/` needs to know what kind of token came before, so only it reads one (rule 6). */
	const reader = regularExpressions ? createSlashReader(state.slash) : undefined;
	const stretch = (start: number, end: number, kind: SourceStretchKind, facts?: StretchFacts): void =>
		appendStretch(stretches, start, end, kind, facts);

	while (index < line.length) {
		const context = open.at(-1);

		if (context?.kind === "block-comment") {
			const comment = blockCommentEnd(line, index, context.depth, blockComments === "nested");
			stretch(index, comment.end, "comment");
			index = comment.end;
			if (comment.depth === 0) open.pop();
			else open[open.length - 1] = { kind: "block-comment", depth: comment.depth };
			continue;
		}
		if (context?.kind === "string") {
			const content = stringContentEnd(line, index, context);
			const delimiterStart = delimiters[open.length - 1];
			delimiters[open.length - 1] = undefined;
			stretch(index, content.contentEnd, "string", {
				...(delimiterStart === undefined ? {} : { delimiterStart }),
				terminated: content.next === "close",
			});
			index = content.contentEnd;
			if (content.next === "end") {
				if (!carriesOn(line, context)) open.pop();
			} else if (content.next === "expression") {
				open.push({ kind: "expression", depth: 1 });
				reader?.openExpression();
				index += 2;
			} else {
				index += context.close.length;
				reader?.endLiteral();
				open.pop();
			}
			continue;
		}

		const char = line[index] ?? "";
		if (line.startsWith(lineComment, index)) {
			stretch(index, line.length, "comment");
			break;
		}
		if (blockComments !== "none" && line.startsWith("/*", index)) {
			stretch(index, index + 2, "comment");
			open.push({ kind: "block-comment", depth: 1 });
			index += 2;
			continue;
		}
		const opening = stringOpeningAt(line, index, forms);
		if (opening !== undefined) {
			const { contentStart, ...form } = opening;
			open.push(form);
			delimiters[open.length - 1] = index;
			index = contentStart;
			continue;
		}
		if (reader !== undefined && char === "/" && reader.opensRegex()) {
			const body = regexContentEnd(line, index + 1);
			stretch(index + 1, body.contentEnd, "string");
			index = body.contentEnd;
			if (body.closed) {
				let flagsEnd = index + 1;
				while (isWordChar(line[flagsEnd])) flagsEnd += 1;
				index = flagsEnd;
			}
			reader.endLiteral();
			continue;
		}
		if (context?.kind === "expression" && (char === "{" || char === "}")) {
			const depth = context.depth + (char === "{" ? 1 : -1);
			if (depth === 0) open.pop();
			else open[open.length - 1] = { kind: "expression", depth };
		}
		index += reader?.read(line, index) ?? 1;
	}

	const carry: SourceScanState = reader === undefined ? { open } : { open, slash: reader.state() };
	return { stretches: withCodeGaps(stretches, line.length), state: carry };
}
