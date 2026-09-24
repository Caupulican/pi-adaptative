import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { priceSentPrefixRewrite } from "../src/core/compaction/early-compaction-economics.ts";
import { lineageRemainingRequests } from "../src/core/context/cache-survival.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";

// deepseek-v4-flash catalog prices (USD per million): cold 0.088606, cache read 0.0177212.
const PRICES = { cacheReadUsdPerMillion: 0.0177212, coldUsdPerMillion: 0.088606 };

/** Every ledger a test opens, closed before its directory is removed (Windows cannot delete an open database). */
const ledgers: DecisionLedgerStore[] = [];
function openLedger(databasePath: string): DecisionLedgerStore {
	const ledger = new DecisionLedgerStore({ databasePath });
	ledgers.push(ledger);
	return ledger;
}

describe("sent-prefix rewrite price", () => {
	it("admits a batch whose saving over the remaining requests pays for the re-prefill, and names the basis", () => {
		const verdict = priceSentPrefixRewrite({
			savedTokens: 1_242,
			rewrittenTokens: 2_199,
			remainingRequests: 5,
			remainingBasis: "learned from 6 lineages",
			...PRICES,
		});
		expect(verdict.admit).toBe(true);
		expect(verdict.reason).toContain("over 5 requests (learned from 6 lineages)");
		expect(verdict.savingUsd).toBeGreaterThan(verdict.costUsd ?? Number.POSITIVE_INFINITY);
	});

	it("declines the same batch when the lineage is expected to end sooner", () => {
		const verdict = priceSentPrefixRewrite({
			savedTokens: 1_242,
			rewrittenTokens: 2_199,
			remainingRequests: 3,
			...PRICES,
		});
		expect(verdict.admit).toBe(false);
		expect(verdict.reason).toMatch(/^re-prefill .* exceeds .* saved over 3 requests$/);
	});

	it("keeps the sent prefix as sent without prices", () => {
		expect(priceSentPrefixRewrite({ savedTokens: 1_000, rewrittenTokens: 2_000, remainingRequests: 100 }).admit).toBe(
			false,
		);
	});
});

describe("lineage remaining requests", () => {
	it("reads the live lineage's elapsed requests and learns the rest from the recorded ones", () => {
		const now = 1_000_000;
		const recorded = [
			{ sessionId: "live", lineage: "root", requests: 4, lastObservedAt: now },
			...[6, 8, 10, 12, 20].map((requests, index) => ({
				sessionId: `s${index}`,
				lineage: "root",
				requests,
				lastObservedAt: now,
			})),
		];
		const estimate = lineageRemainingRequests(recorded, { sessionId: "live", lineage: "root" }, now, 86_400_000);
		// Lineages past 4: 6, 8, 10, 12, 20 (the live one is censored at 4): half end by 10.
		expect(estimate).toEqual({ elapsed: 4, remaining: 6, lineages: 6 });
		// A new lineage of the same session has made no requests yet.
		expect(
			lineageRemainingRequests(recorded, { sessionId: "live", lineage: "compaction@1" }, now, 86_400_000).elapsed,
		).toBe(0);
	});
});

describe("cache decisions in the ledger", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const ledger of ledgers.splice(0)) ledger.close();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("round-trips a priced gc_pack verdict", () => {
		const dir = mkdtempSync(join(tmpdir(), "cache-decisions-"));
		dirs.push(dir);
		const ledger = openLedger(join(dir, "decision-ledger.sqlite"));
		ledger.recordCacheDecision({
			sessionId: "s",
			cwd: "/repo",
			kind: "gc_pack",
			decidedAt: 1,
			admit: false,
			reason: "priced not to pay",
			savingUsd: 0.1,
			costUsd: 0.2,
			detail: { earliestIndex: 9, packCount: 2 },
		});
		expect(ledger.cacheDecisions("s")).toEqual([
			{
				sessionId: "s",
				cwd: "/repo",
				kind: "gc_pack",
				decidedAt: 1,
				admit: false,
				reason: "priced not to pay",
				savingUsd: 0.1,
				costUsd: 0.2,
				detail: { earliestIndex: 9, packCount: 2 },
			},
		]);
	});
});
