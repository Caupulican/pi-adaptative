import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { formatPathRelativeToCwdOrAbsolute } from "../../utils/paths.ts";

const MIN_ALIAS_CHARS = 20;
const MIN_SEPARATORS = 2;
const PATH_ALIAS_TOKEN_RE = /\bp\/(?:[\w.+@-]+\/)*[\w.+@-]+/g;
const WINDOWS_PATH_RE = /\b[A-Za-z]:[\\/][^\s"'<>|*?]+/g;
const POSIX_ABS_PATH_RE = /(?:^|[\s"'=(`[])(\/(?:[\w.+@-]+\/)+[\w.+@-]+)/g;
const RELATIVE_PATH_RE = /(?:^|[\s"'=(`[])((?:[\w.+@-]+\/){2,}[\w.+@-]+)/g;

export interface PathAliasEntry {
	id: string;
	path: string;
}

export interface PathAliasTable {
	readonly cwd: string;
	readonly entries: readonly PathAliasEntry[];
}

function separatorCount(value: string): number {
	let count = 0;
	for (const char of value) {
		if (char === "/" || char === "\\") count += 1;
	}
	return count;
}

function shouldAlias(path: string): boolean {
	if (path.startsWith("http://") || path.startsWith("https://") || path.startsWith("git@")) return false;
	if (/^P#?\d+$/i.test(path) || path.startsWith("p/")) return false;
	return path.length >= MIN_ALIAS_CHARS || separatorCount(path) >= MIN_SEPARATORS;
}

function stripTrailingPunctuation(path: string): string {
	return path.replace(/[),.;:]+$/g, "");
}

function toPosix(path: string): string {
	return path.replace(/\\/g, "/");
}

function displayPath(path: string, cwd: string): string {
	return toPosix(formatPathRelativeToCwdOrAbsolute(path, cwd));
}

export function extractPathCandidates(text: string): string[] {
	const found: string[] = [];
	const push = (raw: string) => {
		const path = stripTrailingPunctuation(raw);
		if (!shouldAlias(path)) return;
		if (!found.includes(path)) found.push(path);
	};
	for (const match of text.match(WINDOWS_PATH_RE) ?? []) push(match);
	for (const match of text.matchAll(POSIX_ABS_PATH_RE)) {
		const path = match[1];
		if (path) push(path);
	}
	for (const match of text.matchAll(RELATIVE_PATH_RE)) {
		const path = match[1];
		if (path) push(path);
	}
	return found;
}

export function emptyPathAliasTable(cwd: string): PathAliasTable {
	return { cwd, entries: [] };
}

function shortestUniqueSuffixes(
	paths: readonly string[],
	reservedIds: ReadonlySet<string> = new Set(),
): Map<string, string> {
	const segments = new Map<string, string[]>();
	for (const path of paths) {
		segments.set(
			path,
			path.split("/").filter((segment) => segment.length > 0),
		);
	}
	const ids = new Map<string, string>();
	for (const path of paths) {
		const segs = segments.get(path) ?? [];
		let depth = 1;
		while (depth <= segs.length) {
			const suffix = segs.slice(-depth).join("/");
			const aliasId = `p/${suffix}`;
			const clash =
				reservedIds.has(aliasId) ||
				paths.some((other) => {
					if (other === path) return false;
					const otherSegs = segments.get(other) ?? [];
					return otherSegs.slice(-depth).join("/") === suffix;
				});
			if (!clash) {
				ids.set(path, aliasId);
				break;
			}
			depth += 1;
		}
		if (!ids.has(path)) ids.set(path, `p/${segs.join("/")}`);
	}
	return ids;
}

export function extendPathAliasTable(
	table: PathAliasTable,
	texts: readonly string[],
): { table: PathAliasTable; inserted: PathAliasEntry[] } {
	const existingPaths = new Set(table.entries.map((entry) => entry.path.toLowerCase()));
	const reservedIds = new Set(table.entries.map((entry) => entry.id));
	const newPaths: string[] = [];
	for (const text of texts) {
		for (const candidate of extractPathCandidates(text)) {
			const path = displayPath(candidate, table.cwd);
			const key = path.toLowerCase();
			if (existingPaths.has(key)) continue;
			existingPaths.add(key);
			newPaths.push(path);
		}
	}
	if (newPaths.length === 0) return { table, inserted: [] };
	const ids = shortestUniqueSuffixes(newPaths, reservedIds);
	const inserted = newPaths.map((path) => ({ id: ids.get(path) ?? `p/${path}`, path }));
	return { table: { cwd: table.cwd, entries: [...table.entries, ...inserted] }, inserted };
}

export function buildPathAliasTable(cwd: string, texts: readonly string[]): PathAliasTable {
	const byKey = new Map<string, string>();
	const uniquePaths: string[] = [];
	for (const text of texts) {
		for (const candidate of extractPathCandidates(text)) {
			const path = displayPath(candidate, cwd);
			const key = path.toLowerCase();
			if (byKey.has(key)) continue;
			byKey.set(key, path);
			uniquePaths.push(path);
		}
	}
	const ids = shortestUniqueSuffixes(uniquePaths);
	return {
		cwd,
		entries: uniquePaths.map((path) => ({ id: ids.get(path) ?? `p/${path}`, path })),
	};
}

export function formatPathAliasLegend(table: PathAliasTable): string | undefined {
	if (table.entries.length === 0) return undefined;
	const lines = ["PATH ALIASES", ...table.entries.map((entry) => `${entry.id}=${entry.path}`)];
	return lines.join("\n");
}

export function rewriteText(table: PathAliasTable, text: string): string {
	if (table.entries.length === 0) return text;
	const ordered = [...table.entries].sort((left, right) => right.path.length - left.path.length);
	let next = text;
	for (const entry of ordered) {
		if (!next.includes(entry.path)) {
			const windows = entry.path.replaceAll("/", "\\");
			if (windows !== entry.path && next.includes(windows)) {
				next = next.split(windows).join(entry.id);
			}
			continue;
		}
		next = next.split(entry.path).join(entry.id);
	}
	return next;
}

export function expandText(table: PathAliasTable, text: string): string {
	if (table.entries.length === 0) return text;
	const byId = new Map(table.entries.map((entry) => [entry.id, entry.path]));
	return text.replace(PATH_ALIAS_TOKEN_RE, (token) => byId.get(token) ?? token);
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
	return {
		table,
		messages: rewriteAgentMessages(messages, table),
		legend: formatPathAliasLegend(table),
	};
}
