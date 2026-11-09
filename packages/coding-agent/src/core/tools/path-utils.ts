import { accessSync, constants, type Dir, opendirSync } from "node:fs";
import { access } from "node:fs/promises";
import { dirname } from "node:path";
import { normalizePath, type PathInputOptions, readPathSpellings, resolvePath } from "../../kernel/utils/paths.ts";
import { isMissingPathError } from "../util/filesystem-errors.ts";

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

export function resolveReadPath(filePath: string, cwd: string): string {
	for (const candidate of readPathSpellings(filePath, cwd)) {
		try {
			accessSync(candidate, constants.F_OK);
			return candidate;
		} catch (error) {
			if (!isMissingPathError(error)) throw error;
		}
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
	for (const candidate of readPathSpellings(filePath, cwd, options)) {
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

const MAX_MISSING_PATH_HOPS = 8;
const MAX_MISSING_PATH_ENTRIES = 20;
const MAX_MISSING_PATH_EVIDENCE_CHARS = 800;

function boundMissingPathEvidence(text: string): string {
	return text.length <= MAX_MISSING_PATH_EVIDENCE_CHARS
		? text
		: `${text.slice(0, MAX_MISSING_PATH_EVIDENCE_CHARS - 1)}…`;
}

function fsErrorCode(error: unknown): string | undefined {
	return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
		? error.code
		: undefined;
}

function listBoundedAncestorEntries(dir: string): { names: string[]; truncated: boolean } | { error: string } {
	let handle: Dir | undefined;
	try {
		handle = opendirSync(dir);
		const names: string[] = [];
		while (names.length < MAX_MISSING_PATH_ENTRIES) {
			const entry = handle.readSync();
			if (!entry) return { names, truncated: false };
			names.push(entry.name);
		}
		return { names, truncated: true };
	} catch (error) {
		const code = fsErrorCode(error);
		if (code === "EACCES" || code === "EPERM") return { error: "listing denied" };
		if (code === "ENOTDIR") return { error: "not a directory" };
		return { error: "listing unavailable" };
	} finally {
		handle?.closeSync();
	}
}

/** Locate evidence for a missing path: first existing ancestor and a bounded entry list. Does not rewrite the path. */
export function formatMissingPathLocateEvidence(filePath: string, cwd: string, options?: PathInputOptions): string {
	const resolved = resolveToCwd(filePath, cwd, options);
	const prefix = `Path not found: ${resolved}.`;
	let dir = dirname(resolved);
	for (let hop = 0; hop < MAX_MISSING_PATH_HOPS; hop++) {
		try {
			accessSync(dir, constants.F_OK);
		} catch (error) {
			const code = fsErrorCode(error);
			if (code === "EACCES" || code === "EPERM") {
				return boundMissingPathEvidence(`${prefix} Ancestor ${dir} is not accessible.`);
			}
			const parent = dirname(dir);
			if (parent === dir) {
				return boundMissingPathEvidence(`${prefix} Search stopped after ${hop + 1} ancestor hops.`);
			}
			dir = parent;
			continue;
		}
		const listing = listBoundedAncestorEntries(dir);
		if ("error" in listing) {
			return boundMissingPathEvidence(`${prefix} Existing ancestor ${dir}: ${listing.error}.`);
		}
		const more = listing.truncated ? " …" : "";
		return boundMissingPathEvidence(`${prefix} Existing ancestor ${dir}: ${listing.names.join(", ")}${more}`);
	}
	return boundMissingPathEvidence(`${prefix} Search stopped after ${MAX_MISSING_PATH_HOPS} ancestor hops.`);
}
