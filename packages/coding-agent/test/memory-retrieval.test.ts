import { describe, expect, it } from "vitest";
import { createInMemoryMemoryIndexStore } from "../src/core/context/memory-index-store.ts";
import {
	DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
	type MemoryItem,
	type MemoryProvider,
	type MemoryProviderSource,
	type MemorySearchRequest,
	type MemorySearchResult,
} from "../src/core/context/memory-provider-contract.ts";
import { retrieveMemoryForContext } from "../src/core/context/memory-retrieval.ts";

interface MockProviderOptions {
	id: string;
	source: MemoryProviderSource;
	localOnly: boolean;
	results?: MemorySearchResult[];
	throwError?: Error;
	searchable?: boolean;
}

function memoryItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
	return {
		id: "memory-1",
		providerId: "pi-okf",
		source: "pi_native",
		kind: "design_decision",
		scope: "project",
		durability: "durable",
		title: "Artifact-backed output",
		summary: "Large grep/find output is artifact-backed before prompt stubbing.",
		content: "Detailed OKF body that should not be directly promoted to instruction authority.",
		refs: [{ providerId: "pi-okf", itemId: "memory-1", scope: "project", kind: "design_decision" }],
		evidenceRefs: [{ type: "external", id: "transcript:review-1", providerId: "pi-okf" }],
		...overrides,
	};
}

function mockProvider(options: MockProviderOptions): MemoryProvider & { calls: MemorySearchRequest[] } {
	const calls: MemorySearchRequest[] = [];
	return {
		id: options.id,
		label: options.id,
		source: options.source,
		capabilities: {
			search: options.searchable ?? true,
			fetch: true,
			write: false,
			delete: false,
			shortTerm: false,
			longTerm: true,
			graph: false,
			citations: true,
			scopes: ["project", "user"],
			localOnly: options.localOnly,
		},
		calls,
		async search(request: MemorySearchRequest): Promise<MemorySearchResult[]> {
			calls.push(request);
			if (options.throwError) throw options.throwError;
			return options.results ?? [];
		},
		async fetch(): Promise<MemoryItem | undefined> {
			return undefined;
		},
	};
}

describe("memory retrieval fusion", () => {
	it("queries local providers, indexes selected results, and emits source-labeled context items", async () => {
		const store = createInMemoryMemoryIndexStore();
		const provider = mockProvider({
			id: "pi-okf",
			source: "pi_native",
			localOnly: true,
			results: [{ item: memoryItem(), score: 0.9, reason: "matched artifact output" }],
		});

		const report = await retrieveMemoryForContext(
			[provider],
			{ query: "artifact output", scope: "project", maxResults: 5 },
			{ createdAtTurn: 7, maxResults: 3, memoryIndexStore: store },
		);

		expect(provider.calls).toHaveLength(1);
		expect(report.providerReports).toEqual([
			{ providerId: "pi-okf", status: "queried", rejectionReasons: [], resultCount: 1 },
		]);
		expect(report.results).toHaveLength(1);
		expect(report.contextItems[0]).toMatchObject({
			id: "memory:pi-okf:memory-1",
			kind: "memory_item",
			retentionClass: "useful",
			source: "memory",
			createdAtTurn: 7,
		});
		expect(report.contextItems[0]?.summary).toContain("[pi-okf/project/design_decision]");
		expect(store.get("pi-okf", "memory-1")).toEqual({
			ref: { providerId: "pi-okf", itemId: "memory-1", scope: "project", kind: "design_decision" },
			title: "Artifact-backed output",
			summary: "Large grep/find output is artifact-backed before prompt stubbing.",
			indexedAtTurn: 7,
			stale: false,
		});
	});

	it("blocks external providers by default and never calls their search method", async () => {
		const external = mockProvider({
			id: "custom-external",
			source: "external_provider",
			localOnly: false,
			results: [
				{
					item: memoryItem({ providerId: "custom-external", source: "external_provider" }),
					score: 1,
					reason: "match",
				},
			],
		});

		const report = await retrieveMemoryForContext(
			[external],
			{ query: "artifact output", scope: "project", maxResults: 5 },
			{ createdAtTurn: 8, maxResults: 3 },
		);

		expect(external.calls).toEqual([]);
		expect(report.results).toEqual([]);
		expect(report.providerReports[0]).toMatchObject({
			providerId: "custom-external",
			status: "blocked",
			resultCount: 0,
		});
		expect(report.providerReports[0]?.rejectionReasons).toContain("provider_disabled");
		expect(report.providerReports[0]?.rejectionReasons).toContain("external_egress_blocked");
	});

	it("continues after one provider fails", async () => {
		const failing = mockProvider({
			id: "broken-local",
			source: "custom_local",
			localOnly: true,
			throwError: new Error("boom"),
		});
		const working = mockProvider({
			id: "pi-okf",
			source: "pi_native",
			localOnly: true,
			results: [{ item: memoryItem(), score: 0.7, reason: "matched" }],
		});

		const report = await retrieveMemoryForContext(
			[failing, working],
			{ query: "artifact", scope: "project", maxResults: 5 },
			{ createdAtTurn: 9, maxResults: 5 },
		);

		expect(report.providerReports).toMatchObject([
			{ providerId: "broken-local", status: "failed", resultCount: 0, error: "boom" },
			{ providerId: "pi-okf", status: "queried", resultCount: 1 },
		]);
		expect(report.results).toHaveLength(1);
	});

	it("dedupes by provider/item id, keeps the best score, and applies the global cap", async () => {
		const duplicateLow = { item: memoryItem({ id: "same" }), score: 0.2, reason: "low" };
		const duplicateHigh = { item: memoryItem({ id: "same" }), score: 0.9, reason: "high" };
		const second = { item: memoryItem({ id: "second", title: "Second" }), score: 0.8, reason: "second" };
		const provider = mockProvider({
			id: "pi-okf",
			source: "pi_native",
			localOnly: true,
			results: [duplicateLow, second, duplicateHigh],
		});

		const report = await retrieveMemoryForContext(
			[provider],
			{ query: "artifact", scope: "project", maxResults: 10 },
			{ createdAtTurn: 10, maxResults: 1 },
		);

		expect(report.results).toEqual([duplicateHigh]);
		expect(report.contextItems).toHaveLength(1);
	});

	it("uses explicit provider policies to allow external egress", async () => {
		const externalItem = memoryItem({
			id: "external-1",
			providerId: "custom-external",
			source: "external_provider",
			refs: [{ providerId: "custom-external", itemId: "external-1", scope: "project", kind: "reference" }],
			kind: "reference",
		});
		const external = mockProvider({
			id: "custom-external",
			source: "external_provider",
			localOnly: false,
			results: [{ item: externalItem, score: 0.6, reason: "external approved" }],
		});

		const report = await retrieveMemoryForContext(
			[external],
			{ query: "artifact", scope: "project", maxResults: 5 },
			{
				createdAtTurn: 11,
				maxResults: 5,
				policiesByProviderId: {
					"custom-external": {
						...DEFAULT_EXTERNAL_MEMORY_EGRESS_POLICY,
						enabled: true,
						allowExternalEgress: true,
						allowedScopes: ["project"],
					},
				},
			},
		);

		expect(external.calls).toHaveLength(1);
		expect(report.results).toHaveLength(1);
		expect(report.contextItems[0]).toMatchObject({ source: "external_provider", retentionClass: "useful" });
	});
});
