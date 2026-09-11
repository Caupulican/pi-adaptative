import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from "node:path";
import { stripBom } from "../../utils/text.ts";

/**
 * A source charset the project declares for itself. `.editorconfig` is the standard, authoritative
 * place to record it, so a legacy tree (Delphi units, Windows resources) states its encoding once
 * instead of every read and edit having to guess or ask.
 */
export interface DeclaredEncoding {
	/** Codec name for the decoder, already mapped out of EditorConfig's charset vocabulary. */
	encoding: string;
	/** Absolute path of the `.editorconfig` that declared it. */
	source: string;
}

/** One `fileEncodings` rule: an EditorConfig-style glob, relative to the working directory. */
export interface FileEncodingRule {
	glob: string;
	encoding: string;
}

/** Where a resolved charset came from, in the order the harness consults them. */
export type FileEncodingSource = "argument" | "settings" | "editorconfig";

export interface ResolvedFileEncoding {
	encoding: string;
	source: FileEncodingSource;
	/** Absolute path of the `.editorconfig` that declared it; present only for `"editorconfig"`. */
	declaredIn?: string;
}

interface EditorConfigSection {
	pattern: string;
	charset?: string;
}

interface ParsedEditorConfig {
	root: boolean;
	sections: EditorConfigSection[];
}

interface NumericRange {
	min: number;
	max: number;
}

/** Parsed files are reused until the file itself changes. */
/**
 * Parsed `.editorconfig` files by path, keyed on their exact bytes. An mtime key missed a rewrite
 * inside one timestamp tick (a fast NTFS host served the previous charset); the file is tiny, so
 * reading and comparing it costs what the stat did and cannot miss a change.
 */
const parsedFiles = new Map<string, { bytes: Buffer; parsed: ParsedEditorConfig }>();

/**
 * EditorConfig's charset vocabulary is `latin1`, `utf-8`, `utf-8-bom`, `utf-16be`, `utf-16le`.
 *
 * `latin1` is ISO-8859-1 on paper, but the Windows toolchains that still emit it (Delphi included)
 * write its superset windows-1252: every ISO-8859-1 byte decodes identically under 1252, and the
 * 0x80-0x9F range — undefined in 8859-1 — carries the curly quotes and dashes those files really
 * contain. Decoding as 1252 is therefore lossless for a true 8859-1 file and correct for the
 * common one, so the declaration maps to `windows-1252`.
 *
 * `utf-8` and `utf-8-bom` declare the strict default the decoder already applies, and a BOM
 * recovers on its own, so they name no codec. Anything else passes through unchanged: the codec
 * runner is the authority on codec names and rejects the ones it cannot honor.
 */
function codecForCharset(charset: string): string | undefined {
	if (charset === "latin1") return "windows-1252";
	if (charset === "utf-8" || charset === "utf-8-bom") return undefined;
	return charset;
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

/**
 * A character class keeps its source spelling, including ranges; only the characters that would
 * change the class's own structure are escaped. Returns undefined when the brackets are not a
 * class at all, so the caller can emit a literal `[`.
 */
function translateBracket(pattern: string, start: number): { source: string; end: number } | undefined {
	let index = start + 1;
	let negated = false;
	if (pattern[index] === "!" || pattern[index] === "^") {
		negated = true;
		index += 1;
	}
	const contentStart = index;
	if (pattern[index] === "]") index += 1;
	while (index < pattern.length && pattern[index] !== "]") {
		if (pattern[index] === "\\") index += 1;
		index += 1;
	}
	if (index >= pattern.length) return undefined;
	const content = pattern.slice(contentStart, index);
	// EditorConfig classes never cross a path separator; brackets holding one are literal text.
	if (content.includes("/")) return undefined;
	let body = "";
	for (let cursor = 0; cursor < content.length; cursor++) {
		let character = content[cursor];
		if (character === "\\" && cursor + 1 < content.length) {
			cursor += 1;
			character = content[cursor];
		}
		body +=
			character === "\\" || character === "]" || (character === "^" && body === "") ? `\\${character}` : character;
	}
	return { source: `[${negated ? "^" : ""}${body}]`, end: index + 1 };
}

/**
 * `{s1,s2}` alternates, `{num1..num2}` matches an integer in range. A brace group holding neither a
 * comma nor a range is literal text in EditorConfig, which this reports by returning undefined.
 */
function translateBrace(
	pattern: string,
	start: number,
	ranges: NumericRange[],
): { source: string; end: number } | undefined {
	const numeric = /^\{([+-]?\d+)\.\.([+-]?\d+)\}/.exec(pattern.slice(start));
	if (numeric) {
		const first = Number(numeric[1]);
		const second = Number(numeric[2]);
		ranges.push({ min: Math.min(first, second), max: Math.max(first, second) });
		return { source: "([+-]?\\d+)", end: start + numeric[0].length };
	}
	const mark = ranges.length;
	const alternatives: string[] = [];
	let index = start + 1;
	for (;;) {
		const segment = translateSequence(pattern, index, true, ranges);
		alternatives.push(segment.source);
		index = segment.end;
		if (pattern[index] === ",") {
			index += 1;
			continue;
		}
		if (pattern[index] === "}") {
			index += 1;
			break;
		}
		ranges.length = mark;
		return undefined;
	}
	if (alternatives.length < 2) {
		ranges.length = mark;
		return undefined;
	}
	return { source: `(?:${alternatives.join("|")})`, end: index };
}

/**
 * EditorConfig glob semantics: `*` stops at a path separator, `**` crosses them, `?` is one
 * character inside a component, and `\` escapes the next character.
 */
function translateSequence(
	pattern: string,
	start: number,
	nested: boolean,
	ranges: NumericRange[],
): { source: string; end: number } {
	let source = "";
	let index = start;
	while (index < pattern.length) {
		const character = pattern[index];
		if (nested && (character === "," || character === "}")) break;
		if (character === "\\") {
			const escaped = pattern[index + 1];
			source += escaped === undefined ? "\\\\" : escapeRegExp(escaped);
			index += escaped === undefined ? 1 : 2;
			continue;
		}
		if (character === "*") {
			if (pattern[index + 1] === "*") {
				source += ".*";
				index += 2;
			} else {
				source += "[^/]*";
				index += 1;
			}
			continue;
		}
		if (character === "?") {
			source += "[^/]";
			index += 1;
			continue;
		}
		if (character === "[") {
			const bracket = translateBracket(pattern, index);
			if (bracket) {
				source += bracket.source;
				index = bracket.end;
				continue;
			}
		}
		if (character === "{") {
			const brace = translateBrace(pattern, index, ranges);
			if (brace) {
				source += brace.source;
				index = brace.end;
				continue;
			}
		}
		source += escapeRegExp(character);
		index += 1;
	}
	return { source, end: index };
}

/**
 * A section name without `/` matches the file name anywhere below the declaring directory; one
 * with `/` is relative to that directory. The directory itself is literal text, never a glob.
 */
function sectionMatches(pattern: string, configDirectory: string, target: string): boolean {
	const ranges: NumericRange[] = [];
	const anchored = pattern.includes("/");
	const glob = anchored && pattern.startsWith("/") ? pattern.slice(1) : pattern;
	const prefix = `${escapeRegExp(toPosix(configDirectory).replace(/\/+$/, ""))}/`;
	const body = `${anchored ? "" : "(?:.*/)?"}${translateSequence(glob, 0, false, ranges).source}`;
	const match = new RegExp(`^${prefix}${body}$`).exec(toPosix(target));
	if (!match) return false;
	return ranges.every((range, index) => {
		const value = Number(match[index + 1]);
		return Number.isInteger(value) && value >= range.min && value <= range.max;
	});
}

function parseEditorConfig(text: string): ParsedEditorConfig {
	const sections: EditorConfigSection[] = [];
	let root = false;
	let current: EditorConfigSection | undefined;
	for (const rawLine of text.split(/\r\n|\r|\n/)) {
		const line = rawLine.trim();
		if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
		if (line.startsWith("[") && line.endsWith("]")) {
			current = { pattern: line.slice(1, -1) };
			sections.push(current);
			continue;
		}
		const separator = line.search(/[=:]/);
		if (separator === -1) continue;
		const key = line.slice(0, separator).trim().toLowerCase();
		const value = line
			.slice(separator + 1)
			.trim()
			.toLowerCase();
		if (current === undefined) {
			if (key === "root") root = value === "true";
			continue;
		}
		if (key === "charset") current.charset = value;
	}
	return { root, sections };
}

async function loadEditorConfig(path: string): Promise<ParsedEditorConfig | undefined> {
	let bytes: Buffer;
	try {
		bytes = await readFile(path);
	} catch (error) {
		// A directory without an .editorconfig is the normal case, not a failure; anything else is.
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ENAMETOOLONG" || code === "EISDIR") return undefined;
		throw error;
	}
	const cached = parsedFiles.get(path);
	if (cached?.bytes.equals(bytes)) return cached.parsed;
	const parsed = parseEditorConfig(stripBom(bytes.toString("utf-8")));
	parsedFiles.set(path, { bytes, parsed });
	return parsed;
}

/**
 * The charset the project declares for one file, or undefined when it declares none. The nearest
 * `.editorconfig` wins, later sections override earlier ones inside a file, and a file declaring
 * `root = true` ends the walk.
 */
export async function resolveDeclaredEncoding(
	absolutePath: string,
	options?: { stopAt?: string; signal?: AbortSignal },
): Promise<DeclaredEncoding | undefined> {
	options?.signal?.throwIfAborted();
	const target = resolvePath(absolutePath);
	const stopAt = options?.stopAt === undefined ? undefined : resolvePath(options.stopAt);
	let directory = dirname(target);
	for (;;) {
		options?.signal?.throwIfAborted();
		const configPath = join(directory, ".editorconfig");
		const parsed = await loadEditorConfig(configPath);
		if (parsed) {
			for (let index = parsed.sections.length - 1; index >= 0; index--) {
				const section = parsed.sections[index];
				if (section.charset === undefined || !sectionMatches(section.pattern, directory, target)) continue;
				const encoding = codecForCharset(section.charset);
				// The nearest declaration is the answer even when it names no codec: a file declared
				// UTF-8 must not inherit a legacy charset from a directory further up.
				return encoding === undefined ? undefined : { encoding, source: configPath };
			}
			if (parsed.root) return undefined;
		}
		if (stopAt !== undefined && directory === stopAt) return undefined;
		const parent = dirname(directory);
		if (parent === directory) return undefined;
		directory = parent;
	}
}

/** How a charset the codec resolved from the file's own bytes is named to the model. */
export const PYTHON_DETECTION_SOURCE = "python detection";

/**
 * Name the evidence the way the reader would type it: a declaring file relative while it is inside
 * the working directory, absolute once it is outside, never a path that walks back out of the tree.
 */
export function describeFileEncodingSource(resolved: ResolvedFileEncoding, cwd: string): string {
	if (resolved.source === "argument") return "the encoding argument";
	if (resolved.source === "settings") return "settings fileEncodings";
	const declaredIn = resolved.declaredIn ?? "";
	const relativePath = relative(cwd, declaredIn);
	return relativePath === "" || relativePath.startsWith("..") || isAbsolute(relativePath)
		? declaredIn
		: relativePath.split(sep).join("/");
}

/**
 * The charset for one file, from the only places that can state it without guessing: the call's own
 * argument, the user's `fileEncodings` setting, then the project's `.editorconfig`. Nothing here
 * inspects bytes — a file no declaration covers is resolved later, from its content, by the managed
 * Python codec.
 */
export async function resolveFileEncoding(
	absolutePath: string,
	cwd: string,
	settings?: {
		argument?: string;
		fileEncodings?: readonly FileEncodingRule[];
		stopAt?: string;
		signal?: AbortSignal;
	},
): Promise<ResolvedFileEncoding | undefined> {
	settings?.signal?.throwIfAborted();
	if (settings?.argument !== undefined) return { encoding: settings.argument, source: "argument" };
	const target = resolvePath(absolutePath);
	for (const rule of settings?.fileEncodings ?? []) {
		// First match in declaration order wins, exactly as a section list is read top to bottom.
		if (sectionMatches(rule.glob, resolvePath(cwd), target)) return { encoding: rule.encoding, source: "settings" };
	}
	const declared = await resolveDeclaredEncoding(absolutePath, {
		stopAt: settings?.stopAt,
		signal: settings?.signal,
	});
	return declared ? { encoding: declared.encoding, source: "editorconfig", declaredIn: declared.source } : undefined;
}

/**
 * What the codec resolved from a file's own bytes, so a read and the edit that follows it agree on
 * one charset instead of each paying for its own detection. The modification time is the witness:
 * different bytes are a different file, and the entry stops applying the moment they change.
 */
const detectedEncodings = new Map<string, string>();
const MAX_REMEMBERED_DETECTIONS = 512;

function detectionKey(absolutePath: string, mtimeMs: number): string {
	return `${resolvePath(absolutePath)}\0${mtimeMs}`;
}

export function rememberDetectedFileEncoding(absolutePath: string, mtimeMs: number, encoding: string): void {
	const key = detectionKey(absolutePath, mtimeMs);
	detectedEncodings.delete(key);
	detectedEncodings.set(key, encoding);
	for (const oldest of detectedEncodings.keys()) {
		if (detectedEncodings.size <= MAX_REMEMBERED_DETECTIONS) break;
		detectedEncodings.delete(oldest);
	}
}

export function recallDetectedFileEncoding(absolutePath: string, mtimeMs: number): string | undefined {
	return detectedEncodings.get(detectionKey(absolutePath, mtimeMs));
}

/** Test seam: the cache is session state, not a cross-test fixture. */
export function forgetDetectedFileEncodings(): void {
	detectedEncodings.clear();
}
