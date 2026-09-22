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
import { extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { isDecisivelyTrue, type NoulBand, noulBand, settledAnswer } from "../decision/noul.ts";
import { defaultFffSearchBackend } from "../tools/fff-search-backend.ts";
import { resolveManagedSearchTool } from "../tools/managed-search-tool.ts";
import {
	type ArenaBuffers,
	arenaUnitFeatures,
	buildArena,
	type ScoringParameters,
	ScoringScratch,
	scoreProbe,
	type UnitFeatures,
} from "./code-unit-arena.ts";

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

/** Token kinds of the jscpd-style stream: identifiers and literals are normalized, punctuation is kept. */
const IDENTIFIER = 0;
const LITERAL = 1;
const PUNCT = 2;

/** One pass of the tokenizer over a whole file: its code tokens, and the spans that are quoted data. */
interface FileTokens {
	readonly starts: number[];
	readonly kinds: number[];
	readonly texts: string[];
	/** String literals and comments: a declaration starting inside one is data, not a unit. */
	readonly quoted: [number, number][];
}

const TOKEN_PATTERN =
	/\/\/[^\n]*|\/\*[\s\S]*?\*\/|(?<=^|\n)[ \t]*#[^\n]*|\s+|`(?:\\[\s\S]|[^`\\])*`|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\d[\w.]*|[A-Za-z_$][\w$]*|[^\s]/g;

/**
 * jscpd-style tokens, once per source: comments and whitespace dropped, identifiers and literals kept
 * with their kind so fingerprints can erase names and values. No vocabulary is involved.
 */
function tokenizeFile(text: string): FileTokens {
	const tokens: FileTokens = { starts: [], kinds: [], texts: [], quoted: [] };
	for (const match of text.matchAll(TOKEN_PATTERN)) {
		const token = match[0];
		const at = match.index ?? 0;
		if (token.startsWith("//") || token.startsWith("/*") || /^[ \t]*#/.test(token)) {
			tokens.quoted.push([at, at + token.length]);
			continue;
		}
		if (/^\s/.test(token)) continue;
		const kind = /^[A-Za-z_$]/.test(token) ? IDENTIFIER : /^["'`\d]/.test(token) ? LITERAL : PUNCT;
		if (kind === LITERAL && /^["'`]/.test(token)) tokens.quoted.push([at, at + token.length]);
		tokens.starts.push(at);
		tokens.kinds.push(kind);
		tokens.texts.push(token);
	}
	return tokens;
}

function insideSpan(spans: readonly [number, number][], index: number): boolean {
	let low = 0;
	let high = spans.length - 1;
	while (low <= high) {
		const middle = (low + high) >> 1;
		const [start, end] = spans[middle]!;
		if (index < start) high = middle - 1;
		else if (index >= end) low = middle + 1;
		else return true;
	}
	return false;
}

/** A unit together with the character span it occupies in its file's text. */
interface LocatedUnit extends CodeUnit {
	readonly start: number;
	readonly end: number;
}

function locateCodeUnits(path: string, text: string, tokens: FileTokens): LocatedUnit[] {
	const units: LocatedUnit[] = [];
	const seen = new Set<number>();
	for (const { pattern, body } of DECLARATIONS) {
		for (const match of text.matchAll(pattern)) {
			const index = match.index ?? 0;
			if (seen.has(index)) continue;
			// The declaration keyword itself, past any indentation the pattern consumed.
			const keywordAt = index + (match[0].length - match[0].trimStart().length);
			if (insideSpan(tokens.quoted, keywordAt)) continue;
			const name = body === "indent" ? match[2] : match[1];
			if (!name || NOT_A_NAME.has(name)) continue;
			const code = body === "indent" ? indentBody(text, index, match[1] ?? "") : braceBody(text, index);
			if (!code || code.split("\n").length < MIN_UNIT_LINES) continue;
			seen.add(index);
			units.push({
				path,
				name,
				line: text.slice(0, index).split("\n").length,
				code,
				start: index,
				end: index + code.length,
			});
		}
	}
	return units;
}

/** Every function-like unit declared in `text`, with a body long enough to carry a responsibility. */
export function extractCodeUnits(path: string, text: string): CodeUnit[] {
	return locateCodeUnits(path, text, tokenizeFile(text)).map(({ start: _start, end: _end, ...unit }) => unit);
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
/** Window length of the normalized-token fingerprints, as a clone scanner's minimum match. */
const FINGERPRINT_WINDOW = 8;

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

/** Concurrent Jev requests a scan keeps in flight; Jev evaluates each request's questions in parallel too. */
export const JEV_SCAN_CONCURRENCY = scaledToMachine(16);

/** String interning: every distinct string gets a stable small integer for the arena. */
class Interner {
	private readonly ids = new Map<string, number>();

	id(value: string): number {
		let id = this.ids.get(value);
		if (id === undefined) {
			id = this.ids.size;
			this.ids.set(value, id);
		}
		return id;
	}

	/** The id if already interned, otherwise -1: a lookup that never grows the vocabulary. */
	peek(value: string): number {
		return this.ids.get(value) ?? -1;
	}

	get size(): number {
		return this.ids.size;
	}
}

/** 32-bit FNV-1a over a window of symbol ids. */
function hashWindow(symbols: readonly number[], from: number): number {
	let hash = 0x811c9dc5;
	for (let index = from; index < from + FINGERPRINT_WINDOW; index += 1) {
		hash ^= symbols[index]!;
		hash = Math.imul(hash, 0x01000193);
	}
	return hash | 0;
}

function sortedUnique(values: number[]): Int32Array {
	const sorted = Int32Array.from(values).sort();
	let length = 0;
	for (let index = 0; index < sorted.length; index += 1)
		if (index === 0 || sorted[index] !== sorted[length - 1]) sorted[length++] = sorted[index]!;
	return sorted.slice(0, length);
}

/** The shared vocabularies features are expressed in. */
interface Vocabularies {
	readonly calls: Interner;
	readonly symbols: Interner;
	readonly paths: Interner;
	readonly names: Interner;
	readonly codes: Interner;
}

function createVocabularies(): Vocabularies {
	const symbols = new Interner();
	symbols.id("\u0000identifier");
	symbols.id("\u0000literal");
	return { calls: new Interner(), symbols, paths: new Interner(), names: new Interner(), codes: new Interner() };
}

/**
 * A unit's features from its file's token stream (no second read or tokenization of the source): the
 * calls it makes (identifiers followed by `(`), its normalized-token window hashes, and its size.
 * `grow` false looks calls up without adding them, for a probe that is not part of the index.
 */
function unitFeatures(unit: LocatedUnit, tokens: FileTokens, vocabularies: Vocabularies, grow: boolean): UnitFeatures {
	let from = 0;
	let to = tokens.starts.length;
	// First token at or after the unit's start, first at or after its end.
	for (let low = 0, high = tokens.starts.length; low < high; ) {
		const middle = (low + high) >> 1;
		if (tokens.starts[middle]! < unit.start) low = middle + 1;
		else high = middle;
		from = low;
	}
	for (let low = from, high = tokens.starts.length; low < high; ) {
		const middle = (low + high) >> 1;
		if (tokens.starts[middle]! < unit.end) low = middle + 1;
		else high = middle;
		to = low;
	}
	if (from >= tokens.starts.length) to = from;
	const calls: number[] = [];
	const symbols: number[] = [];
	for (let index = from; index < to; index += 1) {
		const kind = tokens.kinds[index]!;
		const text = tokens.texts[index]!;
		symbols.push(kind === IDENTIFIER ? 0 : kind === LITERAL ? 1 : vocabularies.symbols.id(text));
		if (kind === IDENTIFIER && index + 1 < to && tokens.texts[index + 1] === "(" && text !== unit.name) {
			const call = grow ? vocabularies.calls.id(text) : vocabularies.calls.peek(text);
			// An unseen call keeps an id past the vocabulary, which the arena weighs as the rarest possible.
			calls.push(call >= 0 ? call : vocabularies.calls.size + calls.length);
		}
	}
	const windows: number[] = [];
	for (let index = 0; index + FINGERPRINT_WINDOW <= symbols.length; index += 1)
		windows.push(hashWindow(symbols, index));
	return {
		calls: sortedUnique(calls),
		windows: sortedUnique(windows),
		tokenCount: to - from,
		pathId: vocabularies.paths.id(unit.path),
		nameId: vocabularies.names.id(unit.name),
		codeId: vocabularies.codes.id(unit.code),
	};
}

const SCORING: ScoringParameters = {
	minSimilarity: MIN_SIMILARITY,
	structuralMinTokens: STRUCTURAL_MIN_TOKENS,
	limit: MAX_CANDIDATES,
};

/**
 * Every function-like unit of one language family in the repository, held as a feature arena. Each
 * source is read and tokenized once, and again only when its mtime changes. Call rarity is the exact
 * document frequency across the indexed units, so what makes a call distinctive is measured, never
 * listed by hand. Scoring touches postings, never all pairs.
 */
export class SemanticUnitIndex {
	private readonly root: string;
	private readonly glob: string;
	private readonly lister: FileLister;
	private readonly vocabularies = createVocabularies();
	private readonly files = new Map<
		string,
		{ mtimeMs: number; units: readonly LocatedUnit[]; features: readonly UnitFeatures[] }
	>();
	private units: LocatedUnit[] = [];
	private positions = new Map<CodeUnit, number>();
	private arena: ArenaBuffers = buildArena([], 0);
	private scratch = new ScoringScratch(0);

	constructor(root: string, glob: string, lister: FileLister) {
		this.root = root;
		this.glob = glob;
		this.lister = lister;
	}

	async refresh(signal?: AbortSignal): Promise<void> {
		const listed = new Set(await this.lister(this.root, this.glob, signal));
		let changed = false;
		for (const path of this.files.keys())
			if (!listed.has(path)) {
				this.files.delete(path);
				changed = true;
			}
		await Promise.all(
			[...listed].map(async (path) => {
				const absolute = isAbsolute(path) ? path : join(this.root, path);
				try {
					const { mtimeMs } = await stat(absolute);
					if (this.files.get(path)?.mtimeMs === mtimeMs) return;
					const text = await readFile(absolute, "utf8");
					const tokens = tokenizeFile(text);
					const units = locateCodeUnits(path, text, tokens);
					const features = units.map((unit) => unitFeatures(unit, tokens, this.vocabularies, true));
					this.files.set(path, { mtimeMs, units, features });
					changed = true;
				} catch {
					if (this.files.delete(path)) changed = true;
				}
			}),
		);
		if (!changed && this.units.length > 0) return;
		const units: LocatedUnit[] = [];
		const features: UnitFeatures[] = [];
		for (const file of this.files.values()) {
			units.push(...file.units);
			features.push(...file.features);
		}
		this.units = units;
		this.positions = new Map(units.map((unit, index) => [unit, index]));
		this.arena = buildArena(features, this.vocabularies.calls.size);
		this.scratch = new ScoringScratch(units.length);
	}

	/** All indexed units, for a whole-repository scan. */
	allUnits(): readonly CodeUnit[] {
		return this.units;
	}

	/** The arena and its units, for scan workers. */
	snapshot(): { readonly arena: ArenaBuffers; readonly units: readonly CodeUnit[] } {
		return { arena: this.arena, units: this.units };
	}

	/** The indexed units most similar to `unit`, by calls or by structure, excluding the unit itself. */
	candidates(unit: CodeUnit, limit = MAX_CANDIDATES): DuplicateCandidate[] {
		const self = this.positions.get(unit) ?? -1;
		let probe: UnitFeatures;
		if (self >= 0) probe = arenaUnitFeatures(this.arena, self);
		else {
			const located: LocatedUnit = { ...unit, start: 0, end: unit.code.length };
			probe = unitFeatures(located, tokenizeFile(unit.code), this.vocabularies, false);
		}
		return scoreProbe(this.arena, probe, self, { ...SCORING, limit }, this.scratch).map((scored) => ({
			unit: this.units[scored.unit]!,
			callSimilarity: scored.callSimilarity,
			structuralSimilarity: scored.structuralSimilarity,
		}));
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
						if (settledAnswer(answer) === true)
							findings.push({ unit, candidate, decisive: isDecisivelyTrue(answer) });
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

/** Score every indexed unit as a probe across worker threads that share the arena without copies. */
async function scoreAllUnits(
	arena: ArenaBuffers,
	candidatesPerUnit: number,
	threads: number,
): Promise<{ probe: number; candidate: number; similarity: number }[]> {
	const parameters: ScoringParameters = { ...SCORING, limit: candidatesPerUnit };
	const count = arena.unitCount;
	const workers = Math.max(1, Math.min(threads, Math.ceil(count / 256)));
	const chunk = Math.ceil(count / workers);
	const parts = await Promise.all(
		Array.from({ length: workers }, (_, index) => {
			const from = index * chunk;
			const to = Math.min(count, from + chunk);
			return new Promise<Float64Array>((resolve, reject) => {
				const worker = new Worker(
					new URL(`./code-duplicate-scan-worker${extname(fileURLToPath(import.meta.url))}`, import.meta.url),
					{
						workerData: { arena, parameters, from, to },
					},
				);
				worker.once("message", (packed: Float64Array) => resolve(packed));
				worker.once("error", reject);
				worker.once("exit", (code) => {
					if (code !== 0) reject(new Error(`duplicate scan worker exited with code ${code}`));
				});
			});
		}),
	);
	const scored: { probe: number; candidate: number; similarity: number }[] = [];
	for (const packed of parts)
		for (let at = 0; at + 3 < packed.length; at += 4)
			scored.push({
				probe: packed[at]!,
				candidate: packed[at + 1]!,
				similarity: Math.max(packed[at + 2]!, packed[at + 3]!),
			});
	return scored;
}

/**
 * Judge every indexed unit against its closest candidates, each unordered pair once: the Jev
 * counterpart of a clone report. Candidates are scored across worker threads over the shared arena;
 * Jev requests are batched and kept in flight concurrently.
 */
export async function scanSemanticDuplicates(options: {
	readonly index: SemanticUnitIndex;
	readonly controller: DuplicateJudge;
	readonly concurrency?: number;
	readonly threads?: number;
	readonly candidatesPerUnit?: number;
	readonly signal?: AbortSignal;
}): Promise<SemanticDuplicateScan> {
	const { arena, units } = options.index.snapshot();
	const scored = await scoreAllUnits(
		arena,
		options.candidatesPerUnit ?? 3,
		options.threads ?? Math.max(1, availableParallelism() - 1),
	);
	const seen = new Set<number>();
	const pairs: { unit: CodeUnit; candidate: CodeUnit }[] = [];
	for (const { probe, candidate, similarity } of scored) {
		if (similarity < SCAN_MIN_SIMILARITY) continue;
		const key = Math.min(probe, candidate) * units.length + Math.max(probe, candidate);
		if (seen.has(key)) continue;
		seen.add(key);
		pairs.push({ unit: units[probe]!, candidate: units[candidate]! });
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
