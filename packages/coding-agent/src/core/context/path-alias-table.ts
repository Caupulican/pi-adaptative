import { homedir } from "node:os";
import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { formatPathRelativeToCwdOrAbsolute, resolvePath } from "../../utils/paths.ts";

const MIN_ALIAS_CHARS = 20;
const MIN_SEPARATORS = 2;
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
// compiler suffixes never leak into a candidate.
const WINDOWS_PATH_RE = /\b[A-Za-z]:[\\/](?:[\w.+@~%-]+[\\/])*[\w.+@~%-]+/g;
const POSIX_ABS_PATH_RE = new RegExp(String.raw`(?:^|${LEFT_BOUNDARY_CLASS})(\/(?:[\w.+@~%-]+\/)+[\w.+@~%-]+)`, "g");
const RELATIVE_PATH_RE = new RegExp(String.raw`(?:^|${LEFT_BOUNDARY_CLASS})((?:[\w.+@~%-]+\/){1,}[\w.+@~%-]+)`, "g");

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
	return path.length >= MIN_ALIAS_CHARS || separatorCount(path) >= MIN_SEPARATORS;
}

function stripTrailingPunctuation(path: string): string {
	return path.replace(/[),.;:]+$/g, "");
}

function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

export function displayPath(path: string, cwd: string): string {
	return toPosix(formatPathRelativeToCwdOrAbsolute(path, cwd));
}

// Windows drive-letter paths — and every path on a Windows host — are case-insensitive;
// posix paths on posix hosts are not, and two case-differing posix paths are distinct
// files that both deserve aliases.
function dedupeKey(path: string): string {
	if (process.platform === "win32" || /^[A-Za-z]:\//.test(path)) return path.toLowerCase();
	return path;
}

// An alias only saves space when the display path is longer than its own shortest
// possible id (`p/` + basename); `.` and bare basenames fail this.
function aliasWorthwhile(displayPath: string): boolean {
	const basename = displayPath.slice(displayPath.lastIndexOf("/") + 1);
	return displayPath.length > basename.length + 2;
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
	const pushPosixMatches = (regex: RegExp) => {
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
			push(path);
		}
	};
	pushPosixMatches(POSIX_ABS_PATH_RE);
	pushPosixMatches(RELATIVE_PATH_RE);
	return found;
}

export function emptyPathAliasTable(cwd: string): PathAliasTable {
	return { cwd, entries: [] };
}

// The longest run of trailing segments that the alias-token regex can represent; a
// windows drive segment (`C:`) can head a display path but must never enter an id,
// or expansion could not match the id it produced.
function aliasableTail(segs: readonly string[]): string[] {
	let start = segs.length;
	while (start > 0 && ALIAS_SEGMENT_RE.test(segs[start - 1] ?? "")) start -= 1;
	return segs.slice(start);
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
		tails.set(path, aliasableTail(segs));
		let suffix = "";
		for (let depth = 1; depth <= segs.length; depth += 1) {
			const segment = segs[segs.length - depth] ?? "";
			suffix = depth === 1 ? segment : `${segment}/${suffix}`;
			suffixCounts.set(suffix, (suffixCounts.get(suffix) ?? 0) + 1);
		}
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
		const tail = tails.get(path) ?? [];
		let suffix = "";
		for (let depth = 1; depth <= tail.length; depth += 1) {
			const segment = tail[tail.length - depth] ?? "";
			suffix = depth === 1 ? segment : `${segment}/${suffix}`;
			const aliasId = `p/${suffix}`;
			// This path's own suffix always contributes 1 to the count.
			if (!clashes(aliasId, suffix, 1)) {
				ids.set(path, aliasId);
				assigned.add(aliasId);
				break;
			}
		}
		if (!ids.has(path)) {
			const tailJoined = tail.join("/");
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
	isIdTaken?: (aliasId: string) => boolean;
}

export function extendPathAliasTable(
	table: PathAliasTable,
	texts: readonly string[],
	options?: ExtendPathAliasOptions,
): { table: PathAliasTable; inserted: PathAliasEntry[] } {
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
			if (!aliasWorthwhile(path)) continue;
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
): PathAliasTable {
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
			if (!aliasWorthwhile(path)) continue;
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

export function formatPathAliasLegend(table: PathAliasTable, activeTexts?: string[]): string | undefined {
	if (table.entries.length === 0) return undefined;

	let activeEntries = table.entries;
	if (activeTexts) {
		const activeIds = new Set<string>();
		for (const text of activeTexts) {
			for (const match of text.matchAll(STANDALONE_TOKEN_RE)) {
				activeIds.add(match[0]);
			}
		}
		activeEntries = table.entries.filter((entry) => activeIds.has(entry.id));
	}

	if (activeEntries.length === 0) return undefined;
	const lines = ["PATH ALIASES", ...activeEntries.map((entry) => `${entry.id}=${entry.path}`)];
	return lines.join("\n");
}

function escapeRegExp(string: string) {
	return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CompiledRewriter {
	cwd: string;
	regex: RegExp | undefined;
	map: Map<string, string>;
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
		if (!FULL_TOKEN_RE.test(entry.id) || !aliasWorthwhile(entry.path) || entry.path.startsWith("p/")) continue;
		for (const form of rewriteForms(entry, table.cwd, home)) forms.push({ form, id: entry.id });
	}
	forms.sort((left, right) => right.form.length - left.form.length);
	const map = new Map<string, string>();
	const patterns: string[] = [];
	for (const { form, id } of forms) {
		if (map.has(form)) continue;
		map.set(form, id);
		patterns.push(escapeRegExp(form));
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
	const compiled = { cwd: table.cwd, regex, map };
	rewriterCache.set(table.entries, compiled);
	return compiled;
}

export function rewriteText(table: PathAliasTable, text: string): string {
	if (table.entries.length === 0) return text;
	const { regex, map } = compileRewriter(table);
	if (!regex) return text;
	return text.replace(regex, (match) => map.get(match) ?? match);
}

export function expandText(table: PathAliasTable, text: string): string {
	if (table.entries.length === 0) return text;
	const byId = new Map(table.entries.map((entry) => [entry.id, entry.path]));
	return text.replace(STANDALONE_TOKEN_RE, (token) => byId.get(token) ?? token);
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

function rewriteContent(table: PathAliasTable, content: unknown): unknown {
	if (typeof content === "string") return rewriteText(table, content);
	if (!Array.isArray(content)) return content;
	return content.map((part) => {
		if (part && typeof part === "object" && "type" in part && part.type === "text" && "text" in part) {
			const text = (part as { text?: unknown }).text;
			if (typeof text === "string") return { ...part, text: rewriteText(table, text) };
		}
		return part;
	});
}

export function rewriteAgentMessages(messages: readonly AgentMessage[], table: PathAliasTable): AgentMessage[] {
	if (table.entries.length === 0) return [...messages];
	return messages.map((message) => {
		if (message.role === "bashExecution") {
			return {
				...message,
				command: rewriteText(table, message.command),
				output: rewriteText(table, message.output),
			};
		}
		if (message.role === "compactionSummary" || message.role === "branchSummary") {
			return { ...message, summary: rewriteText(table, message.summary) };
		}
		if ("content" in message) {
			return { ...message, content: rewriteContent(table, message.content) } as AgentMessage;
		}
		return message;
	});
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
