import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { MemoryScope } from "./context-item.ts";
import { fetchLocalMemoryItem, searchLocalMemoryItems, tokenOverlapScore } from "./local-memory-search.ts";
import type {
	MemoryItem,
	MemoryProvider,
	MemoryProviderCapabilities,
	MemoryRef,
	MemorySearchRequest,
	MemorySearchResult,
} from "./memory-provider-contract.ts";

export const LOCAL_GRAPH_PROVIDER_ID = "pi_local_graph";

const LOCAL_GRAPH_CAPABILITIES: MemoryProviderCapabilities = {
	search: true,
	fetch: true,
	write: false,
	delete: false,
	shortTerm: false,
	longTerm: true,
	graph: true,
	citations: true,
	scopes: ["project"],
	localOnly: true,
};

const MAX_GRAPH_FILE_BYTES = 8 * 1024 * 1024;
const MAX_GRAPH_NODES = 2_000;

export function resolveLocalGraphPath(cwd: string, agentDir: string): string | undefined {
	const candidates = [
		join(cwd, "graph.json"),
		join(cwd, "graph-out", "graph.json"),
		join(cwd, "graphify-out", "graph.json"),
		join(agentDir, "graph-memory", "graph.json"),
	];
	return candidates.find((path) => existsSync(path));
}

interface CachedGraph {
	mtimeMs: number;
	items: MemoryItem[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function parseGraphItems(path: string): MemoryItem[] {
	let raw: string;
	try {
		if (statSync(path).size > MAX_GRAPH_FILE_BYTES) return [];
		raw = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return [];
	}
	const root = asRecord(parsed);
	const nodes = Array.isArray(root?.nodes) ? root.nodes : Array.isArray(parsed) ? parsed : [];
	const items: MemoryItem[] = [];
	for (const entry of nodes) {
		if (items.length >= MAX_GRAPH_NODES) break;
		const node = asRecord(entry);
		if (!node) continue;
		const id = readString(node.id) ?? readString(node.name);
		if (!id) continue;
		const title = readString(node.label) ?? readString(node.title) ?? readString(node.name) ?? id;
		const summary = readString(node.summary) ?? readString(node.text) ?? readString(node.description) ?? title;
		const source = readString(node.source_location) ?? readString(node.source) ?? path;
		items.push({
			id,
			providerId: LOCAL_GRAPH_PROVIDER_ID,
			source: "pi_native",
			kind: "architecture_concept",
			scope: "project" satisfies MemoryScope,
			durability: "durable",
			title,
			summary: summary.slice(0, 500),
			refs: [{ providerId: LOCAL_GRAPH_PROVIDER_ID, itemId: id, scope: "project", kind: "architecture_concept" }],
			evidenceRefs: [{ type: "runtime", id: source, description: title }],
			confidence: "medium",
		});
	}
	return items;
}

function scoreItem(queryTokens: ReadonlySet<string>, item: MemoryItem): number {
	return tokenOverlapScore(queryTokens, [item.title, item.summary, item.id]);
}

function reasonForMatch(score: number, item: MemoryItem): string {
	return `local graph match score ${score.toFixed(3)} for ${item.id}`;
}

/** Read-only retrieval over a local durable graph when one is present on disk. */
export function createLocalGraphMemoryProvider(options: { cwd: string; agentDir: string }): MemoryProvider | undefined {
	const resolvedPath = resolveLocalGraphPath(options.cwd, options.agentDir);
	if (resolvedPath === undefined) return undefined;
	const graphPath: string = resolvedPath;
	let cache: CachedGraph | undefined;

	function items(): MemoryItem[] {
		let mtimeMs = 0;
		try {
			mtimeMs = statSync(graphPath).mtimeMs;
		} catch {
			return [];
		}
		if (cache && cache.mtimeMs === mtimeMs) return cache.items;
		const next = parseGraphItems(graphPath);
		cache = { mtimeMs, items: next };
		return next;
	}

	return {
		id: LOCAL_GRAPH_PROVIDER_ID,
		label: "Local graph memory",
		source: "pi_native",
		capabilities: LOCAL_GRAPH_CAPABILITIES,
		async search(request: MemorySearchRequest): Promise<MemorySearchResult[]> {
			return searchLocalMemoryItems(items(), request, { score: scoreItem, reason: reasonForMatch });
		},
		async fetch(ref: MemoryRef): Promise<MemoryItem | undefined> {
			return fetchLocalMemoryItem(items(), LOCAL_GRAPH_PROVIDER_ID, ref);
		},
	};
}
