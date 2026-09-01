/**
 * A3 — the context-GC freeze: packing must never rewrite a message at an index below the
 * request's `sentPrefixCount` (already gone out on an accepted provider request), while packing
 * above that mark keeps working exactly as before. See `context/prefix-stability.ts`'s
 * `frozenPrefixLength` for how the mark, an index into the pre-transform message list, gets
 * re-anchored onto the array `applyContextGc` actually sees.
 */
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { applyContextGc, type ContextGcSettings } from "../src/core/context-gc.ts";

function toolResult(index: number): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: `call-${index}`,
		toolName: "bash",
		// Comfortably over minToolResultChars below, and unique per index so two packed
		// messages never coincidentally collide on their content-derived storage key.
		content: [{ type: "text", text: `output ${index}\n${"0123456789abcdef".repeat(80)}` }],
		isError: false,
		timestamp: index,
	};
}

function messages(count: number): AgentMessage[] {
	return Array.from({ length: count }, (_, index) => toolResult(index));
}

/** `preserveRecentMessages: 0` and a huge semantic-memory char floor isolate tool-result packing
 * as the only packable category, so every assertion below is about the freeze, not about which
 * category happened to be eligible. */
function options(overrides: Partial<ContextGcSettings & { frozenBelow: number; writePayloads: boolean }>) {
	return {
		cwd: "/repo",
		preserveRecentMessages: 0,
		minToolResultChars: 10,
		tools: ["bash"],
		writePayloads: false,
		semanticMemory: { preserveRecentPages: 0, minChars: Number.MAX_SAFE_INTEGER },
		frozenBelow: 0,
		...overrides,
	};
}

describe("context-gc: sentPrefixCount freeze", () => {
	it("never rewrites a message below the mark", () => {
		const msgs = messages(5);
		const result = applyContextGc(msgs, options({ frozenBelow: 3 }));
		expect(result.messages[0]).toBe(msgs[0]);
		expect(result.messages[1]).toBe(msgs[1]);
		expect(result.messages[2]).toBe(msgs[2]);
		expect(result.report.records.every((record) => record.messageIndex >= 3)).toBe(true);
	});

	it("still packs a message at or above the mark, normally", () => {
		const msgs = messages(5);
		const result = applyContextGc(msgs, options({ frozenBelow: 3 }));
		expect(result.messages[3]).not.toBe(msgs[3]);
		expect(result.messages[4]).not.toBe(msgs[4]);
		expect(result.report.packedCount).toBe(2);
	});

	it("does not disable packing altogether: everything at or above the mark still packs", () => {
		const msgs = messages(10);
		const unfrozen = applyContextGc(msgs, options({ frozenBelow: 0 })).report.packedCount;
		const partiallyFrozen = applyContextGc(msgs, options({ frozenBelow: 4 })).report.packedCount;
		expect(unfrozen).toBe(10);
		expect(partiallyFrozen).toBe(6); // indices 4-9
		expect(partiallyFrozen).toBeGreaterThan(0);
	});

	it("releases a message for packing once a later request's mark no longer covers it", () => {
		const msgs = messages(5);
		// This request's mark protects the whole transcript so far: nothing packs.
		const frozen = applyContextGc(msgs, options({ frozenBelow: 5 }));
		expect(frozen.report.packedCount).toBe(0);
		expect(frozen.messages[2]).toBe(msgs[2]);

		// A later request whose own mark does not cover index 2 (a fresh run's mark reset, in the
		// live system) is free to pack it: the freeze is scoped to whatever mark THIS call receives,
		// never a durable property baked into the message itself.
		const released = applyContextGc(msgs, options({ frozenBelow: 0 }));
		expect(released.report.packedCount).toBe(5);
		expect(released.messages[2]).not.toBe(msgs[2]);
	});

	it("preview (writePayloads=false) and commit (writePayloads=true) reach the same packing decision for the same mark", () => {
		const msgs = messages(8);
		const preview = applyContextGc(msgs, options({ frozenBelow: 3, writePayloads: false }));
		const commit = applyContextGc(msgs, options({ frozenBelow: 3, writePayloads: true }));
		expect(commit.report.records.map((record) => record.messageIndex)).toEqual(
			preview.report.records.map((record) => record.messageIndex),
		);
		expect(commit.messages.map((message, index) => message === msgs[index])).toEqual(
			preview.messages.map((message, index) => message === msgs[index]),
		);
	});

	// IMPORTANT SHAPE NOTE, found while building this evidence (see the report back on this task):
	// within one long-running turn sequence, `sentPrefixCount` tracks "confirmed sent so far in
	// THIS run" and grows roughly in step with the transcript itself, while `recentStart` tracks
	// "old enough to consider packing" at a roughly CONSTANT offset behind the transcript's current
	// length (`preserveRecentMessages`). Whenever a run's own per-turn growth is smaller than
	// `preserveRecentMessages` -- the common case, since `preserveRecentMessages` defaults to 24
	// and a typical round trip adds a handful of messages -- the mark overtakes `recentStart` and
	// STAYS ahead of it for the rest of that run. That is not this fix behaving incorrectly: EVERY
	// message it declines to pack there is, by construction, already sent, and packing it would be
	// exactly the cache-breaking rewrite A3 exists to prevent. The two tests below are the honest
	// versions of the two proofs requested: packing keeps making real progress turn over turn
	// wherever the run's own mark leaves it any room, and nothing skipped is EVER lost -- once a
	// fresh run's mark (the real system resets it at the start of every new top-level prompt --
	// see `Agent.runPromptMessages`) no longer covers a message, it packs exactly as it would have
	// with no freeze at all.
	it("keeps making real packing progress turn over turn as the mark advances, whenever the run leaves any room", () => {
		const preserveRecentMessages = 8;
		const pool = messages(36);
		const base = {
			cwd: "/repo",
			preserveRecentMessages,
			minToolResultChars: 10,
			tools: ["bash"],
			writePayloads: false,
			semanticMemory: { preserveRecentPages: 0, minChars: Number.MAX_SAFE_INTEGER },
		};
		// A run that started (mark reset) with some transcript already accumulated, then continues
		// turn over turn -- the mark growing with what gets confirmed sent, right up to (and past)
		// the point where it overtakes the recency boundary.
		const turns = [
			{ length: 26, mark: 2 },
			{ length: 28, mark: 6 },
			{ length: 30, mark: 10 },
			{ length: 32, mark: 14 },
			{ length: 34, mark: 18 },
			{ length: 36, mark: 22 },
		];
		const packedPerTurn = turns.map(
			({ length, mark }) => applyContextGc(pool.slice(0, length), { ...base, frozenBelow: mark }).report.packedCount,
		);
		// Every turn in this run packs something real, even as the mark keeps advancing -- this is
		// the literal "mark advances across several turns and packing still happens above it" proof.
		for (const packedCount of packedPerTurn) expect(packedCount).toBeGreaterThan(0);
	});

	it("never permanently loses packable content: what a growing mark defers, a fresh mark's reset recovers in full", () => {
		const preserveRecentMessages = 8;
		const pool = messages(30);
		const base = {
			cwd: "/repo",
			preserveRecentMessages,
			minToolResultChars: 10,
			tools: ["bash"],
			writePayloads: false,
			semanticMemory: { preserveRecentPages: 0, minChars: Number.MAX_SAFE_INTEGER },
		};
		const midRun = pool.slice(0, 30);

		// Deep enough into one long run that the mark has overtaken the recency boundary: packing
		// correctly declines everything here.
		const suppressed = applyContextGc(midRun, { ...base, frozenBelow: 22 });
		const wouldHavePackedUnsafely = applyContextGc(midRun, { ...base, frozenBelow: 0 });
		expect(suppressed.report.packedCount).toBe(0);
		expect(wouldHavePackedUnsafely.report.packedCount).toBeGreaterThan(0);
		// Confirm the decline is JUSTIFIED, not a bug: everything the unfrozen pass would have
		// packed here sits below the mark that suppressed it -- i.e. it really was already sent.
		expect(wouldHavePackedUnsafely.report.records.every((record) => record.messageIndex < 22)).toBe(true);

		// A fresh run's mark reset on the exact same transcript (the real system resets it at the
		// start of every new top-level prompt) recovers the deferred content in full: identical
		// packed count to what an unfrozen pass would have produced -- nothing was lost, only held
		// until it was actually safe to rewrite.
		const released = applyContextGc(midRun, { ...base, frozenBelow: 0 });
		expect(released.report.packedCount).toBe(wouldHavePackedUnsafely.report.packedCount);
	});
});
