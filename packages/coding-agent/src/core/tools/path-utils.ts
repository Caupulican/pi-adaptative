import { accessSync, constants } from "node:fs";
import { access } from "node:fs/promises";
import { normalizePath, type PathInputOptions, resolvePath } from "../../utils/paths.ts";
import { isMissingPathError } from "../util/filesystem-errors.ts";

function tryCurlyQuoteVariant(filePath: string): string {
	// macOS uses U+2019 (right single quotation mark) in screenshot names like "Capture d'écran"
	// Users typically type U+0027 (straight apostrophe)
	return filePath.replace(/'/g, "\u2019");
}

function fileExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export async function pathExists(filePath: string): Promise<boolean> {
	try {
		await access(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

export function expandPath(filePath: string): string {
	return normalizePath(filePath, { normalizeUnicodeSpaces: true, stripAtPrefix: true });
}

/**
 * Resolve a path relative to the given cwd.
 * Handles ~ expansion and absolute paths.
 */
export function resolveToCwd(filePath: string, cwd: string, options?: PathInputOptions): string {
	return resolvePath(filePath, cwd, { normalizeUnicodeSpaces: true, stripAtPrefix: true, ...options });
}

/** One bounded spelling policy for CLI and backend reads. Never transforms the supplied cwd. */
function* readPathCandidates(filePath: string, cwd: string, options: PathInputOptions = {}): Generator<string> {
	const literalOptions = { ...options, normalizeUnicodeSpaces: false, stripAtPrefix: false };
	const candidates = new Set<string>();
	for (const cleanup of [false, true]) {
		const input = normalizePath(filePath, { ...options, normalizeUnicodeSpaces: cleanup, stripAtPrefix: cleanup });
		const nfd = input.normalize("NFD");
		for (const variant of [
			input,
			input.replace(/ (AM|PM)\./gi, "\u202F$1."),
			nfd,
			tryCurlyQuoteVariant(input),
			tryCurlyQuoteVariant(nfd),
		]) {
			const candidate = resolvePath(variant, cwd, literalOptions);
			if (candidates.has(candidate)) continue;
			candidates.add(candidate);
			yield candidate;
		}
	}
}

export function resolveReadPath(filePath: string, cwd: string): string {
	for (const candidate of readPathCandidates(filePath, cwd)) {
		if (fileExists(candidate)) return candidate;
	}
	return resolveToCwd(filePath, cwd);
}

/** The executing backend supplies access. Only missing resources permit a spelling fallback. */
export async function resolveReadPathAsync(
	filePath: string,
	cwd: string,
	accessPath: (path: string) => Promise<void>,
	options?: PathInputOptions,
	signal?: AbortSignal,
): Promise<string> {
	let firstMissing: unknown;
	for (const candidate of readPathCandidates(filePath, cwd, options)) {
		signal?.throwIfAborted();
		try {
			await accessPath(candidate);
			signal?.throwIfAborted();
			return candidate;
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
			firstMissing ??= error;
		}
	}
	throw firstMissing;
}
