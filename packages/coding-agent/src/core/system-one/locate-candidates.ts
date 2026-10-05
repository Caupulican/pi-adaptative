/**
 * Candidate files for `systemone locate`: deterministic search, never judgment.
 *
 * The caller chose the queries; this module runs each through ripgrep (the managed binary the search tools use,
 * ignore rules and all), unions the hits by file, and cuts one short card per file (leading comment, declared names, a window around its best hit).
 * The router sends pulls this large to ripgrep by its own measured policy (`exhaustive_limit`), so the resident
 * index is not consulted here. Every excerpt is read only after the file passes the same scope and credential
 * checks the evidence materializer applies, and is redacted before anything leaves this module.
 */

import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { waitForChildProcessWithTermination } from "../../utils/child-process.ts";
import { isPathWithinScope, safeRealpathSync } from "../autonomy/path-scope.ts";
import { type CredentialExposureBoundary, isProtectedCredentialPath } from "../secrets/credential-exposure-guard.ts";
import { type ManagedSearchToolOptions, resolveManagedSearchTool } from "../tools/managed-search-tool.ts";
import { resolveToCwd } from "../tools/path-utils.ts";
import { LocateInputError } from "./locate-input.ts";

/** Lines on each side of a hit that make one cluster when a file's best hit is chosen. */
export const LOCATE_WINDOW_RADIUS = 6;
/** Lines kept on each side of the best hit in a file's card: the card's other parts say what the file is. */
export const LOCATE_EXCERPT_RADIUS = 3;
/** Files that reach judgment, the best by lexical order; the rest are counted, never silently dropped. */
export const MAX_LOCATE_CANDIDATES = 24;
/** Doc-comment lines and declared names on a file's card. */
const MAX_CARD_DOC_LINES = 6;
const MAX_CARD_DECLARATIONS = 10;
const MAX_CARD_LINE_CHARS = 140;
/** A query past this many hits stops the search, which makes its ranking depend on walk order; it is reported. */
const MAX_HITS_PER_QUERY = 100_000;
const MAX_HITS_PER_FILE = 40;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_EXCERPT_LINE_CHARS = MAX_CARD_LINE_CHARS;
const SEARCH_TIMEOUT_MS = 30_000;
const SEARCH_KILL_GRACE_MS = 1_000;

/** One matching line of one file, relative to the working directory with `/` separators. */
export interface LocateHit {
	readonly path: string;
	readonly line: number;
	/** The matching line's own text, which decides whether the hit is a declaration. */
	readonly text: string;
}

export interface LocateQueryResult {
	readonly hits: readonly LocateHit[];
	/** Why the query could not run (an invalid pattern, for example); its hits are then empty. */
	readonly error?: string;
	/** The search stopped at the hit cap, so the hits are a walk-order sample. */
	readonly truncated?: boolean;
}

/** Runs one query over `roots` (absolute); the default is ripgrep. */
export type LocateSearch = (
	query: string,
	roots: readonly string[],
	cwd: string,
	signal?: AbortSignal,
) => Promise<LocateQueryResult>;

export interface LocateCandidate {
	readonly path: string;
	/** The best hit: where the file's hits cluster (see {@link rankLocateFiles}). */
	readonly line: number;
	/** Matching (query, line) pairs in the file; orders which candidates are judged first. */
	readonly hitCount: number;
	/** The best hit's own line, redacted and clipped, for display. */
	readonly matchLine: string;
	/** The file's leading comment (at most {@link MAX_CARD_DOC_LINES} lines): what the file says it is. Redacted. */
	readonly doc: string;
	/** Names the file declares, queried and exported first (at most {@link MAX_CARD_DECLARATIONS}): what it holds. */
	readonly declarations: readonly string[];
	/** Redacted lines around the best hit, clipped by line, never mid-token. */
	readonly excerpt: string;
}

export interface LocateCandidateSet {
	/** At most {@link MAX_LOCATE_CANDIDATES}, in judging order (see {@link rankLocateFiles}). */
	readonly candidates: readonly LocateCandidate[];
	/** Files with at least one hit, before the cap, scope and readability filters. */
	readonly filesMatched: number;
	/** Files left out for being out of scope, protected, binary, too large or unreadable. */
	readonly excluded: number;
	/** Matching files beyond the cap, never judged. */
	readonly beyondCap: number;
	readonly invalidQueries: readonly { readonly query: string; readonly message: string }[];
	/** Queries whose search hit the cap; their hits are a sample, not the whole repository. */
	readonly truncatedQueries: readonly string[];
}

function toRelativePosix(cwd: string, absolute: string): string {
	return path.relative(cwd, absolute).split(path.sep).join("/");
}

/** The default search: ripgrep with smart case over the given roots, hits streamed and capped. */
export function ripgrepLocateSearch(options?: ManagedSearchToolOptions): LocateSearch {
	return async (query, roots, cwd, signal) => {
		const rg = await resolveManagedSearchTool("rg", options?.managedToolResolver);
		const args = [
			"--json",
			"--line-number",
			"--color=never",
			"--smart-case",
			"--no-messages",
			"--max-count",
			String(MAX_HITS_PER_FILE),
			"--max-filesize",
			String(MAX_FILE_BYTES),
			"-e",
			query,
			"--",
			...roots,
		];
		const child = spawn(rg, args, { cwd, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
		const terminationController = new AbortController();
		const onAbort = () => terminationController.abort();
		if (signal?.aborted) onAbort();
		else signal?.addEventListener("abort", onAbort, { once: true });
		const hits: LocateHit[] = [];
		let capped = false;
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const lines = createInterface({ input: child.stdout });
		lines.on("line", (line) => {
			if (capped || !line.trim()) return;
			let event: {
				type?: string;
				data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
			};
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			const file = event.data?.path?.text;
			const lineNumber = event.data?.line_number;
			if (event.type !== "match" || !file || typeof lineNumber !== "number") return;
			hits.push({
				path: toRelativePosix(cwd, path.resolve(cwd, file)),
				line: lineNumber,
				text: event.data?.lines?.text ?? "",
			});
			if (hits.length >= MAX_HITS_PER_QUERY) {
				capped = true;
				terminationController.abort();
			}
		});
		const terminal = await waitForChildProcessWithTermination(child, {
			signal: terminationController.signal,
			timeoutMs: SEARCH_TIMEOUT_MS,
			killGraceMs: SEARCH_KILL_GRACE_MS,
		}).finally(() => {
			lines.close();
			signal?.removeEventListener("abort", onAbort);
		});
		if (signal?.aborted) throw new Error("Operation aborted");
		if (terminal.reason === "timeout") return { hits, error: `search timed out after ${SEARCH_TIMEOUT_MS} ms` };
		// rg exits 1 for no match; 2 is an unusable pattern or root when nothing was found.
		if (!capped && terminal.code !== 0 && terminal.code !== 1 && hits.length === 0)
			return { hits, error: stderr.trim() || `ripgrep exited with code ${terminal.code}` };
		return capped ? { hits, truncated: true } : { hits };
	};
}

/**
 * The name a line declares, when it opens a definition at file or class-member depth (a block-local `const` is a
 * use, not a definition): keyword forms across the languages the repository holds, then bare method signatures.
 */
const DECLARATION_KEYWORD =
	/^(?:\t| {1,4})?(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:(?:public|private|protected|static|readonly|override|pub)\s+)*(?:async\s+)?(?:function\*?|class|interface|enum|namespace|type|const|let|var|def|fn|func|struct|trait|impl)\s+([\w$]+)/;
const METHOD_SIGNATURE =
	/^(?:\t| {1,4})(?:(?:public|private|protected|static|readonly|override|async|get|set)\s+)*([\w$]+)\s*(?:<[^>\n]*>)?\(/;
const NOT_A_METHOD = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"function",
	"else",
	"do",
	"try",
	"with",
]);

function declaredName(text: string): string | undefined {
	const keyword = DECLARATION_KEYWORD.exec(text)?.[1];
	if (keyword) return keyword;
	const method = METHOD_SIGNATURE.exec(text)?.[1];
	return method && !NOT_A_METHOD.has(method) ? method : undefined;
}

/** A query as the search read it: smart case, so an uppercase letter makes it case-sensitive; unusable patterns match nothing. */
function queryMatcher(query: string): RegExp | undefined {
	try {
		return new RegExp(query, /[A-Z]/.test(query) ? "" : "i");
	} catch {
		return undefined;
	}
}

/** How strongly a hit line reads as the definition of what was asked for: 2 a declaration of a queried name, 1 any declaration, 0 a use. */
function definitionStrength(text: string, matchers: readonly (RegExp | undefined)[]): number {
	const name = declaredName(text);
	if (name === undefined) return 0;
	return matchers.some((matcher) => matcher?.test(name)) ? 2 : 1;
}

interface LineHits {
	/** Distinct queries that matched the line. */
	readonly queries: Set<number>;
	readonly definition: number;
}

interface FileHits {
	readonly path: string;
	/** Matching (query, line) pairs. */
	hitCount: number;
	readonly queries: Set<number>;
	readonly lines: Map<number, LineHits>;
}

/**
 * Union of every query's hits by file. Judging order: files matching more distinct queries first, then more
 * hits, then path ascending, so a file that repeats one generic word does not crowd out files that cover the
 * target's several terms. A file's best hit is where it defines rather than uses: a declaration of a queried
 * name first, then any declaration, then the line whose excerpt window holds the most hits, then the most
 * distinct queries on the line, then the earliest line. A header comment or an error message that names a term
 * once never outranks the code.
 */
export function rankLocateFiles(
	queries: readonly string[],
	perQuery: readonly (readonly LocateHit[])[],
): readonly { readonly path: string; readonly hitCount: number; readonly bestLine: number }[] {
	const matchers = queries.map(queryMatcher);
	const files = new Map<string, FileHits>();
	perQuery.forEach((hits, queryIndex) => {
		for (const hit of hits) {
			let file = files.get(hit.path);
			if (!file) {
				file = { path: hit.path, hitCount: 0, queries: new Set(), lines: new Map() };
				files.set(hit.path, file);
			}
			const line = file.lines.get(hit.line) ?? {
				queries: new Set<number>(),
				definition: definitionStrength(hit.text, matchers),
			};
			if (!line.queries.has(queryIndex)) file.hitCount += 1;
			line.queries.add(queryIndex);
			file.queries.add(queryIndex);
			file.lines.set(hit.line, line);
		}
	});
	return [...files.values()]
		.map((file) => {
			let bestLine = Number.POSITIVE_INFINITY;
			let best = [-1, -1, -1];
			for (const [number, line] of file.lines) {
				let window = 0;
				for (const [other, otherLine] of file.lines)
					if (Math.abs(other - number) <= LOCATE_WINDOW_RADIUS) window += otherLine.queries.size;
				const score = [line.definition, window, line.queries.size];
				const order = score.findIndex((value, index) => value !== best[index]);
				if (order < 0 ? number < bestLine : score[order]! > best[order]!) {
					bestLine = number;
					best = score;
				}
			}
			return { path: file.path, hitCount: file.hitCount, covered: file.queries.size, bestLine };
		})
		.sort(
			(a, b) => b.covered - a.covered || b.hitCount - a.hitCount || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
		)
		.map(({ path: file, hitCount, bestLine }) => ({ path: file, hitCount, bestLine }));
}

/** A line cut at whitespace when it is over the limit, so no token is split and no surrogate pair broken. */
export function clipLine(line: string, maxChars = MAX_EXCERPT_LINE_CHARS): string {
	if (line.length <= maxChars) return line;
	let cut = line.lastIndexOf(" ", maxChars);
	if (cut < maxChars / 2) cut = maxChars;
	if (/[\uD800-\uDBFF]/.test(line[cut - 1] ?? "")) cut -= 1;
	return `${line.slice(0, cut).trimEnd()} …`;
}

/** The lines of a file's leading comment with their comment markers removed, at most `MAX_CARD_DOC_LINES`. */
function leadingComment(lines: readonly string[]): string[] {
	let at = 0;
	while (at < lines.length && /^\s*(?:$|#!|['"]use strict['"];?\s*$)/.test(lines[at]!)) at += 1;
	const first = lines[at]?.trim() ?? "";
	const collected: string[] = [];
	if (first.startsWith("/*")) {
		for (let index = at; index < lines.length && index < at + 60; index += 1) {
			const text = lines[index]!;
			collected.push(text.replace(/^\s*(?:\/\*+|\*\/|\*(?!\/))\s?/, "").replace(/\s*\*\/\s*$/, ""));
			if (text.includes("*/")) break;
		}
	} else if (/^(?:\/\/|#|"""|\/\/\/)/.test(first)) {
		for (let index = at; index < lines.length && /^\s*(?:\/\/+|#|""")/.test(lines[index]!); index += 1)
			collected.push(lines[index]!.replace(/^\s*(?:\/\/+|#|""")\s?/, ""));
	}
	return collected
		.map((text) => text.trim())
		.filter((text) => text.length > 0)
		.slice(0, MAX_CARD_DOC_LINES)
		.map((text) => clipLine(text));
}

/** Declared names, in file order, with those matching a query first and then exported ones. */
function declaredNames(lines: readonly string[], matchers: readonly (RegExp | undefined)[]): string[] {
	const seen = new Map<string, number>();
	for (const line of lines) {
		const name = declaredName(line);
		if (name === undefined) continue;
		const strength = (matchers.some((matcher) => matcher?.test(name)) ? 2 : 0) + (/^export\b/.test(line) ? 1 : 0);
		seen.set(name, Math.max(seen.get(name) ?? 0, strength));
	}
	const names = [...seen.keys()];
	return names
		.map((name, index) => ({ name, index, strength: seen.get(name)! }))
		.sort((a, b) => b.strength - a.strength || a.index - b.index)
		.slice(0, MAX_CARD_DECLARATIONS)
		.map((entry) => entry.name);
}

async function readCard(
	absolute: string,
	bestLine: number,
	matchers: readonly (RegExp | undefined)[],
	redact: (text: string) => string,
): Promise<Pick<LocateCandidate, "excerpt" | "matchLine" | "doc" | "declarations"> | undefined> {
	try {
		if ((await stat(absolute)).size > MAX_FILE_BYTES) return undefined;
		const text = await readFile(absolute, "utf8");
		if (text.includes("\u0000")) return undefined;
		const lines = text.split(/\r\n|\r|\n/);
		if (bestLine < 1 || bestLine > lines.length) return undefined;
		const from = Math.max(1, bestLine - LOCATE_EXCERPT_RADIUS);
		const to = Math.min(lines.length, bestLine + LOCATE_EXCERPT_RADIUS);
		return {
			excerpt: redact(
				lines
					.slice(from - 1, to)
					.map((line) => clipLine(line))
					.join("\n"),
			),
			matchLine: redact(clipLine(lines[bestLine - 1]!.trim())),
			doc: redact(leadingComment(lines).join("\n")),
			declarations: declaredNames(lines, matchers).map((name) => redact(name)),
		};
	} catch {
		return undefined;
	}
}

/** The roots a search covers: the working directory, or each named path once it is inside scope and unprotected. */
export async function resolveLocateRoots(
	paths: readonly string[] | undefined,
	cwd: string,
	boundary?: CredentialExposureBoundary,
): Promise<string[]> {
	if (!paths || paths.length === 0) return [cwd];
	const roots: string[] = [];
	for (const raw of paths) {
		const resolved = resolveToCwd(raw, cwd);
		try {
			await stat(resolved);
		} catch {
			throw new LocateInputError(`Path not found: ${raw}`);
		}
		const canonical = safeRealpathSync(resolved);
		if (!isPathWithinScope(canonical, cwd)) throw new LocateInputError(`Path is outside the task directory: ${raw}`);
		if (isProtectedCredentialPath(canonical, cwd, boundary))
			throw new LocateInputError(`Path is a protected credential file: ${raw}`);
		roots.push(resolved);
	}
	return roots;
}

/** Search every query, union by file, keep the best {@link MAX_LOCATE_CANDIDATES}, and cut a card for each. */
export async function collectLocateCandidates(input: {
	readonly queries: readonly string[];
	readonly roots: readonly string[];
	readonly cwd: string;
	readonly redact: (text: string) => string;
	readonly search: LocateSearch;
	readonly credentialBoundary?: CredentialExposureBoundary;
	readonly signal?: AbortSignal;
}): Promise<LocateCandidateSet> {
	const results = await Promise.all(
		input.queries.map((query) => input.search(query, input.roots, input.cwd, input.signal)),
	);
	const ranked = rankLocateFiles(
		input.queries,
		results.map((result) => result.hits),
	);
	const matchers = input.queries.map(queryMatcher);
	const truncatedQueries = input.queries.filter((_query, index) => results[index]?.truncated === true);
	const invalidQueries = input.queries.flatMap((query, index) => {
		const message = results[index]?.error;
		return message === undefined ? [] : [{ query, message }];
	});
	const candidates: LocateCandidate[] = [];
	let excluded = 0;
	let considered = 0;
	for (const file of ranked) {
		if (candidates.length >= MAX_LOCATE_CANDIDATES) break;
		considered += 1;
		input.signal?.throwIfAborted();
		const absolute = path.resolve(input.cwd, file.path);
		let admitted = false;
		try {
			const canonical = safeRealpathSync(absolute);
			admitted =
				isPathWithinScope(canonical, input.cwd) &&
				!isProtectedCredentialPath(canonical, input.cwd, input.credentialBoundary);
		} catch {
			admitted = false;
		}
		const view = admitted ? await readCard(absolute, file.bestLine, matchers, input.redact) : undefined;
		if (!view) {
			excluded += 1;
			continue;
		}
		candidates.push({
			path: file.path,
			line: file.bestLine,
			hitCount: file.hitCount,
			...view,
		});
	}
	return {
		candidates,
		filesMatched: ranked.length,
		excluded,
		beyondCap: ranked.length - considered,
		invalidQueries,
		truncatedQueries,
	};
}
