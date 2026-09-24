import { describe, expect, it } from "vitest";
import { CacheCustody } from "../src/core/context/cache-custody.ts";

describe("cache custody", () => {
	describe("guard", () => {
		it("classifies the lane's first request, then appends", () => {
			const custody = new CacheCustody();
			expect(custody.classify({ lane: "a", prefixIntact: "unknown", reasoning: "high" })).toEqual({
				classification: "first",
			});
			expect(custody.classify({ lane: "a", prefixIntact: true, reasoning: "high" })).toEqual({
				classification: "append",
			});
		});

		it("reports a rewrite nobody sanctioned at its kind and index", () => {
			const custody = new CacheCustody();
			custody.classify({ lane: "a", prefixIntact: "unknown" });
			expect(
				custody.classify({
					lane: "a",
					prefixIntact: false,
					firstDivergentKind: "toolResult",
					firstDivergentIndex: 3,
				}),
			).toEqual({ classification: "unsanctioned", kind: "toolResult", index: 3 });
		});

		it("reports a reasoning-only change as an unsanctioned reasoning break", () => {
			const custody = new CacheCustody();
			custody.classify({ lane: "a", prefixIntact: "unknown", reasoning: "high" });
			expect(custody.classify({ lane: "a", prefixIntact: true, reasoning: "low" })).toEqual({
				classification: "unsanctioned",
				kind: "reasoning",
				index: -1,
			});
		});

		it("sanctions the next break on the token's lane once, and a lane-free token on any lane", () => {
			const custody = new CacheCustody();
			custody.classify({ lane: "a", prefixIntact: "unknown" });
			custody.classify({ lane: "b", prefixIntact: "unknown" });
			custody.sanction("gc_pack", "priced", { lane: "a" });
			expect(custody.classify({ lane: "a", prefixIntact: false })).toEqual({
				classification: "sanctioned",
				kind: "gc_pack",
				reason: "priced",
			});
			// A token is for its conversation's next request: a request on another lane consumes it.
			custody.sanction("side_trip_brief", "brief", { lane: "a" });
			expect(custody.classify({ lane: "b", prefixIntact: false, firstDivergentKind: "user" })).toMatchObject({
				classification: "unsanctioned",
			});
			expect(custody.classify({ lane: "a", prefixIntact: false })).toMatchObject({ classification: "unsanctioned" });
			custody.sanction("compaction", "history replaced");
			expect(custody.classify({ lane: "b", prefixIntact: false })).toMatchObject({
				classification: "sanctioned",
				kind: "compaction",
			});
		});
	});

	describe("conversations", () => {
		it("keeps each conversation's tokens and reasoning pins its own", () => {
			const custody = new CacheCustody();
			custody.classify({ lane: "m", prefixIntact: "unknown" });
			custody.classify({ conversation: "s/worker:w", lane: "m", prefixIntact: "unknown" });
			custody.sanction("gc_pack", "worker pack", { conversation: "s/worker:w", lane: "m" });
			// The session's own request does not consume the worker's token.
			expect(custody.classify({ lane: "m", prefixIntact: true })).toEqual({ classification: "append" });
			expect(custody.classify({ conversation: "s/worker:w", lane: "m", prefixIntact: false })).toMatchObject({
				classification: "sanctioned",
				kind: "gc_pack",
			});
			expect(custody.admitReasoning(undefined, "m", "high", "high", () => false)).toBe("high");
			expect(custody.admitReasoning("s/worker:w", "m", "low", "low", () => false)).toBe("low");
			expect(custody.admitReasoning(undefined, "m", "high", "low", () => false)).toBe("high");
		});

		it("sanctions a worker's free reasoning change on the worker's own guard", () => {
			const custody = new CacheCustody();
			custody.admitReasoning("s/worker:w", "m", "high", "high", () => false);
			custody.classify({ conversation: "s/worker:w", lane: "m", prefixIntact: "unknown", reasoning: "high" });
			expect(custody.admitReasoning("s/worker:w", "m", "high", "low", () => true)).toBe("low");
			expect(
				custody.classify({ conversation: "s/worker:w", lane: "m", prefixIntact: true, reasoning: "low" }),
			).toMatchObject({ classification: "sanctioned", kind: "reasoning" });
		});
	});

	describe("gate", () => {
		it("applies mandatory and admitted changes at once and defers the rest to a cold moment", () => {
			const custody = new CacheCustody();
			const applied: string[] = [];
			expect(
				custody.request({ kind: "owner", reason: "r", mandatory: true, apply: () => applied.push("owner") }),
			).toBe("applied");
			expect(custody.request({ kind: "tools", reason: "r", apply: () => applied.push("tools") })).toBe("deferred");
			expect(applied).toEqual(["owner"]);
			expect(custody.deferredCount).toBe(1);
			expect(custody.flushColdMoment("compaction")).toEqual(["tools"]);
			expect(applied).toEqual(["owner", "tools"]);
			expect(custody.deferredCount).toBe(0);
			// A token is good for the next request only: the lane's first request consumes the earlier ones.
			custody.classify({ lane: "a", prefixIntact: "unknown" });
			custody.request({ kind: "later", reason: "r", apply: () => {} });
			custody.flushColdMoment("idle");
			expect(custody.classify({ lane: "a", prefixIntact: false })).toMatchObject({
				classification: "sanctioned",
				kind: "later",
			});
		});
	});

	describe("queue", () => {
		it("keeps one waiting change per kind, the latest, and withdraws one no longer wanted", () => {
			const custody = new CacheCustody();
			const applied: string[] = [];
			custody.request({ kind: "extension_system_prompt", reason: "r", apply: () => applied.push("p1") });
			custody.request({ kind: "extension_system_prompt", reason: "r", apply: () => applied.push("p2") });
			expect(custody.deferredCount).toBe(1);
			custody.flushColdMoment("idle");
			expect(applied).toEqual(["p2"]);

			custody.request({ kind: "extension_system_prompt", reason: "r", apply: () => applied.push("p3") });
			custody.withdraw("extension_system_prompt");
			expect(custody.flushColdMoment("idle")).toEqual([]);
			expect(applied).toEqual(["p2"]);
		});
	});

	describe("reasoning", () => {
		it("keeps the lane's sent level against a host adjustment while the cache is warm", () => {
			const custody = new CacheCustody();
			expect(custody.admitReasoning(undefined, "a", "high", "high", () => false)).toBe("high");
			expect(custody.admitReasoning(undefined, "a", "high", "low", () => false)).toBe("high");
		});

		it("passes a host adjustment when the lane's cache is already gone, sanctioned", () => {
			const custody = new CacheCustody();
			custody.admitReasoning(undefined, "a", "high", "high", () => false);
			custody.classify({ lane: "a", prefixIntact: "unknown", reasoning: "high" });
			expect(custody.admitReasoning(undefined, "a", "high", "low", () => true)).toBe("low");
			expect(custody.classify({ lane: "a", prefixIntact: true, reasoning: "low" })).toMatchObject({
				classification: "sanctioned",
				kind: "reasoning",
			});
		});

		it("passes the owner's own change and a return to the owner's level", () => {
			const custody = new CacheCustody();
			// The lane's first request was a host turn below the owner's level.
			expect(custody.admitReasoning(undefined, "a", "high", "medium", () => false)).toBe("medium");
			expect(custody.admitReasoning(undefined, "a", "high", "high", () => false)).toBe("high");
			expect(custody.admitReasoning(undefined, "a", "low", "low", () => false)).toBe("low");
		});

		it("records a mandatory override as what the lane last sent", () => {
			const custody = new CacheCustody();
			custody.admitReasoning(undefined, "a", "high", "high", () => false);
			custody.overrideReasoning(undefined, "a", "medium", "cost ceiling");
			expect(custody.admitReasoning(undefined, "a", "high", "low", () => false)).toBe("medium");
		});
	});
});
