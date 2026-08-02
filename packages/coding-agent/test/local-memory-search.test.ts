import { describe, expect, it } from "vitest";
import {
	fetchLocalMemoryItem,
	matchesMemorySearchRequest,
	searchLocalMemoryItems,
	tokenizeMemorySearch,
} from "../src/core/context/local-memory-search.ts";
import type { MemoryItem, MemorySearchRequest } from "../src/core/context/memory-provider-contract.ts";

function item(id: string, scope: MemoryItem["scope"], kind: MemoryItem["kind"]): MemoryItem {
	return {
		id,
		providerId: "local",
		source: "pi_native",
		kind,
		scope,
		durability: "durable",
		summary: id,
		refs: [{ providerId: "local", itemId: id, scope, kind }],
		evidenceRefs: [],
	};
}

describe("local memory search", () => {
	it("normalizes tokens and applies scope and kind constraints", () => {
		expect([...tokenizeMemorySearch("Alpha/beta ALPHA")]).toEqual(["alpha/beta", "alpha"]);
		const request: MemorySearchRequest = {
			query: "alpha",
			scope: "project",
			kinds: ["fact"],
			maxResults: 2,
		};
		expect(matchesMemorySearchRequest(item("a", "project", "fact"), request)).toBe(true);
		expect(matchesMemorySearchRequest(item("b", "user", "fact"), request)).toBe(false);
		expect(matchesMemorySearchRequest(item("c", "project", "procedure"), request)).toBe(false);
	});

	it("owns filtering, stable ranking, caps, reasons, and exact ref fetch", () => {
		const items = [item("b", "project", "fact"), item("a", "project", "fact"), item("c", "user", "fact")];
		const request: MemorySearchRequest = { query: "query", scope: "project", maxResults: 1 };
		const results = searchLocalMemoryItems(items, request, {
			score: () => 0.5,
			reason: (score, value) => `${value.id}:${score}`,
		});
		expect(results.map((result) => [result.item.id, result.reason])).toEqual([["a", "a:0.5"]]);

		const ref = items[0]?.refs[0];
		if (!ref) throw new Error("expected memory ref");
		expect(fetchLocalMemoryItem(items, "local", ref)?.id).toBe("b");
		expect(fetchLocalMemoryItem(items, "other", ref)).toBeUndefined();
	});
});
