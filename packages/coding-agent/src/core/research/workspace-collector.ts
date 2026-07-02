import { type ExecFileException, execFile } from "node:child_process";

/** Structural DI seam: only the callback overload the collector actually uses — demanding
 * node's full `typeof execFile` (with `__promisify__`) makes plain test mocks unassignable. */
export type WorkspaceExecFileFn = (
	command: string,
	args: readonly string[],
	options: { cwd?: string; timeout?: number; maxBuffer?: number; encoding?: string; windowsHide?: boolean },
	callback: (error: ExecFileException | null, stdout: string, stderr: string) => void,
) => unknown;

import type { EvidenceRef } from "../autonomy/contracts.ts";

/**
 * Best-effort workspace research source collector.
 *
 * Feeds the autonomous research lane POINTER-FIRST sources: a repo-relative path, a bounded excerpt,
 * and (when known) a line number — never whole file bodies. It runs `rg` under the session cwd exactly
 * like the grep tool does, so it only surfaces content ripgrep already matched. Collection is bounded
 * (a shared wall-clock deadline, a candidate cap, ripgrep's own binary/oversize skipping) and never
 * throws: if `rg` is missing or errors, it returns `[]`, which is today's "no collector" behavior.
 *
 * The returned sources are `EvidenceRef`s (the runner's source type) tagged `kind: "workspace"`.
 */

/** Search terms shorter than this are too noisy to be useful discriminators. */
const MIN_TERM_LEN = 3;
/** Cap on derived search terms; keeps the discovery pattern small and the collector cheap. */
const MAX_TERMS = 4;
/** Pointer excerpts are bounded so we never spill a whole line (or a whole file) into the prompt. */
const EXCERPT_MAX_CHARS = 200;
/** Shared wall-clock budget for the whole collection pass (both ripgrep calls together). */
const COLLECTION_BUDGET_MS = 5000;
/** Floor for any single ripgrep call so a nearly-spent budget still gives ripgrep a chance to run. */
const MIN_CALL_MS = 500;
/** ripgrep skips files larger than this; oversized files never contribute a source. */
const MAX_FILESIZE = "1M";
/** Upper bound on candidate files carried from discovery into the pointer pass. */
const CANDIDATE_CAP = 24;
/** Generous stdout ceiling; overflow degrades to fewer sources rather than throwing. */
const MAX_BUFFER_BYTES = 8 * 1024 * 1024;

/**
 * A small, deliberately conservative English stopword set plus the structural words that show up in
 * goal/requirement text. Anything not here that is >= MIN_TERM_LEN survives as a search term.
 */
const STOPWORDS = new Set<string>([
	"the",
	"and",
	"for",
	"with",
	"that",
	"this",
	"from",
	"into",
	"are",
	"was",
	"were",
	"but",
	"not",
	"you",
	"your",
	"our",
	"all",
	"any",
	"can",
	"has",
	"have",
	"had",
	"will",
	"would",
	"should",
	"could",
	"its",
	"his",
	"her",
	"their",
	"them",
	"they",
	"she",
	"him",
	"who",
	"what",
	"when",
	"where",
	"which",
	"how",
	"why",
	"use",
	"using",
	"used",
	"via",
	"per",
	"out",
	"off",
	"over",
	"under",
	"then",
	"than",
	"add",
	"adds",
	"get",
	"gets",
	"set",
	"sets",
	"new",
	"old",
	"one",
	"two",
	"let",
	"run",
	"runs",
]);

export interface CollectWorkspaceSourcesArgs {
	/** Free text (goal + requirement text) that search terms are derived from. */
	query: string;
	/** Session working directory; ripgrep runs here and paths are reported relative to it. */
	cwd: string;
	/** Hard cap on returned sources; also the lane's source budget. */
	maxSources: number;
	/** Injected for tests; defaults to node's `execFile`. */
	execFileFn?: WorkspaceExecFileFn;
}

/** Split on non-word runs, lowercase, drop stopwords/short/dupes, keep source order, cap at MAX_TERMS. */
export function deriveSearchTerms(query: string): string[] {
	const seen = new Set<string>();
	const terms: string[] = [];
	for (const raw of query.split(/[^\w]+/)) {
		const term = raw.toLowerCase();
		if (term.length < MIN_TERM_LEN) continue;
		if (STOPWORDS.has(term)) continue;
		if (seen.has(term)) continue;
		seen.add(term);
		terms.push(term);
		if (terms.length >= MAX_TERMS) break;
	}
	return terms;
}

/** The most specific term (longest wins; ties keep the earliest) drives the line-level pointer pass. */
function pickBestTerm(terms: readonly string[]): string {
	return terms.reduce((best, term) => (term.length > best.length ? term : best), terms[0]);
}

function truncateExcerpt(text: string): string | undefined {
	const trimmed = text.trim();
	if (trimmed.length === 0) return undefined;
	if (trimmed.length <= EXCERPT_MAX_CHARS) return trimmed;
	return `${trimmed.slice(0, EXCERPT_MAX_CHARS - 1)}…`;
}

interface RgOutcome {
	/** True when ripgrep ran to a usable result (matches found, or a clean "no matches"). */
	ok: boolean;
	stdout: string;
	/** True when the `rg` binary could not be spawned at all — the collector bails entirely. */
	missing: boolean;
}

function runRg(
	execFileFn: WorkspaceExecFileFn,
	args: readonly string[],
	cwd: string,
	timeoutMs: number,
): Promise<RgOutcome> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (outcome: RgOutcome): void => {
			if (settled) return;
			settled = true;
			resolve(outcome);
		};
		try {
			execFileFn(
				"rg",
				[...args],
				{ cwd, timeout: timeoutMs, maxBuffer: MAX_BUFFER_BYTES, encoding: "utf8", windowsHide: true },
				(error: ExecFileException | null, stdout: string) => {
					const out = typeof stdout === "string" ? stdout : "";
					if (!error) {
						done({ ok: true, stdout: out, missing: false });
						return;
					}
					// Exit code 1 is ripgrep's "no matches" — a clean, usable result, not a failure.
					if (error.code === 1) {
						done({ ok: true, stdout: out, missing: false });
						return;
					}
					done({ ok: false, stdout: "", missing: error.code === "ENOENT" });
				},
			);
		} catch {
			// A synchronous spawn failure (e.g. rg entirely absent) is treated as "missing".
			done({ ok: false, stdout: "", missing: true });
		}
	});
}

/** rg prints `./foo` when the search root is `.`; keep sources cleanly repo-relative. */
function normalizePath(path: string): string {
	return path.startsWith("./") ? path.slice(2) : path;
}

function parseFileList(stdout: string): string[] {
	const files: string[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const path = line.trim();
		if (path.length > 0) files.push(normalizePath(path));
	}
	return files;
}

interface ContentMatch {
	path: string;
	line: number;
	text: string;
}

function parseContentMatches(stdout: string): ContentMatch[] {
	const matches: ContentMatch[] = [];
	for (const raw of stdout.split(/\r?\n/)) {
		if (raw.length === 0) continue;
		// `-H -n --no-heading` yields `path:line:text`; text may itself contain colons.
		const parsed = /^(.+?):(\d+):(.*)$/.exec(raw);
		if (!parsed) continue;
		matches.push({ path: normalizePath(parsed[1]), line: Number(parsed[2]), text: parsed[3] });
	}
	return matches;
}

export async function collectWorkspaceSources(args: CollectWorkspaceSourcesArgs): Promise<EvidenceRef[]> {
	const { query, cwd, maxSources } = args;
	const execFileFn = args.execFileFn ?? (execFile as unknown as WorkspaceExecFileFn);
	if (!cwd || maxSources <= 0) return [];

	const terms = deriveSearchTerms(query);
	if (terms.length === 0) return [];

	const deadline = Date.now() + COLLECTION_BUDGET_MS;
	const remainingBudget = (): number => Math.max(MIN_CALL_MS, deadline - Date.now());

	// Phase 1 (discovery): which files match ANY term. `--max-count 1` stops at the first hit per file;
	// ripgrep skips binary and oversized files by default / via --max-filesize.
	const discoveryArgs = [
		"--files-with-matches",
		"--max-count",
		"1",
		"--fixed-strings",
		"--smart-case",
		"--no-messages",
		"--max-filesize",
		MAX_FILESIZE,
		"--color",
		"never",
		...terms.flatMap((term) => ["-e", term]),
		// Explicit search root: execFile hands rg a piped stdin, and rg with no path argument would
		// read (and block on) that pipe instead of scanning the tree. "." keeps output repo-relative.
		"--",
		".",
	];
	const discovery = await runRg(execFileFn, discoveryArgs, cwd, remainingBudget());
	if (discovery.missing || !discovery.ok) return [];

	const candidateFiles = parseFileList(discovery.stdout).slice(0, CANDIDATE_CAP);
	if (candidateFiles.length === 0) return [];

	// Phase 2 (pointers): line-level hits for the single best term, scanned only over files discovery
	// already matched — so we never read a file ripgrep did not surface.
	const bestTerm = pickBestTerm(terms);
	const contentArgs = [
		"-H",
		"-n",
		"--no-heading",
		"-m",
		"2",
		"--fixed-strings",
		"--smart-case",
		"--no-messages",
		"--color",
		"never",
		"-e",
		bestTerm,
		"--",
		...candidateFiles,
	];
	const content = await runRg(execFileFn, contentArgs, cwd, remainingBudget());

	const sources: EvidenceRef[] = [];
	const seenPaths = new Set<string>();
	const seenLineKeys = new Set<string>();
	let counter = 0;

	if (content.ok) {
		for (const match of parseContentMatches(content.stdout)) {
			if (sources.length >= maxSources) break;
			const key = `${match.path}:${match.line}`;
			if (seenLineKeys.has(key)) continue;
			seenLineKeys.add(key);
			seenPaths.add(match.path);
			const excerpt = truncateExcerpt(match.text);
			sources.push({
				id: `ws-${++counter}`,
				kind: "workspace",
				title: `${match.path}:${match.line}`,
				uri: match.path,
				trusted: true,
				...(excerpt !== undefined ? { excerpt } : {}),
				metadata: { line: match.line, term: bestTerm },
			});
		}
	}

	// Fill the remaining budget with file-level pointers for candidates that matched a secondary term
	// (and so produced no best-term line). Still pointer-first: a path, never a body.
	for (const file of candidateFiles) {
		if (sources.length >= maxSources) break;
		if (seenPaths.has(file)) continue;
		seenPaths.add(file);
		sources.push({
			id: `ws-${++counter}`,
			kind: "workspace",
			title: file,
			uri: file,
			trusted: true,
			metadata: { matchedBy: "discovery" },
		});
	}

	return sources.slice(0, maxSources);
}
