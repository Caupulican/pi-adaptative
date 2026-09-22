/**
 * Semantic code deduplication at the moment duplication is created.
 *
 * When an edit or write adds a function, deterministic code extracts it, finds existing functions that
 * share its distinctive identifiers, and asks Jev one Noul per candidate in a single request: does the
 * new code do the same job as this one, however it is written? A decisive yes is reported in the
 * edit's own tool result, naming the existing function to reuse. The edit itself is never undone:
 * this steers reversible work, it does not refuse it.
 */

import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { availableParallelism, freemem } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { type NoulBand, noulBand, settledAnswer } from "../decision/noul.ts";
import { defaultFffSearchBackend } from "../tools/fff-search-backend.ts";
import { resolveManagedSearchTool } from "../tools/managed-search-tool.ts";

export interface CodeUnit {
	readonly path: string;
	readonly name: string;
	readonly line: number;
	readonly code: string;
}

const MAX_UNIT_CHARS = 4000;
const MIN_UNIT_LINES = 3;
const MAX_NEW_UNITS = 3;
const MAX_CANDIDATES = 5;

const NOT_A_NAME = new Set([
	"if",
	"for",
	"while",
	"switch",
	"catch",
	"return",
	"function",
	"constructor",
	"else",
	"do",
	"try",
	"with",
]);

/** Declaration forms, each capturing the function's name. Brace-bodied unless marked indentation-bodied. */
const DECLARATIONS: readonly { readonly pattern: RegExp; readonly body: "brace" | "indent" }[] = [
	{
		pattern: /^[ \t]*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*[<(]/gm,
		body: "brace",
	},
	{
		pattern:
			/^[ \t]*(?:export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(?:async\s*)?(?:<[^>\n]*>\s*)?\([^)\n]*\)[^=\n]*=>\s*\{/gm,
		body: "brace",
	},
	{
		pattern:
			/^[ \t]+(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>\n]*>)?\([^)\n]*\)\s*(?::\s*[^{\n]+)?\{/gm,
		body: "brace",
	},
	{ pattern: /^[ \t]*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm, body: "brace" },
	{ pattern: /^[ \t]*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/gm, body: "brace" },
	{ pattern: /^([ \t]*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/gm, body: "indent" },
];

function braceBody(text: string, start: number): string | undefined {
	const open = text.indexOf("{", start);
	if (open < 0 || open - start > 400) return undefined;
	let depth = 0;
	for (let index = open; index < text.length && index - start < MAX_UNIT_CHARS; index += 1) {
		const char = text[index];
		if (char === "{") depth += 1;
		else if (char === "}") {
			depth -= 1;
			if (depth === 0) return text.slice(start, index + 1);
		}
	}
	return undefined;
}

function indentBody(text: string, start: number, indent: string): string {
	const lines = text.slice(start).split("\n");
	const body = [lines[0] ?? ""];
	for (const line of lines.slice(1)) {
		if (line.trim() && !line.startsWith(`${indent} `) && !line.startsWith(`${indent}\t`)) break;
		body.push(line);
		if (body.join("\n").length > MAX_UNIT_CHARS) break;
	}
	return body.join("\n").trimEnd();
}

/** Every function-like unit declared in `text`, with a body long enough to carry a responsibility. */
export function extractCodeUnits(path: string, text: string): CodeUnit[] {
	const units: CodeUnit[] = [];
	const seen = new Set<number>();
	for (const { pattern, body } of DECLARATIONS) {
		for (const match of text.matchAll(pattern)) {
			const index = match.index ?? 0;
			if (seen.has(index)) continue;
			const name = body === "indent" ? match[2] : match[1];
			if (!name || NOT_A_NAME.has(name)) continue;
			const code = body === "indent" ? indentBody(text, index, match[1] ?? "") : braceBody(text, index);
			if (!code || code.split("\n").length < MIN_UNIT_LINES) continue;
			seen.add(index);
			units.push({ path, name, line: text.slice(0, index).split("\n").length, code });
		}
	}
	return units;
}

/** Functions an edit or write introduces: present in the new text, absent verbatim from the old. */
export function newCodeUnits(toolName: string, args: unknown, cwd: string): CodeUnit[] {
	if (!args || typeof args !== "object") return [];
	const record = args as Record<string, unknown>;
	const rawPath = record.path ?? record.file_path;
	if (typeof rawPath !== "string") return [];
	const path = isAbsolute(rawPath) ? relative(cwd, rawPath) : rawPath;
	const pieces: { oldText: string; newText: string }[] = [];
	if (/write/.test(toolName) && typeof record.content === "string")
		pieces.push({ oldText: "", newText: record.content });
	if (/edit/.test(toolName) && Array.isArray(record.edits)) {
		for (const edit of record.edits) {
			const entry = edit as { oldText?: unknown; newText?: unknown };
			if (typeof entry.oldText === "string" && typeof entry.newText === "string")
				pieces.push({ oldText: entry.oldText, newText: entry.newText });
		}
	}
	const units: CodeUnit[] = [];
	for (const { oldText, newText } of pieces)
		for (const unit of extractCodeUnits(path, newText)) if (!oldText.includes(unit.code)) units.push(unit);
	return units.slice(0, MAX_NEW_UNITS);
}

/**
 * jscpd-style tokens: comments and whitespace dropped, every identifier normalized to `I` and every
 * literal to `L`, so two units with the same structure compare equal however their names are spelled.
 * No vocabulary is involved; the only grammar is what separates identifiers, literals and punctuation.
 */
interface Token {
	readonly kind: "identifier" | "literal" | "punct";
	readonly text: string;
}

const TOKEN_PATTERN =
	/\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<=^|\n)[ \t]*#[^\n]*|\s+|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\d[\w.]*|[A-Za-z_$][\w$]*|[^\s]/g;

function tokenize(code: string): Token[] {
	const tokens: Token[] = [];
	for (const match of code.matchAll(TOKEN_PATTERN)) {
		const text = match[0];
		if (/^\s/.test(text) || text.startsWith("//") || text.startsWith("/*") || /^[ \t]*#/.test(text)) continue;
		if (/^[A-Za-z_$]/.test(text)) tokens.push({ kind: "identifier", text });
		else if (/^["'`\d]/.test(text)) tokens.push({ kind: "literal", text });
		else tokens.push({ kind: "punct", text });
	}
	return tokens;
}

/** Window length of the normalized-token fingerprints, as a clone scanner's minimum match. */
const FINGERPRINT_WINDOW = 8;

/** Hashed windows of the normalized token stream: the unit's structure with names and values erased. */
function structuralFingerprints(code: string): Set<string> {
	const normalized = tokenize(code).map((token) =>
		token.kind === "identifier" ? "I" : token.kind === "literal" ? "L" : token.text,
	);
	const windows = new Set<string>();
	for (let index = 0; index + FINGERPRINT_WINDOW <= normalized.length; index += 1)
		windows.add(normalized.slice(index, index + FINGERPRINT_WINDOW).join(" "));
	return windows;
}

/** The operations a unit performs: identifiers immediately followed by `(` in its token stream. */
function calledNames(code: string, ownName?: string): Set<string> {
	const tokens = tokenize(code);
	const found = new Set<string>();
	for (let index = 0; index + 1 < tokens.length; index += 1) {
		const token = tokens[index];
		if (token?.kind === "identifier" && tokens[index + 1]?.text === "(" && token.text !== ownName)
			found.add(token.text);
	}
	return found;
}

/** Source files of the same language family as `path`, so the index never mixes docs or lockfiles in. */
export function sourceGlobFor(path: string): string | undefined {
	const extension = /\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase();
	if (!extension) return undefined;
	if (["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"].includes(extension))
		return "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}";
	return `**/*.${extension}`;
}

/** Repository-relative files matching a glob. */
export type FileLister = (root: string, glob: string, signal?: AbortSignal) => Promise<string[]>;

function globToFffPattern(glob: string): string {
	return glob.startsWith("**/") ? glob.slice(3) : glob;
}

/**
 * The harness's resident FFF index when it is already warm (never waiting on an index build, the same
 * non-blocking acquisition the search tools use), the managed ripgrep file listing otherwise. Both
 * honor .gitignore. This is internal enumeration, read whole; a failure lists nothing.
 */
export const harnessFileLister: FileLister = async (root, glob, signal) => {
	try {
		const finder = defaultFffSearchBackend.peekFinder?.(root);
		if (finder && !finder.isDestroyed) {
			const result = finder.glob(globToFffPattern(glob), { pageSize: 100_000 });
			if (result.ok) return result.value.items.map((item) => item.relativePath);
		}
	} catch {
		// A broken index is unavailable for this listing, never a failure of the edit.
	}
	try {
		const rg = await resolveManagedSearchTool("rg");
		return await new Promise<string[]>((resolve) => {
			execFile(rg, ["--files", "-g", glob], { cwd: root, maxBuffer: 64_000_000, signal }, (error, stdout) => {
				if (error) return resolve([]);
				resolve(String(stdout).split("\n").filter(Boolean));
			});
		});
	} catch {
		return [];
	}
};

interface IndexedUnit extends CodeUnit {
	readonly calls: ReadonlySet<string>;
	readonly fingerprints: ReadonlySet<string>;
	readonly tokenCount: number;
}

function indexUnit(unit: CodeUnit): IndexedUnit {
	return {
		...unit,
		calls: calledNames(unit.code, unit.name),
		fingerprints: structuralFingerprints(unit.code),
		tokenCount: tokenize(unit.code).length,
	};
}

export interface DuplicateCandidate {
	readonly unit: CodeUnit;
	/** IDF-weighted cosine of the two units' calls. */
	readonly callSimilarity: number;
	/** Shared normalized-token windows over the larger unit's windows; 0 when either unit is too small. */
	readonly structuralSimilarity: number;
}

/** A candidate below both similarities is not worth a judgment. */
const MIN_SIMILARITY = 0.35;
/**
 * Below this many tokens a unit's structure is too generic to call a copy (a getter, a guard); the same
 * minimum jscpd and the repository clone gate use.
 */
const STRUCTURAL_MIN_TOKENS = 50;
/**
 * Scale a base amount of work to this machine: a reference host of 8 cores with 4 GiB free runs the
 * base; more cores and memory run more (up to double), a constrained host runs less (down to half).
 */
export function scaledToMachine(base: number): number {
	const cores = availableParallelism();
	const freeGiB = freemem() / 2 ** 30;
	const factor = Math.min(2, Math.max(0.5, Math.min(cores / 8, freeGiB / 4)));
	return Math.max(1, Math.round(base * factor));
}

/** Postings a candidate pool is built from: the probe's rarest calls, where identity lives. */
const POOL_CALLS = scaledToMachine(16);

/** Concurrent Jev requests a scan keeps in flight; Jev evaluates each request's questions in parallel too. */
export const JEV_SCAN_CONCURRENCY = scaledToMachine(16);

/**
 * Every function-like unit of one language family in the repository, with its calls and structural
 * fingerprints, refreshed incrementally by file mtime. Call rarity is the exact document frequency
 * across the indexed units, so what makes a call distinctive is measured, never listed by hand.
 */
export class SemanticUnitIndex {
	private readonly root: string;
	private readonly glob: string;
	private readonly lister: FileLister;
	private readonly files = new Map<string, { mtimeMs: number; units: readonly IndexedUnit[] }>();
	private documentFrequency = new Map<string, number>();
	private unitCount = 0;
	/** Inverted postings: which units make each call, and which contain each structural window. */
	private callPostings = new Map<string, IndexedUnit[]>();
	private windowPostings = new Map<string, IndexedUnit[]>();
	/** Identity set of indexed units, so a scan reuses their tokens instead of re-reading them. */
	private indexed = new Set<CodeUnit>();

	constructor(root: string, glob: string, lister: FileLister) {
		this.root = root;
		this.glob = glob;
		this.lister = lister;
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		const listed = new Set(await this.lister(this.root, this.glob, signal));
		for (const path of this.files.keys()) if (!listed.has(path)) this.files.delete(path);
		await Promise.all(
			[...listed].map(async (path) => {
				const absolute = isAbsolute(path) ? path : join(this.root, path);
				try {
					const { mtimeMs } = await stat(absolute);
					if (this.files.get(path)?.mtimeMs === mtimeMs) return;
					const text = await readFile(absolute, "utf8");
					this.files.set(path, { mtimeMs, units: extractCodeUnits(path, text).map(indexUnit) });
				} catch {
					this.files.delete(path);
				}
			}),
		);
		const frequency = new Map<string, number>();
		const callPostings = new Map<string, IndexedUnit[]>();
		const windowPostings = new Map<string, IndexedUnit[]>();
		let count = 0;
		for (const { units } of this.files.values())
			for (const unit of units) {
				count += 1;
				for (const call of unit.calls) {
					frequency.set(call, (frequency.get(call) ?? 0) + 1);
					const posting = callPostings.get(call);
					if (posting) posting.push(unit);
					else callPostings.set(call, [unit]);
				}
				for (const window of unit.fingerprints) {
					const posting = windowPostings.get(window);
					if (posting) posting.push(unit);
					else windowPostings.set(window, [unit]);
				}
			}
		this.documentFrequency = frequency;
		this.unitCount = count;
		this.callPostings = callPostings;
		this.windowPostings = windowPostings;
		this.squaredIdf.clear();
		this.indexed = new Set([...this.files.values()].flatMap(({ units }) => units));
	}

	/** All indexed units, for a whole-repository scan. */
	allUnits(): CodeUnit[] {
		return [...this.files.values()].flatMap(({ units }) => units);
	}

	/**
	 * A posting shared by more than this share of all units carries no identity: its call or window is
	 * everywhere. Measured from the index itself, so what counts as common is never a list.
	 */
	private informative(posting: readonly IndexedUnit[]): boolean {
		return posting.length <= Math.max(8, Math.sqrt(this.unitCount) * 2);
	}

	private readonly squaredIdf = new Map<string, number>();

	/** Squared inverse document frequency of a call, cached until the next refresh. */
	private weight(call: string): number {
		let value = this.squaredIdf.get(call);
		if (value === undefined) {
			value = Math.log((this.unitCount + 1) / ((this.documentFrequency.get(call) ?? 0) + 1)) ** 2;
			this.squaredIdf.set(call, value);
		}
		return value;
	}

	private callSimilarity(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
		let dot = 0;
		let normA = 0;
		let normB = 0;
		for (const call of a) {
			const weight = this.weight(call);
			normA += weight;
			if (b.has(call)) dot += weight;
		}
		for (const call of b) normB += this.weight(call);
		return normA === 0 || normB === 0 ? 0 : dot / Math.sqrt(normA * normB);
	}

	/** The indexed units most similar to `unit`, by calls or by structure, excluding the unit itself. */
	candidates(unit: CodeUnit, limit = MAX_CANDIDATES): DuplicateCandidate[] {
		const probe = this.indexed.has(unit) ? (unit as IndexedUnit) : indexUnit(unit);
		const pool = new Set<IndexedUnit>();
		const rarest = [...probe.calls]
			.map((call) => ({ call, posting: this.callPostings.get(call) }))
			.filter((entry): entry is { call: string; posting: IndexedUnit[] } => entry.posting !== undefined)
			.filter((entry) => this.informative(entry.posting))
			.sort((a, b) => a.posting.length - b.posting.length)
			.slice(0, POOL_CALLS);
		for (const { posting } of rarest) for (const existing of posting) pool.add(existing);
		// Shared informative windows are counted while the pool is built; the exact intersection runs only
		// for units whose count can still reach a clone.
		const informativeShared = new Map<IndexedUnit, number>();
		let commonWindows = 0;
		for (const window of probe.fingerprints) {
			const posting = this.windowPostings.get(window);
			if (!posting) continue;
			if (!this.informative(posting)) {
				commonWindows += 1;
				continue;
			}
			for (const existing of posting) {
				pool.add(existing);
				informativeShared.set(existing, (informativeShared.get(existing) ?? 0) + 1);
			}
		}
		const scored: DuplicateCandidate[] = [];
		for (const existing of pool) {
			if (existing.path === unit.path && (existing.name === unit.name || existing.code === unit.code)) continue;
			const comparable = Math.min(probe.tokenCount, existing.tokenCount) >= STRUCTURAL_MIN_TOKENS;
			const largest = Math.max(probe.fingerprints.size, existing.fingerprints.size);
			// Shared windows can only be the counted informative ones plus the common ones: an upper bound.
			let sharedWindows = 0;
			if (
				comparable &&
				largest > 0 &&
				(informativeShared.get(existing) ?? 0) + commonWindows >= MIN_SIMILARITY * largest
			)
				for (const window of probe.fingerprints) if (existing.fingerprints.has(window)) sharedWindows += 1;
			const candidate: DuplicateCandidate = {
				unit: existing,
				callSimilarity: this.callSimilarity(probe.calls, existing.calls),
				structuralSimilarity: comparable && largest > 0 ? sharedWindows / largest : 0,
			};
			if (Math.max(candidate.callSimilarity, candidate.structuralSimilarity) >= MIN_SIMILARITY)
				scored.push(candidate);
		}
		const rank = (c: DuplicateCandidate) => Math.max(c.callSimilarity, c.structuralSimilarity);
		return scored.sort((a, b) => rank(b) - rank(a)).slice(0, limit);
	}
}

/** A test file by the conventions every language here shares: a test directory or a `.test.`/`.spec.` name. */
export function isTestPath(path: string): boolean {
	return /(^|\/)(test|tests|__tests__|spec)\/|\.(test|spec)\.[^/]+$|(^|\/)test_[^/]+\.py$/.test(path);
}

export interface DuplicateFinding {
	readonly unit: CodeUnit;
	readonly candidate: CodeUnit;
	/** A hard-pass Jev judgment. A provisional one is shown, not acted on. */
	readonly decisive: boolean;
}

/** What judges duplicates: the System One controller's batched Jev evaluation. */
export interface DuplicateJudge {
	evaluateCodeDuplicates(
		pairs: readonly { readonly unit: CodeUnit; readonly candidates: readonly CodeUnit[] }[],
		signal?: AbortSignal,
	): Promise<Record<string, unknown>>;
}

export interface CodeDuplicateReviewerDeps {
	getController(): DuplicateJudge | undefined;
	warn(message: string): void;
	lister?: FileLister;
}

/** Question id for one (new unit, candidate) pair; both ride in the state under `u<i>` and `u<i>c<j>`. */
export function duplicateQuestionId(unitIndex: number, candidateIndex: number): string {
	return `same_responsibility_u${unitIndex}c${candidateIndex}`;
}

/**
 * Reviews one successful edit/write for new code that duplicates existing logic. Returns the note to
 * append to the tool result, or undefined. Structure and calls find the candidates; whether they do
 * the same job is Jev's judgment, asked for every pair in one request. An outage is reported once until
 * Jev answers again.
 */
export class CodeDuplicateReviewer {
	private readonly deps: CodeDuplicateReviewerDeps;
	private readonly indexes = new Map<string, SemanticUnitIndex>();
	private outageReported = false;

	constructor(deps: CodeDuplicateReviewerDeps) {
		this.deps = deps;
	}

	private index(root: string, glob: string): SemanticUnitIndex {
		const key = `${root}\u0000${glob}`;
		let index = this.indexes.get(key);
		if (!index) {
			index = new SemanticUnitIndex(root, glob, this.deps.lister ?? harnessFileLister);
			this.indexes.set(key, index);
		}
		return index;
	}

	async review(toolName: string, args: unknown, cwd: string, signal?: AbortSignal): Promise<string | undefined> {
		const controller = this.deps.getController();
		if (!controller) return undefined;
		const units = newCodeUnits(toolName, args, cwd);
		if (units.length === 0) return undefined;
		const globs = [...new Set(units.map((unit) => sourceGlobFor(unit.path)).filter((glob) => glob !== undefined))];
		await Promise.all(globs.map((glob) => this.index(cwd, glob).refresh(signal)));
		const findings: DuplicateFinding[] = [];
		const pairs: { unit: CodeUnit; candidates: CodeUnit[] }[] = [];
		for (const unit of units) {
			const glob = sourceGlobFor(unit.path);
			if (!glob) continue;
			// Identical structure with names and literals erased ranks a candidate high, but it is not the
			// same job (two predicates of one shape test different values): every candidate is judged.
			// Production code is never told to reuse a test helper; test code may reuse anything.
			const judged = this.index(cwd, glob)
				.candidates(unit)
				.map((candidate) => candidate.unit)
				.filter((candidate) => isTestPath(unit.path) || !isTestPath(candidate.path));
			if (judged.length > 0) pairs.push({ unit, candidates: judged });
		}
		if (pairs.length > 0) {
			try {
				const answers = await controller.evaluateCodeDuplicates(pairs, signal);
				this.outageReported = false;
				pairs.forEach(({ unit, candidates }, unitIndex) => {
					candidates.forEach((candidate, candidateIndex) => {
						const answer = answers[duplicateQuestionId(unitIndex, candidateIndex)] as
							| { band?: unknown; noul?: unknown }
							| undefined;
						if (settledAnswer(answer) === true) findings.push({ unit, candidate, decisive: isDecisive(answer) });
					});
				});
			} catch (error) {
				if (!this.outageReported)
					this.deps.warn(
						`New code is not being checked for semantic duplicates: ${error instanceof Error ? error.message : String(error)}`,
					);
				this.outageReported = true;
			}
		}
		// The operator sees every finding: the note in the tool result steers the model, but a model that
		// ignores it must not hide the duplicate.
		for (const finding of findings)
			this.deps.warn(
				finding.decisive
					? `Duplicate logic: ${finding.unit.name} (${finding.unit.path}) does the same job as ${finding.candidate.name} (${finding.candidate.path}:${finding.candidate.line})`
					: `Possible duplicate: ${finding.unit.name} (${finding.unit.path}) may repeat ${finding.candidate.name} (${finding.candidate.path}:${finding.candidate.line})`,
			);
		const decisive = findings.filter((finding) => finding.decisive);
		if (decisive.length === 0) return undefined;
		return [
			"System One: this change adds logic that already exists.",
			...decisive.map(
				(f) =>
					`- ${f.unit.name} (${f.unit.path}:${f.unit.line}) does the same job as ${f.candidate.name} (${f.candidate.path}:${f.candidate.line}).`,
			),
			"Reuse or extend the existing function instead of keeping two implementations of one responsibility.",
		].join("\n");
	}
}

function isDecisive(answer: { band?: unknown; noul?: unknown } | undefined): boolean {
	if (typeof answer?.band === "string") return answer.band === "hard_pass";
	return typeof answer?.noul === "number" && noulBand(answer.noul, "required_true") === "hard_pass";
}

export interface SemanticDuplicateVerdict {
	readonly unit: CodeUnit;
	readonly candidate: CodeUnit;
	/** Probability the two do the same job; NaN when Jev returned no answer for the pair. */
	readonly probability: number;
	readonly band: NoulBand | "missing";
}

export interface SemanticDuplicateScan {
	readonly units: number;
	readonly pairs: number;
	readonly requests: number;
	readonly failedRequests: number;
	readonly verdicts: readonly SemanticDuplicateVerdict[];
}

/** Candidate pairs below this similarity are not worth a judgment in a whole-repository scan. */
const SCAN_MIN_SIMILARITY = 0.5;
/** Questions per Jev request in a scan: Jev evaluates them in parallel, so a request carries many. */
const SCAN_QUESTIONS_PER_REQUEST = 25;

/**
 * Judge every indexed unit against its closest candidates, each unordered pair once: the Jev
 * counterpart of a clone report. Requests are batched and kept in flight concurrently.
 */
export async function scanSemanticDuplicates(options: {
	readonly index: SemanticUnitIndex;
	readonly controller: DuplicateJudge;
	readonly concurrency?: number;
	readonly candidatesPerUnit?: number;
	readonly signal?: AbortSignal;
}): Promise<SemanticDuplicateScan> {
	const units = options.index.allUnits();
	const identity = (unit: CodeUnit) => `${unit.path}:${unit.line}:${unit.name}`;
	const seen = new Set<string>();
	const pairs: { unit: CodeUnit; candidate: CodeUnit }[] = [];
	for (const unit of units)
		for (const candidate of options.index.candidates(unit, options.candidatesPerUnit ?? 3)) {
			if (Math.max(candidate.callSimilarity, candidate.structuralSimilarity) < SCAN_MIN_SIMILARITY) continue;
			const key = [identity(unit), identity(candidate.unit)].sort().join("\u0000");
			if (seen.has(key)) continue;
			seen.add(key);
			pairs.push({ unit, candidate: candidate.unit });
		}
	const batches: (typeof pairs)[] = [];
	for (let index = 0; index < pairs.length; index += SCAN_QUESTIONS_PER_REQUEST)
		batches.push(pairs.slice(index, index + SCAN_QUESTIONS_PER_REQUEST));
	const verdicts: SemanticDuplicateVerdict[] = [];
	let failedRequests = 0;
	let next = 0;
	const worker = async () => {
		while (next < batches.length) {
			const batch = batches[next++];
			if (!batch) break;
			try {
				const answers = await options.controller.evaluateCodeDuplicates(
					batch.map((pair) => ({ unit: pair.unit, candidates: [pair.candidate] })),
					options.signal,
				);
				batch.forEach((pair, index) => {
					const answer = answers[duplicateQuestionId(index, 0)] as { noul?: unknown } | undefined;
					const probability = typeof answer?.noul === "number" ? answer.noul : Number.NaN;
					verdicts.push({
						...pair,
						probability,
						band: Number.isNaN(probability) ? "missing" : noulBand(probability, "required_true"),
					});
				});
			} catch {
				failedRequests += 1;
			}
		}
	};
	await Promise.all(Array.from({ length: options.concurrency ?? JEV_SCAN_CONCURRENCY }, worker));
	verdicts.sort((a, b) => (b.probability || 0) - (a.probability || 0));
	return { units: units.length, pairs: pairs.length, requests: batches.length, failedRequests, verdicts };
}
