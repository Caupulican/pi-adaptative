import { existsSync } from "node:fs";
import { basename } from "node:path";
import { scanContextFileThreats, stripInvisibleUnicode } from "../security/context-threat-scanner.ts";
import { readBoundedTextFileSync } from "../util/bounded-file.ts";
import type { MemoryScope } from "./context-item.ts";
import { fetchLocalMemoryItem, searchLocalMemoryItems, tokenOverlapScore } from "./local-memory-search.ts";
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

const MAX_FILE_READ_BYTES = 512_000;

export interface FileStoreMemoryProviderOptions {
	memoryFilePath: string;
	userFilePath: string;
	/** This project's MEMORY.md; searched with scope "project" when present. */
	projectMemoryFilePath?: string;
	providerId?: string;
	/** Trimmed MEMORY.md lines from the installed frozen static prompt block; used to exclude already-present lines from retrieval. */
	frozenPromptLines?: ReadonlySet<string>;
	/** True when the compact fallback is active (static block fully omitted). */
	compact?: boolean;
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
	scopes: ["user", "global", "project"],
	localOnly: true,
};

function scoreItem(queryTokens: ReadonlySet<string>, item: MemoryItem): number {
	if (queryTokens.size === 0) return item.kind === "user_preference" ? 0.2 : 0;
	const score = tokenOverlapScore(queryTokens, [item.title, item.summary]);
	return item.kind === "user_preference" ? Math.max(0.2, Math.min(1, score + 0.05)) : score;
}

function refFor(providerId: string, source: FileStoreLineSource, lineNumber: number, kind: MemoryItemKind): MemoryRef {
	const name = source.scope === "project" ? `project/${source.fileName}` : source.fileName;
	return {
		providerId,
		itemId: `${name}:line-${lineNumber}`,
		scope: source.scope,
		kind,
		uri: `file-store:${name}#line-${lineNumber}`,
	};
}

function readLines(source: FileStoreLineSource, providerId: string): MemoryItem[] {
	if (!existsSync(source.path)) return [];
	let content: string;
	try {
		content = readBoundedTextFileSync(source.path, MAX_FILE_READ_BYTES, source.path);
	} catch {
		return [];
	}
	const cleaned = stripInvisibleUnicode(content).cleaned;
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
	const frozenLines = options.frozenPromptLines;
	const compact = options.compact ?? true;

	const sources: FileStoreLineSource[] = [
		...(compact
			? [
					{
						path: options.userFilePath,
						fileName: "USER.md" as const,
						scope: "user" as const,
						kind: "user_preference" as const,
					},
				]
			: []),
		{ path: options.memoryFilePath, fileName: "MEMORY.md", scope: "global", kind: "fact" },
		...(options.projectMemoryFilePath
			? [
					{
						path: options.projectMemoryFilePath,
						fileName: "MEMORY.md" as const,
						scope: "project" as const,
						kind: "fact" as const,
					},
				]
			: []),
	];

	function items(selected: readonly FileStoreLineSource[] = sources): MemoryItem[] {
		return selected.flatMap((source) => readLines(source, providerId));
	}

	function shouldIncludeItem(item: MemoryItem): boolean {
		if (!compact && item.kind === "user_preference") return false;
		if (!compact && frozenLines && frozenLines.has(item.summary)) return false;
		return true;
	}

	return {
		id: providerId,
		label: "Pi File-Store Memory",
		source: "pi_native",
		capabilities: FILE_STORE_MEMORY_CAPABILITIES,
		async search(request: MemorySearchRequest): Promise<MemorySearchResult[]> {
			const allItems = items().filter(shouldIncludeItem);
			return searchLocalMemoryItems(allItems, request, {
				score: (tokens, item) => scoreItem(tokens, item),
				reason: (score) => `file-store line match score ${score.toFixed(3)}`,
			});
		},
		async fetch(ref: MemoryRef): Promise<MemoryItem | undefined> {
			if (ref.providerId !== providerId) return undefined;
			const allItems = items(sources.filter((source) => source.scope === ref.scope && source.kind === ref.kind));
			return fetchLocalMemoryItem(allItems, providerId, ref);
		},
	};
}
