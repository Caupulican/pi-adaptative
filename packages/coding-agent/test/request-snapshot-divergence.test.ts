import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CacheObservationRecorder, cacheLaneKey } from "../src/core/context/cache-observation-recorder.ts";
import { DecisionLedgerStore } from "../src/core/operator-projection/decision-ledger-store.ts";
import { compareRequestPrefix, messageFingerprint } from "../src/core/request-snapshot-fingerprints.ts";

function user(text: string) {
	return { role: "user", content: text, timestamp: 0 };
}

function prefix(system: string, tools: string, messages: readonly object[]) {
	return { system, tools, messages: messages.map(messageFingerprint) };
}

/** Every ledger a test opens, closed before its directory is removed (Windows cannot delete an open database). */
const ledgers: DecisionLedgerStore[] = [];
function openLedger(databasePath: string): DecisionLedgerStore {
	const ledger = new DecisionLedgerStore({ databasePath });
	ledgers.push(ledger);
	return ledger;
}

describe("request prefix divergence", () => {
	const a = user("a");
	const b = user("b");
	const c = user("c");

	it("is unknown on a lane's first request and intact on a pure append", () => {
		expect(compareRequestPrefix(undefined, prefix("s", "t", [a]), [a])).toEqual({ prefixIntact: "unknown" });
		expect(compareRequestPrefix(prefix("s", "t", [a, b]), prefix("s", "t", [a, b, c]), [a, b, c])).toEqual({
			prefixIntact: true,
		});
	});

	it("names the system prompt or the tools when they changed", () => {
		expect(compareRequestPrefix(prefix("s", "t", [a]), prefix("s2", "t", [a]), [a])).toEqual({
			prefixIntact: false,
			firstDivergentIndex: -1,
			firstDivergentKind: "system",
		});
		expect(compareRequestPrefix(prefix("s", "t", [a]), prefix("s", "t2", [a]), [a])).toMatchObject({
			firstDivergentKind: "tools",
		});
	});

	it("names the first rewritten message by role or record kind, and a removed one", () => {
		const record = { role: "custom", customType: "path_alias_legend", content: "x", timestamp: 0 };
		const rewritten = { role: "custom", customType: "path_alias_legend", content: "y", timestamp: 0 };
		expect(
			compareRequestPrefix(prefix("s", "t", [a, record]), prefix("s", "t", [a, rewritten, c]), [a, rewritten, c]),
		).toEqual({ prefixIntact: false, firstDivergentIndex: 1, firstDivergentKind: "custom:path_alias_legend" });
		expect(compareRequestPrefix(prefix("s", "t", [a, b]), prefix("s", "t", [a]), [a])).toEqual({
			prefixIntact: false,
			firstDivergentIndex: 1,
			firstDivergentKind: "removed",
		});
	});
});

describe("cache observations", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const ledger of ledgers.splice(0)) ledger.close();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("measures the gap and the retained share of the previous prompt per lane", () => {
		const recorder = new CacheObservationRecorder();
		const lane = cacheLaneKey("anthropic-messages", "anthropic", "claude-opus-5-5");
		const first = recorder.observe({ sessionId: "s", lane, respondedAt: 1_000, usage: { input: 10_000 } });
		expect(first).toMatchObject({ lane, promptTokens: 10_000, prefixIntact: "unknown" });
		expect(first?.gapMs).toBeUndefined();
		const second = recorder.observe({
			sessionId: "s",
			lane,
			requestOpenedAt: 61_000,
			respondedAt: 65_000,
			usage: { input: 500, cacheRead: 9_000, cacheWrite: 500 },
			prefixIntact: true,
		});
		expect(second).toMatchObject({ gapMs: 60_000, promptTokens: 10_000, retained: 0.9, prefixIntact: "true" });
		// An empty response (no prompt counted) is not an observation.
		expect(recorder.observe({ sessionId: "s", lane, respondedAt: 70_000, usage: {} })).toBeUndefined();
	});

	it("round-trips through the decision ledger, newest first", () => {
		const dir = mkdtempSync(join(tmpdir(), "cache-observations-"));
		dirs.push(dir);
		const ledger = openLedger(join(dir, "decision-ledger.sqlite"));
		const lane = cacheLaneKey("openai-codex-responses", "openai-codex", "gpt-5.6-sol");
		ledger.recordCacheObservation({
			sessionId: "s",
			cwd: "/repo",
			lane,
			observedAt: 1,
			promptTokens: 100,
			cacheReadTokens: 0,
			prefixIntact: "unknown",
		});
		ledger.recordCacheObservation({
			sessionId: "s",
			cwd: "/repo",
			lane,
			observedAt: 2,
			gapMs: 30_000,
			promptTokens: 120,
			cacheReadTokens: 90,
			retained: 0.9,
			prefixIntact: "false",
			divergenceKind: "custom:path_alias_legend",
		});
		const rows = ledger.recentCacheObservations(lane, 10);
		expect(rows.map((row) => row.observedAt)).toEqual([2, 1]);
		expect(rows[0]).toMatchObject({ gapMs: 30_000, retained: 0.9, divergenceKind: "custom:path_alias_legend" });
		expect(rows[1].gapMs).toBeUndefined();
	});
});
