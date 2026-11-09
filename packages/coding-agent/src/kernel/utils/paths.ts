import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { type ExecutionPathFlavor, executionPathApi, resolveExecutionPath } from "../execution-paths.ts";

export {
	assertExecutionAbsolutePath,
	createExecutionContext,
	type ExecutionAttachment,
	type ExecutionContext,
	type ExecutionPathAuthority,
	type ExecutionPathFlavor,
	type ExecutionResourceReference,
	executionPathApi,
	resolveExecutionPath,
	resolveExecutionResource,
} from "../execution-paths.ts";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

export interface PathInputOptions {
	/** Executing backend's dialect. Native CLI callers default to the local platform. */
	flavor?: ExecutionPathFlavor;
	/** Trim leading/trailing whitespace before normalization. */
	trim?: boolean;
	/** Expand leading `~` to a home directory. Defaults to true. */
	expandTilde?: boolean;
	/** Home directory used for `~` expansion. Defaults to `os.homedir()`. */
	homeDir?: string;
	/** Strip a leading `@`, used for CLI @file paths. */
	stripAtPrefix?: boolean;
	/** Normalize unicode space variants to regular spaces. */
	normalizeUnicodeSpaces?: boolean;
}

export function normalizePath(input: string, options: PathInputOptions = {}): string {
	const flavor = options.flavor ?? (process.platform === "win32" ? "win32" : "posix");
	const paths = executionPathApi(flavor);
	let normalized = options.trim ? input.trim() : input;
	if (options.normalizeUnicodeSpaces) {
		normalized = normalized.replace(UNICODE_SPACES, " ");
	}
	if (options.stripAtPrefix && normalized.startsWith("@")) {
		normalized = normalized.slice(1);
	}

	if (
		(options.expandTilde ?? true) &&
		(normalized === "~" || normalized.startsWith("~/") || (flavor === "win32" && normalized.startsWith("~\\")))
	) {
		const home = options.homeDir ?? (options.flavor === undefined ? homedir() : undefined);
		if (home === undefined) throw new Error("Explicit execution backend requires an explicit home directory");
		return normalized === "~" ? home : paths.join(home, normalized.slice(2));
	}

	if (/^file:\/\//.test(normalized)) {
		return fileURLToPath(normalized, { windows: flavor === "win32" });
	}

	return normalized;
}

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "’");
}

/**
 * The spellings a read of one path argument tries, in the order the read resolver tries them: the cleaned and the literal
 * form of the argument, NFD, the curly-quote variants, and the `@`-stripped form. The read tools open the first of them that
 * exists; the scope gates judge every one (see `toolPathSpellings`).
 */
export function* readPathSpellings(input: string, baseDir: string, options: PathInputOptions = {}): Generator<string> {
	const literalOptions = { ...options, normalizeUnicodeSpaces: false, stripAtPrefix: false };
	const candidates = new Set<string>();
	for (const cleanup of [false, true]) {
		const normalized = normalizePath(input, { ...options, normalizeUnicodeSpaces: cleanup, stripAtPrefix: cleanup });
		const nfd = normalized.normalize("NFD");
		for (const variant of [
			normalized,
			normalized.replace(/ (AM|PM)\./gi, " $1."),
			nfd,
			tryCurlyQuoteVariant(normalized),
			tryCurlyQuoteVariant(nfd),
		]) {
			const candidate = resolvePath(variant, baseDir, literalOptions);
			if (candidates.has(candidate)) continue;
			candidates.add(candidate);
			yield candidate;
		}
	}
}

/**
 * Every absolute path a tool may open for one path argument: the read spellings above and the single resolution that write,
 * edit and search use. A scope gate judges all of them, so it judges the path the tool opens whichever one it settles on.
 * Undefined when the argument cannot be resolved at all (a `~` with no home directory, a NUL byte): the gate refuses it.
 */
export function toolPathSpellings(
	input: string,
	baseDir: string,
	options: PathInputOptions = {},
): string[] | undefined {
	try {
		const spellings = new Set(readPathSpellings(input, baseDir, options));
		spellings.add(resolvePath(input, baseDir, { normalizeUnicodeSpaces: true, stripAtPrefix: true, ...options }));
		return [...spellings];
	} catch {
		return undefined;
	}
}

export function resolvePath(input: string, baseDir: string = process.cwd(), options: PathInputOptions = {}): string {
	const normalized = normalizePath(input, options);
	// Input cleanup is not authority to rename the supplied directory. File URLs and explicit
	// home shortcuts still decode, but literal directory bytes (including trailing spaces) stay.
	const normalizedBaseDir = normalizePath(baseDir, {
		...options,
		stripAtPrefix: false,
		normalizeUnicodeSpaces: false,
		trim: false,
	});
	const flavor = options.flavor ?? (process.platform === "win32" ? "win32" : "posix");
	// Ambient defaults belong only to this native input adapter. Explicit backend contexts
	// must already provide a fully qualified directory and never borrow the operator's drive.
	const cwd = options.flavor === undefined ? executionPathApi(flavor).resolve(normalizedBaseDir) : normalizedBaseDir;
	return resolveExecutionPath(normalized, cwd, flavor);
}
