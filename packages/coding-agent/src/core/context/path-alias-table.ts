import { homedir } from "node:os";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { formatPathRelativeToCwdOrAbsolute, resolvePath } from "../../utils/paths.ts";

const MIN_ALIAS_CHARS = 20;
const MIN_SEPARATORS = 2;
/**
 * The least an alias must save per mention, in characters, to be worth its legend line. A legend
 * line costs the id plus the display path (about 35 characters for a typical source path), so a
 * saving of ten a mention earns it back by the fourth mention; a saving of three never does.
 */
export const DEFAULT_MIN_ALIAS_SAVING = 10;
// One boundary vocabulary shared by extraction, rewriting, and expansion: a path or an
// alias token starts only at text start or after one of these delimiters. Rewriting may
// emit an id ONLY where extraction could have registered the containing path, and
// expansion parses ids back at exactly those positions — this shared set is what makes
// the whole cycle reversible (`git show HEAD:path`, `host:path`, comma lists included).
const LEFT_BOUNDARY_CLASS = String.raw`[\s"'=(\x60\[|;<>:,{}&]`;
// A token never ends in a dot: sentence-final punctuation after an emitted id
// (`see p/grep.ts.`) stays outside the token so legend scans and expansion still match.
const PATH_ALIAS_TOKEN_SRC = String.raw`p\/(?:[\w.+@~%-]+\/)*[\w.+@~%-]*[\w+@~%-]`;
// A token counts as an alias reference only when it stands alone at a shared boundary.
// Preceded by a path separator or path-token character it is part of a real filesystem
// path (src/p/util.ts) and must never be expanded.
const STANDALONE_TOKEN_RE = new RegExp(`(?<=^|${LEFT_BOUNDARY_CLASS})${PATH_ALIAS_TOKEN_SRC}`, "g");
// Anchored form: an alias id the expansion regex can match in full.
const FULL_TOKEN_RE = new RegExp(`^${PATH_ALIAS_TOKEN_SRC}$`);
const ALIAS_SEGMENT_RE = /^[\w.+@~%-]+$/;
// Segment whitelist matches the posix classes so `path.ts:125` / `path.ts(12,5)` grep and
// compiler suffixes never leak into a candidate. Parentheses are in: real names carry them
// (`Program Files (x86)`, `report (1).pdf`) and they are not sentence structure inside a token —
// a trailing `)` is handled by `stripTrailingPunctuation`'s balance check.
const SEGMENT_CHAR = String.raw`[\w.+@~%()-]`;
// A space may extend a segment only when what precedes it is not already a complete filename.
// Without this, one spaced segment swallows the gap between two separate paths
// (`.../Types.ts and packages/app/...` would read as a single segment) and merges them into one
// bogus candidate. It also stops a path from absorbing following prose (`...\c.ts now`).
const SPACE_CONTINUES_SEGMENT = String.raw`(?<!\.[A-Za-z0-9]{1,8}) +`;
// A segment may therefore contain interior spaces. For a directory segment the following
// separator proves the space is inside the path rather than the end of it; for the final segment
// the proof is a file extension, which `shouldAlias` requires of every spaced candidate.
const SEGMENT = `${SEGMENT_CHAR}+(?:${SPACE_CONTINUES_SEGMENT}${SEGMENT_CHAR}+)*`;
// Prefer the spaced-then-extension reading (`report (1).pdf`) and fall back to the space-free one,
// so a path followed by prose (`...\c.ts now`) still ends at the path.
const FINAL_SEGMENT = String.raw`(?:${SEGMENT_CHAR}+(?:${SPACE_CONTINUES_SEGMENT}${SEGMENT_CHAR}+)*\.\w+|${SEGMENT_CHAR}+)`;
const WINDOWS_PATH_RE = new RegExp(String.raw`\b[A-Za-z]:[\\/](?:${SEGMENT}[\\/])*${FINAL_SEGMENT}`, "g");
const POSIX_ABS_PATH_RE = new RegExp(
	String.raw`(?:^|${LEFT_BOUNDARY_CLASS})(\/(?:${SEGMENT}\/)+${FINAL_SEGMENT})`,
	"g",
);
// A relative path has no anchor of its own, so its FIRST segment must be space-free: otherwise a
// leading prose word is absorbed into it (`... and packages/app/src/types.ts` would start the
// candidate at "and"). Later segments are already fenced by the separators around them, and an
// absolute path is anchored by its `/` or drive prefix, so both may contain spaces.
const RELATIVE_PATH_RE = new RegExp(
	String.raw`(?:^|${LEFT_BOUNDARY_CLASS})(${SEGMENT_CHAR}+\/(?:${SEGMENT}\/)*${FINAL_SEGMENT})`,
	"g",
);
// A candidate that contains a space needs positive evidence that it is a path and not a run of
// prose that happens to straddle a separator ("see the src/lib and docs/api"). A trailing file
// extension is that evidence; the length gate alone is not, because prose clears it trivially.
const SPACED_CANDIDATE_EVIDENCE_RE = /^(?!.*\.\s).*\.\w+$/;
// A relative candidate whose spaced segment reads as prose is a sentence straddling separators,
// extension or not: "storage/id/commands in DESIGN.md" carries the extension evidence and was
// still aliased live (as p/commands-in-DESIGN.md, so the model re-read its own sentence as a
// filename). A function word between the words is the signature of prose; a spaced filename
// ("report (1).pdf", "notes 2024.txt") has none. Absolute candidates are anchored by their prefix
// and keep their spaces ("C:/Games/The Sims 4/save.dat").
const PROSE_FUNCTION_WORD_RE =
	/(?:^| )(?:a|an|and|as|at|be|by|for|from|if|in|into|is|it|its|of|on|or|per|the|then|this|to|via|with)(?= )/i;

function relativeSpacedProse(candidate: string): boolean {
	if (!candidate.includes(" ")) return false;
	return candidate.split("/").some((segment) => PROSE_FUNCTION_WORD_RE.test(segment));
}

export interface PathAliasEntry {
	id: string;
	path: string;
}

export interface PathAliasTable {
	readonly cwd: string;
	readonly entries: readonly PathAliasEntry[];
	/**
	 * Alias-shaped tokens observed in raw text that are NOT assigned ids — real paths
	 * under a literal `p/` directory, or stale/hallucinated echoes. Reserved so no new
	 * alias can ever collide with them and redirect a real-file reference.
	 */
	readonly reservedIds?: readonly string[];
}

function separatorCount(value: string): number {
	let count = 0;
	for (const char of value) {
		if (char === "/" || char === "\\") count += 1;
	}
	return count;
}

// IANA top-level media types: a single-separator token headed by one of these is a MIME
// type, not a filesystem path, even when it clears the length gate.
const MIME_TYPE_RE = /^(?:application|audio|example|font|haptics|image|message|model|multipart|text|video)\/[\w.+-]+$/i;

function shouldAlias(path: string): boolean {
	if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("git@")) return false;
	if (/^P#?\d+$/i.test(path) || path.startsWith("p/")) return false;
	if (MIME_TYPE_RE.test(path)) return false;
	if (path.includes(" ") && !SPACED_CANDIDATE_EVIDENCE_RE.test(path)) return false;
	return path.length >= MIN_ALIAS_CHARS || separatorCount(path) >= MIN_SEPARATORS;
}

// Trailing `)` is only punctuation when it does not close a `(` inside the path: `(see C:\a\b.ts)`
// ends a parenthetical, while `C:\Program Files (x86)` ends a real directory name.
function stripTrailingPunctuation(path: string): string {
	let end = path.length;
	while (end > 0) {
		const char = path[end - 1] ?? "";
		if (char === "," || char === "." || char === ";" || char === ":") {
			end -= 1;
			continue;
		}
		if (char === ")") {
			const head = path.slice(0, end);
			let depth = 0;
			for (const candidate of head) {
				if (candidate === "(") depth += 1;
				else if (candidate === ")") depth -= 1;
			}
			// depth < 0 means this `)` closes nothing inside the path — it is punctuation.
			if (depth < 0) {
				end -= 1;
				continue;
			}
		}
		break;
	}
	return path.slice(0, end);
}

function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

export function displayPath(path: string, cwd: string): string {
	return toPosix(formatPathRelativeToCwdOrAbsolute(path, cwd));
}

/**
 * Filesystem naming rules: one interface, one implementation per platform family. Every place that
 * has to decide "are these two spellings the same file" goes through this, so identity folding and
 * matcher construction can never drift apart the way two inline `process.platform` checks would.
 */
interface PathSemantics {
	/** Whether two spellings differing only in case name the same file. */
	readonly caseInsensitive: boolean;
	/** The display folded to the key that every spelling of one file must share. */
	identityKey(display: string): string;
}

const windowsPathSemantics: PathSemantics = {
	caseInsensitive: true,
	identityKey: (display) => display.toLowerCase(),
};

const posixPathSemantics: PathSemantics = {
	caseInsensitive: false,
	identityKey: (display) => display,
};

const DRIVE_LETTER_DISPLAY_RE = /^[A-Za-z]:\//;

/**
 * Chosen per path, not once per process: a drive-letter display names a Windows filesystem even
 * when the host is posix (a WSL session reading Windows tool output), and on a win32 host every
 * path follows Windows rules. Two case-differing posix paths on a posix host stay distinct files
 * that each deserve their own alias.
 */
function pathSemantics(display: string): PathSemantics {
	return process.platform === "win32" || DRIVE_LETTER_DISPLAY_RE.test(display)
		? windowsPathSemantics
		: posixPathSemantics;
}

function dedupeKey(path: string): string {
	return pathSemantics(path).identityKey(path);
}

// An alias pays for itself only when each mention saves real space: the legend line that
// introduces it costs the id plus the display path, so a saving of a few characters per mention
// never earns the line back (measured live: `test/commands.test.ts` aliased as
// `p/commands.test.ts` saved three characters a mention, cost a forty-character legend line, and
// then cost a model ten turns when it read the alias in `git status` as a literal path). The id is
// at least `p/` + basename, so the directory part is the most a mention can save; `.` and bare
// basenames save nothing.
function aliasWorthwhile(displayPath: string, minSaving: number): boolean {
	const basename = displayPath.slice(displayPath.lastIndexOf("/") + 1);
	return displayPath.length - (basename.length + 2) >= minSaving;
}

export function extractPathCandidates(text: string): string[] {
	const found: string[] = [];
	const seen = new Set<string>();
	const push = (raw: string) => {
		const path = stripTrailingPunctuation(raw);
		if (!shouldAlias(path)) return;
		if (seen.has(path)) return;
		seen.add(path);
		found.push(path);
	};
	// Windows spans are claimed first: a forward-slash drive path (`C:/Users/...`) must
	// not also yield a phantom posix candidate starting after its drive colon.
	const windowsSpans: Array<[number, number]> = [];
	for (const match of text.matchAll(WINDOWS_PATH_RE)) {
		const start = match.index ?? 0;
		windowsSpans.push([start, start + match[0].length]);
		push(match[0]);
	}
	const pushPosixMatches = (regex: RegExp, relative = false) => {
		// Both spans and match starts ascend, so one monotone cursor replaces a per-match
		// scan over all spans.
		let cursor = 0;
		for (const match of text.matchAll(regex)) {
			const path = match[1];
			if (!path) continue;
			const start = (match.index ?? 0) + match[0].length - path.length;
			while (cursor < windowsSpans.length && (windowsSpans[cursor]?.[1] ?? 0) <= start) cursor += 1;
			const span = windowsSpans[cursor];
			if (span !== undefined && start >= span[0] && start < span[1]) continue;
			if (relative && relativeSpacedProse(path)) continue;
			push(path);
		}
	};
	pushPosixMatches(POSIX_ABS_PATH_RE);
	pushPosixMatches(RELATIVE_PATH_RE, true);
	return found;
}

export function emptyPathAliasTable(cwd: string): PathAliasTable {
	return { cwd, entries: [] };
}

// The longest run of trailing segments that the alias-token regex can represent; a
// windows drive segment (`C:`) can head a display path but must never enter an id,
// or expansion could not match the id it produced.
function aliasableTail(segs: readonly string[]): string[] {
	const folded = segs.map(toAliasSegment);
	let start = segs.length;
	while (start > 0 && folded[start - 1] !== undefined) start -= 1;
	return folded.slice(start) as string[];
}

/**
 * A display segment folded into the alias-token alphabet. Displays may now contain spaces and
 * parentheses (`My Project`, `report (1).pdf`), but an id is parsed back out of free text by
 * `PATH_ALIAS_TOKEN_SRC`, which cannot represent either — an id carrying a space would be
 * unmatchable and would surface as an "unminted alias" on the tool boundary. Folding keeps ids
 * inside the token alphabet while `entries[].path` retains the real, spaced display that
 * expansion hands back. Deterministic, so the uniqueness pass below still sees id collisions.
 */
/**
 * Successive suffixes of an aliasable tail, shortest first (`file.ts`, `src/file.ts`, ...) — the
 * candidate ids for a path, in preference order. One owner: the uniqueness pass counts these and
 * then walks the identical sequence to assign, so the two must never drift apart.
 */
function tailSuffixes(tail: readonly string[]): string[] {
	const suffixes: string[] = [];
	let suffix = "";
	for (let depth = 1; depth <= tail.length; depth += 1) {
		const segment = tail[tail.length - depth] ?? "";
		suffix = depth === 1 ? segment : `${segment}/${suffix}`;
		suffixes.push(suffix);
	}
	return suffixes;
}

function toAliasSegment(segment: string): string | undefined {
	// A windows drive segment can head a display path but must never enter an id, or expansion
	// could not match the id it produced. Folding `C:` would hide that, so reject it outright.
	if (/^[A-Za-z]:$/.test(segment)) return undefined;
	const folded = segment
		.replace(/[^\w.+@~%-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/-+\./g, ".")
		.replace(/^[-.]+|[-.]+$/g, "");
	return ALIAS_SEGMENT_RE.test(folded) ? folded : undefined;
}

function shortestUniqueSuffixes(
	paths: readonly string[],
	reservedIds: ReadonlySet<string> = new Set(),
	isIdTaken?: (aliasId: string) => boolean,
): Map<string, string> {
	const tails = new Map<string, string[]>();
	// How many batch paths end in each suffix, precomputed once so the per-path clash
	// check is O(1) instead of a scan over every other path (which made a single sync
	// over an archive-listing-sized message quadratic and hang the session). A joined
	// suffix string is unambiguous: segments cannot contain "/", so suffixes of
	// different segment counts can never collide as strings.
	const suffixCounts = new Map<string, number>();
	for (const path of paths) {
		const segs = path.split("/").filter((segment) => segment.length > 0);
		const suffixes = tailSuffixes(aliasableTail(segs));
		tails.set(path, suffixes);
		// Counted in ID space (folded segments), which is where a collision actually matters:
		// two displays whose ids would coincide must not both claim the same suffix. Segments
		// above the aliasable tail can never appear in an id, so they need no count.
		for (const suffix of suffixes) suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
	}
	const ids = new Map<string, string>();
	const assigned = new Set<string>();
	// An alias id clashes when it's reserved, already assigned this batch, shared as a
	// suffix with another batch path (so expansion would be ambiguous), or taken on disk.
	// The disk check runs last: it can be a real filesystem stat, expensive on slow
	// mounts (WSL /mnt drives), so every cheap check must short-circuit it.
	const clashes = (aliasId: string, suffix: string, othersThreshold: number): boolean =>
		reservedIds.has(aliasId) ||
		assigned.has(aliasId) ||
		(suffixCounts.get(suffix) ?? 0) > othersThreshold ||
		(isIdTaken?.(aliasId) ?? false);
	for (const path of paths) {
		const suffixes = tails.get(path) ?? [];
		for (const suffix of suffixes) {
			const aliasId = `p/${suffix}`;
			// This path's own suffix always contributes 1 to the count.
			if (!clashes(aliasId, suffix, 1)) {
				ids.set(path, aliasId);
				assigned.add(aliasId);
				break;
			}
		}
		if (!ids.has(path)) {
			// The longest suffix IS the whole aliasable tail.
			const tailJoined = suffixes[suffixes.length - 1] ?? "";
			let counter = 2;
			while (true) {
				const counterSuffix = `${counter}/${tailJoined}`;
				const aliasId = `p/${counterSuffix}`;
				// A counter-prefixed suffix is never one of this path's own suffixes (the
				// aliasable tail is maximal, so the segment before it can't be a bare number
				// in the tail's alphabet), so any count at all is another path's.
				if (!clashes(aliasId, counterSuffix, 0)) {
					ids.set(path, aliasId);
					assigned.add(aliasId);
					break;
				}
				counter += 1;
			}
		}
	}
	return ids;
}

/**
 * Upper bound on retained reserved tokens. Without one, an archive listing that contains
 * a real `p/` tree can push thousands of reservations into the table (and, through the
 * runtime, into a durable JSON meta blob rewritten every sync) with no decay. The policy
 * is first-come-keep: once at the cap, later observations are refused rather than
 * rotating older ones out — eviction would thrash (dropped tokens still visible in
 * history re-enter on every sync), while refusal is stable and keeps protection on the
 * repo's own early-observed `p/` paths. Reservations are defense-in-depth either way:
 * the on-disk `isIdTaken` check remains the hard guard for real `p/` files at mint time.
 */
export const MAX_RESERVED_TOKENS = 4_096;

function addReservation(reservations: Set<string>, token: string): void {
	if (reservations.has(token)) return;
	if (reservations.size >= MAX_RESERVED_TOKENS) return;
	reservations.add(token);
}

export interface ExtendPathAliasOptions {
	/**
	 * Texts to scan for reserved `p/...` tokens. Defaults to `texts`. The runtime passes
	 * ALL visible message texts here while `texts` carries only not-yet-scanned ones, so
	 * real `p/` paths in already-scanned history still reserve their names after a resume.
	 */
	reservationTexts?: readonly string[];
	/** Least saving per mention an alias must offer; defaults to `DEFAULT_MIN_ALIAS_SAVING`. */
	minAliasSaving?: number;
	isIdTaken?: (aliasId: string) => boolean;
}

export function extendPathAliasTable(
	table: PathAliasTable,
	texts: readonly string[],
	options?: ExtendPathAliasOptions,
): { table: PathAliasTable; inserted: PathAliasEntry[] } {
	const minSaving = options?.minAliasSaving ?? DEFAULT_MIN_ALIAS_SAVING;
	const existingPaths = new Set(table.entries.map((entry) => dedupeKey(entry.path)));
	const entryIds = new Set(table.entries.map((entry) => entry.id));
	const reservations = new Set(table.reservedIds ?? []);
	const priorReservationCount = reservations.size;
	const newPaths: string[] = [];
	for (const text of options?.reservationTexts ?? texts) {
		for (const match of text.matchAll(STANDALONE_TOKEN_RE)) {
			if (!entryIds.has(match[0])) addReservation(reservations, match[0]);
		}
	}
	for (const text of texts) {
		for (const candidate of extractPathCandidates(text)) {
			const path = displayPath(candidate, table.cwd);
			// A display inside the reserved `p/` namespace (a real file under a literal
			// `p/` directory, reached via an absolute or `./` mention) is never aliased —
			// it is reserved so no alias can collide with it.
			if (path.startsWith("p/")) {
				addReservation(reservations, path);
				continue;
			}
			const key = dedupeKey(path);
			if (existingPaths.has(key)) continue;
			if (!aliasWorthwhile(path, minSaving)) continue;
			existingPaths.add(key);
			newPaths.push(path);
		}
	}
	if (newPaths.length === 0 && reservations.size === priorReservationCount) {
		return { table, inserted: [] };
	}
	const ids = shortestUniqueSuffixes(newPaths, new Set([...entryIds, ...reservations]), options?.isIdTaken);
	const inserted = newPaths.map((path) => ({ id: ids.get(path) ?? `p/${path}`, path }));
	return {
		table: { cwd: table.cwd, entries: [...table.entries, ...inserted], reservedIds: [...reservations] },
		inserted,
	};
}

export function buildPathAliasTable(
	cwd: string,
	texts: readonly string[],
	isIdTaken?: (aliasId: string) => boolean,
	options?: { readonly minAliasSaving?: number },
): PathAliasTable {
	const minSaving = options?.minAliasSaving ?? DEFAULT_MIN_ALIAS_SAVING;
	const byKey = new Map<string, string>();
	const uniquePaths: string[] = [];
	const reservations = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(STANDALONE_TOKEN_RE)) addReservation(reservations, match[0]);
		for (const candidate of extractPathCandidates(text)) {
			const path = displayPath(candidate, cwd);
			if (path.startsWith("p/")) {
				addReservation(reservations, path);
				continue;
			}
			const key = dedupeKey(path);
			if (byKey.has(key)) continue;
			if (!aliasWorthwhile(path, minSaving)) continue;
			byKey.set(key, path);
			uniquePaths.push(path);
		}
	}
	const ids = shortestUniqueSuffixes(uniquePaths, reservations, isIdTaken);
	return {
		cwd,
		entries: uniquePaths.map((path) => ({ id: ids.get(path) ?? `p/${path}`, path })),
		reservedIds: [...reservations],
	};
}

/** The alias ids standing alone at a shared boundary in `texts` — the ones a reader can hit. */
export function collectActiveAliasIds(texts: readonly string[]): Set<string> {
	const ids = new Set<string>();
	for (const text of texts) {
		for (const match of text.matchAll(STANDALONE_TOKEN_RE)) {
			ids.add(match[0]);
		}
	}
	return ids;
}

/**
 * Render the legend for an explicit id set, in table (mint) order. Entries only ever append
 * to a table, so a caller that passes a MONOTONE id set gets a legend that can only grow by
 * appended lines — which is what keeps it cheap to re-send (see {@link PathAliasRuntime}).
 */
export function formatPathAliasLegendForIds(table: PathAliasTable, ids: ReadonlySet<string>): string | undefined {
	if (table.entries.length === 0) return undefined;
	const activeEntries = table.entries.filter((entry) => ids.has(entry.id));
	if (activeEntries.length === 0) return undefined;
	const lines = ["PATH ALIASES", ...activeEntries.map((entry) => `${entry.id}=${entry.path}`)];
	return lines.join("\n");
}

export function formatPathAliasLegend(table: PathAliasTable, activeTexts?: string[]): string | undefined {
	if (table.entries.length === 0) return undefined;
	if (!activeTexts) {
		return ["PATH ALIASES", ...table.entries.map((entry) => `${entry.id}=${entry.path}`)].join("\n");
	}
	return formatPathAliasLegendForIds(table, collectActiveAliasIds(activeTexts));
}

function escapeRegExp(string: string) {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledRewriter {
	cwd: string;
	regex: RegExp | undefined;
	map: Map<string, string>;
	/** `formKey`-normalized fallback: what a separator- or case-variant match resolves through. */
	normalized: Map<string, string>;
}

// A mention spells the same path with `/`, `\`, or a mix of both (routine in Windows tool
// output), and on a case-insensitive filesystem it may differ in case too. Extraction already
// folds all of those onto ONE display before an entry is minted, so matching has to accept the
// same space — otherwise extraction registers a path the rewriter cannot match, and the text pays
// for both the legend line and the raw path forever. Both sides ask `pathSemantics`, so the
// matcher's notion of "same file" is the same one that minted the entry.
function formKey(form: string): string {
	const posix = toPosix(form);
	return pathSemantics(posix).identityKey(posix);
}

function formPattern(form: string): string {
	const separatorAgnostic = escapeRegExp(form).replace(/\\\\|\//g, "[/\\\\]");
	return pathSemantics(toPosix(form)).caseInsensitive ? `(?i:${separatorAgnostic})` : separatorAgnostic;
}

const rewriterCache = new WeakMap<readonly PathAliasEntry[], CompiledRewriter>();

// The text forms an entry can appear under: the stored display path, its `./` spelling,
// its absolute resolution, the `~/` form when that resolution lies under the home
// directory, and the backslash variant of each.
function rewriteForms(entry: PathAliasEntry, cwd: string, home: string): string[] {
	const forms = [entry.path];
	// A display can already BE absolute (a Windows drive path, or a posix path whose
	// display picker chose the absolute spelling because it was shorter than the
	// cwd-relative one) — that must not skip computing its `~/` form when it happens to
	// live under home, so absoluteness and tilde-eligibility are checked independently.
	const isAbsoluteDisplay = /^[A-Za-z]:\//.test(entry.path) || entry.path.startsWith("/");
	if (!isAbsoluteDisplay) forms.push(`./${entry.path}`);
	const absolute = isAbsoluteDisplay ? entry.path : toPosix(resolvePath(entry.path, cwd));
	if (absolute !== entry.path) forms.push(absolute);
	if (home && absolute.startsWith(`${home}/`)) forms.push(`~${absolute.slice(home.length)}`);
	for (const form of [...forms]) {
		const windows = form.replaceAll("/", "\\");
		if (windows !== form) forms.push(windows);
	}
	return forms;
}

function compileRewriter(table: PathAliasTable): CompiledRewriter {
	const cached = rewriterCache.get(table.entries);
	if (cached && cached.cwd === table.cwd) return cached;
	const home = toPosix(homedir());
	const forms: Array<{ form: string; id: string }> = [];
	for (const entry of table.entries) {
		// Durable tables can hold legacy rows whose id the token regex cannot expand,
		// whose display is shorter than any alias, or whose display lives inside the
		// reserved `p/` namespace (an alias-shaped form the token guard would rewrite at
		// positions expansion refuses); none may ever be written into text.
		if (!FULL_TOKEN_RE.test(entry.id) || !aliasWorthwhile(entry.path, 1) || entry.path.startsWith("p/")) continue;
		for (const form of rewriteForms(entry, table.cwd, home)) forms.push({ form, id: entry.id });
	}
	forms.sort((left, right) => right.form.length - left.form.length);
	const map = new Map<string, string>();
	const normalized = new Map<string, string>();
	const patterns: string[] = [];
	const seenPatterns = new Set<string>();
	for (const { form, id } of forms) {
		if (!map.has(form)) map.set(form, id);
		const key = formKey(form);
		if (!normalized.has(key)) normalized.set(key, id);
		// Separator tolerance collapses each form and its backslash twin onto one pattern, so
		// the compiled alternation is no larger than before despite matching a wider space.
		const pattern = formPattern(form);
		if (seenPatterns.has(pattern)) continue;
		seenPatterns.add(pattern);
		patterns.push(pattern);
	}
	// The alias-token alternative comes first so text that already carries `p/...` ids
	// (a model echo stored durably, or a second rewrite pass) is consumed atomically and
	// left unchanged — rewriting is idempotent. Entry forms match only between shared
	// boundaries: the positive lookbehind restricts starts to positions where extraction
	// could have registered the containing path, so a shorter entry can never mangle a
	// longer unregistered path (`git show HEAD:packages/...`). The lookaheads keep a
	// match from swallowing the head of a longer token (`file.ts.bak`, `octet-streams`)
	// or stopping mid-path before a deeper segment; a bare trailing `.` or separator
	// stays allowed so sentence-final paths and `dir/` mentions still alias.
	const regex =
		patterns.length === 0
			? undefined
			: new RegExp(
					String.raw`\b${PATH_ALIAS_TOKEN_SRC}|(?<=^|${LEFT_BOUNDARY_CLASS})(?:${patterns.join("|")})(?![\w+@~%-])(?!\.\w)(?![/\\][\w.+@~%-])`,
					"g",
				);
	const compiled = { cwd: table.cwd, regex, map, normalized };
	rewriterCache.set(table.entries, compiled);
	return compiled;
}

export function rewriteText(table: PathAliasTable, text: string): string {
	if (table.entries.length === 0) return text;
	const { regex, map, normalized } = compileRewriter(table);
	if (!regex) return text;
	// Exact form first (the common case and the cheapest); a separator- or case-variant spelling
	// resolves through the normalized key. A match that is an alias token already — the leading
	// alternative — is in neither map and falls through unchanged, keeping rewriting idempotent.
	return text.replace(regex, (match) => map.get(match) ?? normalized.get(formKey(match)) ?? match);
}

// Memoized on the entries array identity, exactly like `rewriterCache`. Expansion runs on every
// tool argument AND on every message rendered to the operator, while the table grows all session;
// rebuilding the lookup per call made the cost O(calls x entries), i.e. quadratic in session size.
// Entries are append-only under one identity, so the cached map is always complete for that array.
const expanderCache = new WeakMap<readonly PathAliasEntry[], Map<string, string>>();

function compileExpander(table: PathAliasTable): Map<string, string> {
	const cached = expanderCache.get(table.entries);
	if (cached) return cached;
	const byId = new Map(table.entries.map((entry) => [entry.id, entry.path]));
	expanderCache.set(table.entries, byId);
	return byId;
}

export function expandText(table: PathAliasTable, text: string): string {
	if (table.entries.length === 0) return text;
	const byId = compileExpander(table);
	return text.replace(STANDALONE_TOKEN_RE, (token) => byId.get(token) ?? token);
}

/**
 * Alias-shaped tokens in `params` that name nothing: not a minted id, not a reserved token. The
 * model extrapolates ids from the legend's pattern (`p/module01.ts` is listed, so `p/module02.ts`
 * "must" exist); expansion leaves such a token alone, and it then fails as a literal path with an
 * ENOENT that names a `p/` directory nobody has — a diagnostic that hides the actual mistake.
 * Walks the same shapes as {@link expandParams}. Deduplicated, in first-seen order.
 */
export function collectUnknownAliasTokens(table: PathAliasTable, params: unknown): string[] {
	const known = new Set<string>(table.entries.map((entry) => entry.id));
	for (const reserved of table.reservedIds ?? []) known.add(reserved);
	const unknown: string[] = [];
	const seen = new Set<string>();
	const walk = (value: unknown): void => {
		if (typeof value === "string") {
			for (const match of value.matchAll(STANDALONE_TOKEN_RE)) {
				const token = match[0];
				if (known.has(token) || seen.has(token)) continue;
				seen.add(token);
				unknown.push(token);
			}
			return;
		}
		if (Array.isArray(value)) {
			for (const entry of value) walk(entry);
			return;
		}
		if (value && typeof value === "object") {
			for (const entry of Object.values(value)) walk(entry);
		}
	};
	walk(params);
	return unknown;
}

export function expandParams(table: PathAliasTable, params: unknown): unknown {
	if (typeof params === "string") return expandText(table, params);
	if (Array.isArray(params)) return params.map((entry) => expandParams(table, entry));
	if (params && typeof params === "object") {
		const next: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(params)) {
			next[key] = expandParams(table, value);
		}
		return next;
	}
	return params;
}

function contentTexts(content: unknown): string[] {
	if (typeof content === "string") return [content];
	if (!Array.isArray(content)) return [];
	const texts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") texts.push(text);
		}
	}
	return texts;
}

function textsFromMessage(message: AgentMessage): string[] {
	if (message.role === "bashExecution") return [message.command, message.output];
	if (message.role === "compactionSummary" || message.role === "branchSummary") return [message.summary];
	if ("content" in message) return contentTexts(message.content);
	return [];
}

export function collectMessageTexts(messages: readonly AgentMessage[]): string[] {
	return messages.flatMap(textsFromMessage);
}

function rewriteContentWith(content: unknown, hooks: MessageRewriteHooks): unknown {
	if (typeof content === "string") return hooks.text(content);
	if (!Array.isArray(content)) return content;
	let changed = false;
	const next = content.map((part) => {
		if (!part || typeof part !== "object" || !("type" in part)) return part;
		if (part.type === "text" && "text" in part) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") {
				const rewritten = hooks.text(text);
				if (rewritten !== text) {
					changed = true;
					return { ...part, text: rewritten };
				}
			}
			return part;
		}
		if (hooks.thinkingText && part.type === "thinking" && "thinking" in part) {
			const thinking = (part as { thinking?: unknown }).thinking;
			if (typeof thinking === "string") {
				const rewritten = hooks.thinkingText(thinking);
				if (rewritten !== thinking) {
					changed = true;
					return { ...part, thinking: rewritten };
				}
			}
			return part;
		}
		if (hooks.toolCallArguments && part.type === "toolCall" && "arguments" in part) {
			const args = (part as { arguments?: unknown }).arguments;
			const rewritten = hooks.toolCallArguments(args);
			if (rewritten !== args) {
				changed = true;
				return { ...part, arguments: rewritten };
			}
		}
		return part;
	});
	return changed ? next : content;
}

/** Rewrites one provider-visible text span. */
export type TextRewriter = (text: string) => string;

export interface MessageRewriteHooks {
	/** Applied to every text span: prose, tool output, bash command/output, summaries. */
	text: TextRewriter;
	/**
	 * Applied to a tool call's arguments. Omitted by the provider-projection callers, whose job is
	 * text compression only; supplied by display expansion, where the arguments a person reads must
	 * name real files. Must return the SAME reference when nothing changed.
	 */
	toolCallArguments?: (args: unknown) => unknown;
	/**
	 * Applied to a `thinking` block's text. Deliberately separate from `text` and omitted by the
	 * provider-projection caller ({@link PathAliasRuntime.renderFrozen}): a provider that returns a
	 * `thinkingSignature` (Anthropic extended thinking) requires the thinking text to be replayed
	 * byte-for-byte on the next request, and rewriting it here would desync the text from a
	 * signature computed over the original bytes. Display expansion supplies this hook because the
	 * operator reading a rendered thinking block must see the same real paths as everywhere else.
	 */
	thinkingText?: TextRewriter;
}

/**
 * Structure-preserving message rewrite through caller-supplied hooks. The runtime uses it to render
 * each text span through a FROZEN spelling (see {@link PathAliasRuntime}), and display expansion
 * uses it to turn aliases back into real paths; `rewriteAgentMessages` is the pure whole-table form.
 * One walk, so message shape is handled in exactly one place. A message whose spans all come back
 * unchanged is returned by identity, so an unchanged history costs no allocation.
 */
/** The custom message kind that carries the alias legend; its own text is never alias-rewritten. */
export const PATH_ALIAS_LEGEND_CUSTOM_TYPE = "path_alias_legend";

export function rewriteAgentMessagesWith(
	messages: readonly AgentMessage[],
	rewriter: TextRewriter | MessageRewriteHooks,
): AgentMessage[] {
	const hooks: MessageRewriteHooks = typeof rewriter === "function" ? { text: rewriter } : rewriter;
	const rewrite = hooks.text;
	return messages.map((message) => {
		if (message.role === "bashExecution") {
			const command = rewrite(message.command);
			const output = rewrite(message.output);
			if (command === message.command && output === message.output) return message;
			return { ...message, command, output };
		}
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			const summary = rewrite(message.summary);
			return summary === message.summary ? message : { ...message, summary };
		}
		if ("content" in message) {
			const content = rewriteContentWith(message.content, hooks);
			return content === message.content ? message : ({ ...message, content } as AgentMessage);
		}
		return message;
	});
}

export function rewriteAgentMessages(messages: readonly AgentMessage[], table: PathAliasTable): AgentMessage[] {
	if (table.entries.length === 0) return [...messages];
	return rewriteAgentMessagesWith(messages, (text) => rewriteText(table, text));
}

export function applyPathAliases(
	cwd: string,
	messages: readonly AgentMessage[],
): { table: PathAliasTable; messages: AgentMessage[]; legend: string | undefined } {
	const table = buildPathAliasTable(cwd, collectMessageTexts(messages));
	const rewritten = rewriteAgentMessages(messages, table);
	return {
		table,
		messages: rewritten,
		legend: formatPathAliasLegend(table, collectMessageTexts(rewritten)),
	};
}
