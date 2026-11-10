/**
 * Masks program source text: each line is classified by the source scanner and every stretch is rewritten by what it
 * is — string and comment text as data, code only where it holds a hardcoded secret. It reads no files.
 *
 * No line of source is masked less than the data rule would mask it as plain text (`mockCredentialFields`), with one
 * exception made on purpose: a number in code. The data rule masks any number under a secret-named key, which hides
 * sizes and counts (`maxTokens: 16384`, `tokenCount = 0`) and no secret; here a number is a secret only when it is long
 * enough to be key material, or stands under a name whose last word says so (rule 6).
 */

import { redactTokenShapes } from "../security/secret-text.ts";
import {
	SOURCE_SCAN_START,
	type SourceDialect,
	type SourceScanState,
	type SourceStretch,
	scanSourceLine,
} from "../security/source-scanner.ts";
import {
	isCredentialSecretKey,
	LINE_PREFIX_RE,
	mockCredentialFields,
	mockedValue,
	mockQuotedSecretPairAcrossBreak,
} from "./credential-content-mock.ts";
import {
	BINDING_START,
	type BindingState,
	namesBeforeSeparator,
	readSecretBindings,
	SEPARATOR,
} from "./secret-binding.ts";

/** A separator followed by a number literal, a BigInt's `n` included: the text before it names the variable (rule 6). */
const SEPARATOR_NUMBER_RE = new RegExp(String.raw`(${SEPARATOR}\s*)(0[xX][0-9a-fA-F_]+n?|\d[\d_]*n?)(?![\w$.])`, "gu");
/**
 * The words that make any number a secret rather than a size or a port (rule 6). Each is read as the last word of a name
 * the secret-key rule already accepts, so `authPin` and `sessionPasscode` count and a bare `pin` does not.
 */
const STRONG_SECRET_WORDS = new Set(["password", "passwd", "pwd", "passphrase", "passcode", "pin", "secret"]);

/**
 * Masks program source text. `start` is the scanner state before the text's first line; `numbered` says the text puts
 * a line number and a separator before every line (`read` with `lineNumbers`, `nl`), which is not source text (rule 3).
 */
export function maskSourceText(text: string, dialect: SourceDialect, start: SourceScanState, numbered = false): string {
	return maskSourceLines(text, dialect, start, BINDING_START, numbered, undefined).text;
}

/**
 * The source mask for an output file that arrives in blocks: `PersistedOutputMask` calls it with blocks of complete
 * lines in output order, and only the final block may end without a line break. No text is held back between blocks, so
 * a last line without a terminator is masked with the others; what carries over is what a line reads of the lines before
 * it: the scanner's state, the bindings' and the line a quoted pair may go on from.
 */
export function createSourceBlockMask(dialect: SourceDialect, numbered: boolean): (block: string) => string {
	let state = SOURCE_SCAN_START;
	let bindings = BINDING_START;
	let pairStart: string | undefined;
	return (block) => {
		const masked = maskSourceLines(block, dialect, state, bindings, numbered, pairStart);
		state = masked.state;
		bindings = masked.bindings;
		pairStart = masked.pairStart;
		return masked.text;
	};
}

/** A line that ends with a quoted word and, after it, at most the pair's colon: a quoted pair may go on from it. */
const OPENS_PAIR_RE = /"\s*:?\s*$/u;
const BLANK_LINE_RE = /^\s*$/u;
const COLON_LINE_RE = /^\s*:\s*$/u;

/**
 * The text a quoted pair may go on from after `line`: the line itself when it ends with a quoted word, and the text
 * before it while only blank lines and the pair's one colon follow. Blank lines add nothing: the pair's separator is
 * any run of white space.
 */
function pairStartAfter(pairStart: string | undefined, line: string): string | undefined {
	if (OPENS_PAIR_RE.test(line)) return line;
	if (pairStart === undefined || BLANK_LINE_RE.test(line)) return pairStart;
	return COLON_LINE_RE.test(line) && !pairStart.endsWith(":") ? `${pairStart}\n:` : undefined;
}

function lastLineOf(text: string): string {
	return text.slice(text.lastIndexOf("\n") + 1);
}

/**
 * The mask of whole lines, and what the next line reads of them: the scanner's state, the bindings' and the text a quoted
 * pair may go on from (rules 1-3).
 */
function maskSourceLines(
	text: string,
	dialect: SourceDialect,
	start: SourceScanState,
	bindings: BindingState,
	numbered: boolean,
	pairStartBefore: string | undefined,
): {
	readonly text: string;
	readonly state: SourceScanState;
	readonly bindings: BindingState;
	readonly pairStart: string | undefined;
} {
	const parts: string[] = [];
	let state = start;
	let bindingState = bindings;
	let pairStart = pairStartBefore;
	let index = 0;
	while (index < text.length) {
		const newline = text.indexOf("\n", index);
		const terminator = newline < 0 ? "" : text[newline - 1] === "\r" ? "\r\n" : "\n";
		const end = newline < 0 ? text.length : newline + 1;
		const line = text.slice(index, end - terminator.length);
		// A numbered output puts `N: ` or `N` and a tab before each line: the prefix stays as it was, and the scanner
		// never sees it, so it cannot read a number as source text (rule 3).
		const prefix = numbered ? (LINE_PREFIX_RE.exec(line)?.[0] ?? "") : "";
		const source = line.slice(prefix.length);
		const scanned = scanSourceLine(source, state, dialect);
		const read = readSecretBindings(source, scanned.stretches, bindingState, dialect);
		const masked = maskSourceLine(source, scanned.stretches, read.names);
		// A hardcoded secret is string text. A line whose every string stretch was replaced, or that has none, holds no
		// other: it stays as the source rule left it. A line that keeps string text also gets the data rule of a line, the
		// one every text gets, so that no line of source is masked less than it would be as plain text.
		const keepsText = scanned.stretches.some((stretch, position) =>
			keepsStringText(source, stretch, read.names[position]),
		);
		let shown = `${prefix}${keepsText ? mockCredentialFields(masked) : masked}`;
		// The data rule reads a quoted secret pair across a line break: its key ends one line and its value starts the
		// next. Such a value is masked as that rule masks it, whatever the scanner made of the two lines: on the line as
		// it is shown, or, when the pair no longer reads there, by the data rule's own line.
		if (pairStart !== undefined && mockQuotedSecretPairAcrossBreak(pairStart, line) !== undefined) {
			shown =
				mockQuotedSecretPairAcrossBreak(pairStart, shown) ??
				lastLineOf(mockCredentialFields(`${pairStart}\n${line}`));
		}
		parts.push(shown, terminator);
		state = scanned.state;
		bindingState = read.state;
		pairStart = pairStartAfter(pairStart, line);
		index = end;
	}
	return { text: parts.join(""), state, bindings: bindingState, pairStart };
}

/** Rewrites one line stretch by stretch, leaving the text between stretches as it was (rule 1). */
function maskSourceLine(
	line: string,
	stretches: readonly SourceStretch[],
	names: readonly (string | undefined)[],
): string {
	const parts: string[] = [];
	let offset = 0;
	for (let position = 0; position < stretches.length; position += 1) {
		const stretch = stretches[position];
		parts.push(line.slice(offset, stretch.start), maskStretch(line, stretches, position, names[position]));
		offset = stretch.end;
	}
	parts.push(line.slice(offset));
	return parts.join("");
}

/** One stretch, by the kind the scanner gave it (rules 1 and 3). */
function maskStretch(
	line: string,
	stretches: readonly SourceStretch[],
	position: number,
	name: string | undefined,
): string {
	const stretch = stretches[position];
	const text = line.slice(stretch.start, stretch.end);
	if (stretch.kind === "code") return maskCode(text);
	if (stretch.kind === "comment") return mockCredentialFields(text);
	if (name !== undefined && isSecretLiteral(text, stretch, name)) return mockedValue(name);
	return mockCredentialFields(text);
}

/** A literal written the way a constant or an environment variable is named: `OPENAI_API_KEY`, `DB_PASSWORD` (rule 3). */
const CONSTANT_NAME_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/u;
/** The name of a digest or of a text encoding, as code that handles secrets passes it to its library (rule 3). */
const ENCODING_NAME_RE =
	/^(?:sha-?(?:1|224|256|384|512)|md5|hex|base64(?:url)?|utf-?8|utf-?16(?:le|be)?|ascii|latin1|binary)$/iu;

/**
 * Is this stretch string text that the source rule leaves as written? A whole literal that is no secret is; so is every
 * piece of a literal that is not whole on its line, which the source rule never replaces: a template's text beside a
 * `${}`, the opening or closing line of a literal that spans lines, the body of a regular expression (rule 3).
 */
function keepsStringText(line: string, stretch: SourceStretch, name: string | undefined): boolean {
	if (stretch.kind !== "string") return false;
	const text = line.slice(stretch.start, stretch.end);
	return text !== "" && (name === undefined || !isSecretLiteral(text, stretch, name));
}

/**
 * Is this whole literal the hardcoded secret itself? Four kinds of literal in value position are not, and keep the data
 * rule (rule 3): one that only spells the binding's own name (a lookup by that name); one written as a constant's name
 * (it names a variable, as in `getenv("OPENAI_API_KEY")`); the name of a digest or an encoding (`createHash("sha256")`);
 * and one of at most two characters (a delimiter, as in `split(":")`: nothing that short is a secret).
 */
function isSecretLiteral(text: string, stretch: SourceStretch, name: string): boolean {
	if (stretch.delimiterStart === undefined || stretch.terminated !== true) return false;
	if (text.length <= 2 || CONSTANT_NAME_RE.test(text) || ENCODING_NAME_RE.test(text)) return false;
	return foldedName(text) !== foldedName(name);
}

/** A name compared without case, `_` and `-`: `apiKey`, `api_key` and `API-KEY` are one name (rule 3). */
function foldedName(name: string): string {
	return name.toLowerCase().replace(/[_-]/gu, "");
}

/** Code keeps its text: value-shaped secrets go, and so does a number assigned to a secret name (rule 6). */
function maskCode(text: string): string {
	const code = redactTokenShapes(text);
	return code.replace(SEPARATOR_NUMBER_RE, (match, head: string, literal: string, offset: number) => {
		const name = namesBeforeSeparator(code.slice(0, offset)).find(isCredentialSecretKey);
		return name !== undefined && isSecretNumber(literal, name) ? `${head}${mockedValue(name)}` : match;
	});
}

/**
 * Does this number literal hide a secret? Under a strong secret name any four digits do; under any name a secret key
 * accepts, key material is long — twelve decimal digits or sixteen hex ones (rule 6).
 */
function isSecretNumber(literal: string, name: string): boolean {
	const digits = literal.replace(/_|n$/gu, "");
	const length = digits.slice(0, 2).toLowerCase() === "0x" ? digits.length - 2 : digits.length;
	const keyMaterial = digits.slice(0, 2).toLowerCase() === "0x" ? 16 : 12;
	return length >= keyMaterial || (isStrongSecretName(name) && length >= 4);
}

/** Does the last word of the name say its value is a secret? (rule 6) */
function isStrongSecretName(name: string): boolean {
	return STRONG_SECRET_WORDS.has(lastWordOf(name));
}

/** The last word of an identifier: `dbUserPassword` and `db_user_password` both end in `password`. */
function lastWordOf(name: string): string {
	const words = name.replace(/([a-z0-9])([A-Z])/gu, "$1 $2").split(/[^A-Za-z0-9]+/u);
	return (words.at(-1) ?? "").toLowerCase();
}
