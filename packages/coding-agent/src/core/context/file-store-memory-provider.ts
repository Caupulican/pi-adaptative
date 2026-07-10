import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { scanContextFileThreats, stripInvisibleUnicode } from "../resource-loader.ts";
import type { MemoryScope } from "./context-item.ts";
import type {
	MemoryItem,
	MemoryItemKind,
	MemoryProvider,
	MemoryProviderCapabilities,
	MemoryRef,
	MemorySearchRequest,
	MemorySearchResult,
} from "./memory-provider-contract.ts";

export const PI_FILE_STORE_MEMORY_PROVIDER_ID = "pi-file-store";

export interface FileStoreMemoryProviderOptions {
	memoryFilePath: string;
	userFilePath: string;
	providerId?: string;
}

interface FileStoreLineSource {
	path: string;
	fileName: "MEMORY.md" | "USER.md";
	scope: MemoryScope;
	kind: MemoryItemKind;
}

const FILE_STORE_MEMORY_CAPABILITIES: MemoryProviderCapabilities = {
	search: true,
	fetch: true,
	write: false,
	delete: false,
	shortTerm: false,
	longTerm: true,
	graph: false,
	citations: true,
	scopes: ["user", "global"],
	localOnly: true,
};

function tokenSet(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z0-9_/-]+/g) ?? []);
}

function scoreItem(queryTokens: Set<string>, item: MemoryItem): number {
	if (queryTokens.size === 0) return item.kind === "user_preference" ? 0.2 : 0;
	const haystack = tokenSet(
		[item.title, item.summary].filter((part): part is string => part !== undefined).join("\n"),
	);
	let overlap = 0;
	for (const token of queryTokens) {
		if (haystack.has(token)) overlap++;
	}
	const score = overlap / queryTokens.size;
	// USER.md lines are standing preferences. When file-store retrieval is used as a compact-window
	// fallback for the static prompt, keep them eligible even if the latest query has no token overlap.
	return item.kind === "user_preference" ? Math.max(0.2, Math.min(1, score + 0.05)) : score;
}

function matchesRequest(item: MemoryItem, request: MemorySearchRequest): boolean {
	if (request.scope !== undefined && item.scope !== request.scope) return false;
	if (request.kinds !== undefined && !request.kinds.includes(item.kind)) return false;
	return true;
}

function refFor(providerId: string, source: FileStoreLineSource, lineNumber: number, kind: MemoryItemKind): MemoryRef {
	return {
		providerId,
		itemId: `${source.fileName}:line-${lineNumber}`,
		scope: source.scope,
		kind,
		uri: `file-store:${source.fileName}#line-${lineNumber}`,
	};
}

function readLines(source: FileStoreLineSource, providerId: string): MemoryItem[] {
	if (!existsSync(source.path)) return [];
	const cleaned = stripInvisibleUnicode(readFileSync(source.path, "utf8")).cleaned;
	return cleaned
		.split("\n")
		.map((rawLine, index) => ({ text: rawLine.trim(), lineNumber: index + 1 }))
		.filter((line) => line.text.length > 0 && !line.text.startsWith("#"))
		.filter((line) => scanContextFileThreats(line.text).length === 0)
		.map((line) => {
			const ref = refFor(providerId, source, line.lineNumber, source.kind);
			return {
				id: ref.itemId,
				providerId,
				source: "pi_native" as const,
				kind: source.kind,
				scope: source.scope,
				durability: "durable" as const,
				title: `${basename(source.path)} line ${line.lineNumber}`,
				summary: line.text,
				refs: [ref],
				evidenceRefs: [{ type: "memory" as const, ref }],
			};
		});
}

export function createFileStoreMemoryProvider(options: FileStoreMemoryProviderOptions): MemoryProvider {
	const providerId = options.providerId ?? PI_FILE_STORE_MEMORY_PROVIDER_ID;
	const sources: FileStoreLineSource[] = [
		{ path: options.userFilePath, fileName: "USER.md", scope: "user", kind: "user_preference" },
		{ path: options.memoryFilePath, fileName: "MEMORY.md", scope: "global", kind: "fact" },
	];

	function items(): MemoryItem[] {
		return sources.flatMap((source) => readLines(source, providerId));
	}

	return {
		id: providerId,
		label: "Pi File-Store Memory",
		source: "pi_native",
		capabilities: FILE_STORE_MEMORY_CAPABILITIES,
		async search(request: MemorySearchRequest): Promise<MemorySearchResult[]> {
			const queryTokens = tokenSet(request.query);
			return items()
				.filter((item) => matchesRequest(item, request))
				.map((item) => ({ item, score: scoreItem(queryTokens, item) }))
				.filter((result) => result.score > 0)
				.sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
				.slice(0, request.maxResults)
				.map((result) => ({ ...result, reason: `file-store line match score ${result.score.toFixed(3)}` }));
		},
		async fetch(ref: MemoryRef): Promise<MemoryItem | undefined> {
			if (ref.providerId !== providerId) return undefined;
			return items().find((item) => item.id === ref.itemId && item.scope === ref.scope && item.kind === ref.kind);
		},
	};
}
