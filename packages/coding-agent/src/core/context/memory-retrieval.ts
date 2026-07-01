import type { ContextItem, ContextMemoryRef } from "./context-item.ts";
import type { MemoryIndexRecord, MemoryIndexStore } from "./memory-index-store.ts";
import {
	DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
	DEFAULT_LOCAL_MEMORY_EGRESS_POLICY,
	type MemoryEgressPolicy,
	type MemoryItem,
	type MemoryPolicyRejectionReason,
	type MemoryProvider,
	type MemorySearchRequest,
	type MemorySearchResult,
	memorySearchResultToContextItem,
	validateMemorySearchRequest,
} from "./memory-provider-contract.ts";

export type MemoryProviderRetrievalStatus = "queried" | "blocked" | "failed";

export interface MemoryProviderRetrievalReport {
	providerId: string;
	status: MemoryProviderRetrievalStatus;
	rejectionReasons: MemoryPolicyRejectionReason[];
	resultCount: number;
	error?: string;
}

export interface MemoryRetrievalOptions {
	createdAtTurn: number;
	maxResults: number;
	memoryIndexStore?: MemoryIndexStore;
	policiesByProviderId?: Readonly<Record<string, MemoryEgressPolicy>>;
	defaultLocalPolicy?: MemoryEgressPolicy;
	defaultExternalPolicy?: MemoryEgressPolicy;
}

export interface MemoryRetrievalReport {
	request: MemorySearchRequest;
	providerReports: MemoryProviderRetrievalReport[];
	results: MemorySearchResult[];
	contextItems: ContextItem[];
}

function defaultPolicyForProvider(provider: MemoryProvider, options: MemoryRetrievalOptions): MemoryEgressPolicy {
	if (options.policiesByProviderId?.[provider.id] !== undefined) return options.policiesByProviderId[provider.id];
	if (provider.capabilities.localOnly) return options.defaultLocalPolicy ?? DEFAULT_LOCAL_MEMORY_EGRESS_POLICY;
	return options.defaultExternalPolicy ?? DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY;
}

function resultKey(result: MemorySearchResult): string {
	return `${result.item.providerId}\0${result.item.id}`;
}

function fallbackRefForItem(item: MemoryItem): ContextMemoryRef {
	return {
		providerId: item.providerId,
		itemId: item.id,
		scope: item.scope,
		kind: item.kind,
	};
}

function memoryIndexRecordForResult(result: MemorySearchResult, indexedAtTurn: number): MemoryIndexRecord {
	const item = result.item;
	return {
		ref: item.refs[0] ?? fallbackRefForItem(item),
		title: item.title,
		summary: item.summary,
		indexedAtTurn,
		stale: item.stale ?? false,
	};
}

function sortResults(results: MemorySearchResult[]): MemorySearchResult[] {
	return results
		.slice()
		.sort((left, right) => right.score - left.score || resultKey(left).localeCompare(resultKey(right)));
}

function dedupeResults(results: MemorySearchResult[]): MemorySearchResult[] {
	const bestByKey = new Map<string, MemorySearchResult>();
	for (const result of results) {
		const key = resultKey(result);
		const existing = bestByKey.get(key);
		if (existing === undefined || result.score > existing.score) bestByKey.set(key, result);
	}
	return sortResults(Array.from(bestByKey.values()));
}

export async function retrieveMemoryForContext(
	providers: readonly MemoryProvider[],
	request: MemorySearchRequest,
	options: MemoryRetrievalOptions,
): Promise<MemoryRetrievalReport> {
	const providerReports: MemoryProviderRetrievalReport[] = [];
	const collected: MemorySearchResult[] = [];

	for (const provider of providers) {
		const policy = defaultPolicyForProvider(provider, options);
		const rejectionReasons = validateMemorySearchRequest(provider, policy, request);
		if (rejectionReasons.length > 0) {
			providerReports.push({
				providerId: provider.id,
				status: "blocked",
				rejectionReasons,
				resultCount: 0,
			});
			continue;
		}

		try {
			const results = await provider.search(request);
			collected.push(...results);
			providerReports.push({
				providerId: provider.id,
				status: "queried",
				rejectionReasons: [],
				resultCount: results.length,
			});
		} catch (error) {
			providerReports.push({
				providerId: provider.id,
				status: "failed",
				rejectionReasons: [],
				resultCount: 0,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	const results = dedupeResults(collected).slice(0, options.maxResults);
	for (const result of results) {
		options.memoryIndexStore?.upsert(memoryIndexRecordForResult(result, options.createdAtTurn));
	}

	return {
		request,
		providerReports,
		results,
		contextItems: results.map((result) => memorySearchResultToContextItem(result, options.createdAtTurn)),
	};
}
