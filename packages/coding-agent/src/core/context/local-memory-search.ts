import type { MemoryItem, MemoryRef, MemorySearchRequest, MemorySearchResult } from "./memory-provider-contract.ts";

export interface LocalMemorySearchStrategy {
	score: (queryTokens: ReadonlySet<string>, item: MemoryItem) => number;
	reason: (score: number, item: MemoryItem) => string;
}

export function tokenizeMemorySearch(text: string): Set<string> {
	return new Set(text.toLowerCase().match(/[a-z0-9_/-]+/g) ?? []);
}

export function tokenOverlapScore(queryTokens: ReadonlySet<string>, textParts: Array<string | undefined>): number {
	if (queryTokens.size === 0) return 0;
	const haystack = tokenizeMemorySearch(textParts.filter((part): part is string => part !== undefined).join("\n"));
	let overlap = 0;
	for (const token of queryTokens) {
		if (haystack.has(token)) overlap++;
	}
	return overlap / queryTokens.size;
}

export function matchesMemorySearchRequest(item: MemoryItem, request: MemorySearchRequest): boolean {
	if (request.scope !== undefined && item.scope !== request.scope) return false;
	if (request.kinds !== undefined && !request.kinds.includes(item.kind)) return false;
	return true;
}

export function searchLocalMemoryItems(
	items: readonly MemoryItem[],
	request: MemorySearchRequest,
	strategy: LocalMemorySearchStrategy,
): MemorySearchResult[] {
	const queryTokens = tokenizeMemorySearch(request.query);
	return items
		.filter((item) => matchesMemorySearchRequest(item, request))
		.map((item) => ({ item, score: strategy.score(queryTokens, item) }))
		.filter((result) => result.score > 0)
		.sort((left, right) => right.score - left.score || left.item.id.localeCompare(right.item.id))
		.slice(0, request.maxResults)
		.map((result) => ({ ...result, reason: strategy.reason(result.score, result.item) }));
}

export function fetchLocalMemoryItem(
	items: readonly MemoryItem[],
	providerId: string,
	ref: MemoryRef,
): MemoryItem | undefined {
	if (ref.providerId !== providerId) return undefined;
	return items.find((item) => item.id === ref.itemId && item.scope === ref.scope && item.kind === ref.kind);
}
