/**
 * A3 — the context-GC freeze: below the request's `sentPrefixCount` (already gone out on an accepted
 * provider request) nothing changes spelling between two grid crossings of the quantized recent
 * boundary, while packing above the mark keeps working exactly as before. With a grid, a crossing
 * offers every packable message below the mark (what aged out plus deep supersessions) as ONE batch to
 * the host's price (`admitSentPrefixRewrite`); an admitted batch rewrites as one unit, a declined or
 * unpriced one stays exactly as sent and is offered again at the next crossing, and a message packed
 * once stays packed while frozen. Without a grid (`preserveRecentMessages: 0`, stride 1) the mark is
 * absolute.
 * See `context/prefix-stability.ts`'s `frozenPrefixLength` for how the mark, an index into the
 * pre-transform message list, gets re-anchored onto the array `applyContextGc` actually sees.
 */
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { ToolResultMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { applyContextGc, type ContextGcSettings, type SentPrefixRewriteBatch } from "../src/core/context-gc.ts";

const ADMIT = () => ({ admit: true, reason: "priced to pay" });
const DECLINE = () => ({ admit: false, reason: "priced not to pay" });

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
		// Fresh pools per pass: a message packed by one pass stays packed (memoized) in the next, which
		// is a separate contract pinned below.
		const msgs = messages(10);
		const unfrozen = applyContextGc(messages(msgs.length), options({ frozenBelow: 0 })).report.packedCount;
		const partiallyFrozen = applyContextGc(messages(msgs.length), options({ frozenBelow: 4 })).report.packedCount;
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

	// Within one long run `sentPrefixCount` grows in step with the transcript while `recentStart`
	// trails it by a constant `preserveRecentMessages`, so the mark overtakes the boundary early in
	// every run and stays ahead of it. An absolute freeze would then pack nothing for the rest of the
	// run, and a mark that reset per prompt repacked the whole previous run at the next prompt (the
	// measured prompt halving). The grid resolves both: rewrites below the mark are offered only at a
	// crossing of the quantized boundary, as one priced batch, whatever the run boundaries. These grid
	// assertions admit every batch; the price itself is pinned on its own below.
	const griddedBase = {
		cwd: "/repo",
		preserveRecentMessages: 8,
		packStrideMessages: 4,
		admitSentPrefixRewrite: ADMIT,
		minToolResultChars: 10,
		tools: ["bash"],
		writePayloads: false,
		semanticMemory: { preserveRecentPages: 0, minChars: Number.MAX_SAFE_INTEGER },
	};

	it("keeps making real packing progress turn over turn as the mark advances, whenever the run leaves any room", () => {
		const pool = messages(36);
		const turns = [
			{ length: 26, mark: 2 },
			{ length: 28, mark: 6 },
			{ length: 30, mark: 10 },
			{ length: 32, mark: 14 },
			{ length: 34, mark: 18 },
			{ length: 36, mark: 22 },
		];
		const packedPerTurn = turns.map(
			({ length, mark }) =>
				applyContextGc(pool.slice(0, length), { ...griddedBase, frozenBelow: mark }).report.packedCount,
		);
		for (const packedCount of packedPerTurn) expect(packedCount).toBeGreaterThan(0);
	});

	it("between two grid crossings nothing below the mark changes spelling", () => {
		// Previous request: 30 messages sent (mark 30), boundary quantize(30 - 8, 4) = 20. Now 32
		// messages: boundary quantize(24, 4) = 24 -- a crossing. Then 33 and 34 messages: boundary
		// still 24, so those passes may not rewrite anything below the mark they were handed.
		const pool = messages(34);
		const crossing = applyContextGc(pool.slice(0, 32), { ...griddedBase, frozenBelow: 30 });
		expect(crossing.report.records.map((record) => record.messageIndex)).toEqual(
			Array.from({ length: 24 }, (_, index) => index),
		);
		for (const [length, mark] of [
			[33, 32],
			[34, 33],
		] as const) {
			const quiet = applyContextGc(pool.slice(0, length), { ...griddedBase, frozenBelow: mark });
			// The packed messages keep their memoized packed form (same objects, same bytes)...
			for (let index = 0; index < 24; index++) {
				expect(quiet.messages[index]).toBe(crossing.messages[index]);
			}
			// ...and no message the crossing left alone is rewritten now.
			for (let index = 24; index < length; index++) {
				expect(quiet.messages[index]).toBe(pool[index]);
			}
		}
	});

	it("at an admitted crossing the batch that aged past the previous boundary packs even though it sits below the mark", () => {
		const pool = messages(40);
		// Mark 36 -> previous boundary quantize(28, 4) = 28; 40 messages -> boundary 32: the batch [28, 32)
		// crossed and packs below the mark; [32, 40) is recent and stays.
		const result = applyContextGc(pool, { ...griddedBase, frozenBelow: 36 });
		const packedIndexes = result.report.records.map((record) => record.messageIndex);
		expect(packedIndexes).toEqual(expect.arrayContaining([28, 29, 30, 31]));
		expect(packedIndexes.every((index) => index < 32)).toBe(true);
		for (let index = 32; index < 40; index++) expect(result.messages[index]).toBe(pool[index]);
	});

	it("a message packed once stays packed while frozen instead of reverting to its original", () => {
		const pool = messages(30);
		const first = applyContextGc(pool, { ...griddedBase, frozenBelow: 0 });
		expect(first.report.packedCount).toBeGreaterThan(0);
		// Everything is now below the mark and the boundary did not move: not a crossing.
		const frozen = applyContextGc(pool, { ...griddedBase, frozenBelow: 30 });
		expect(frozen.report.packedCount).toBe(first.report.packedCount);
		for (const record of first.report.records) {
			expect(frozen.messages[record.messageIndex]).toBe(first.messages[record.messageIndex]);
		}
	});

	it("without a grid the mark is an absolute freeze", () => {
		const pool = messages(30);
		const result = applyContextGc(pool, options({ frozenBelow: 22 }));
		expect(result.report.records.every((record) => record.messageIndex >= 22)).toBe(true);
		expect(result.report.packedCount).toBe(8);
	});

	it("offers a crossing's sent batch to the price once, and a declined batch stays exactly as sent", () => {
		const pool = messages(40);
		const offered: SentPrefixRewriteBatch[] = [];
		const declined = applyContextGc(pool, {
			...griddedBase,
			frozenBelow: 36,
			admitSentPrefixRewrite: (batch) => {
				offered.push(batch);
				return DECLINE();
			},
		});
		expect(offered).toHaveLength(1);
		// Every packable message below the mark: the backlog of this synthetic pool, earliest first.
		expect(offered[0]).toMatchObject({ earliestIndex: 0, packCount: 32 });
		expect(offered[0].savedTokens).toBeGreaterThan(0);
		// The provider re-prefills from the first rewritten message to the mark: at least what it saves.
		expect(offered[0].rewrittenTokens).toBeGreaterThanOrEqual(offered[0].savedTokens);
		for (let index = 0; index < 36; index++) expect(declined.messages[index]).toBe(pool[index]);
		expect(declined.report.sentPrefixRewrite).toMatchObject({
			admit: false,
			reason: "priced not to pay",
			packCount: 32,
		});
		// Unsent messages are not the provider's: they pack whatever the price said. [32, 36) is
		// recent; nothing at or above the mark is old enough here, so nothing packs at all.
		expect(declined.report.records.every((record) => record.messageIndex >= 36)).toBe(true);
	});

	it("without a price nothing below the mark rewrites, even at a crossing", () => {
		const pool = messages(40);
		const { admitSentPrefixRewrite: _unused, ...unpriced } = griddedBase;
		const result = applyContextGc(pool, { ...unpriced, frozenBelow: 36 });
		for (let index = 0; index < 36; index++) expect(result.messages[index]).toBe(pool[index]);
		expect(result.report.sentPrefixRewrite).toMatchObject({ admit: false, packCount: 32 });
	});

	it("a declined batch is offered again, larger, at the next crossing", () => {
		const pool = messages(44);
		const sizes: number[] = [];
		const record = (batch: SentPrefixRewriteBatch) => {
			sizes.push(batch.packCount);
			return DECLINE();
		};
		applyContextGc(pool.slice(0, 40), { ...griddedBase, frozenBelow: 36, admitSentPrefixRewrite: record });
		applyContextGc(pool, { ...griddedBase, frozenBelow: 40, admitSentPrefixRewrite: record });
		expect(sizes).toEqual([32, 36]);
	});

	it("between crossings nothing is offered to the price at all", () => {
		const pool = messages(34);
		let offers = 0;
		applyContextGc(pool, {
			...griddedBase,
			frozenBelow: 33,
			admitSentPrefixRewrite: () => {
				offers++;
				return ADMIT();
			},
		});
		expect(offers).toBe(0);
	});

	it("deep supersessions join a crossing's priced batch and pack only when it is admitted", () => {
		// Two reads of the same path: the older one becomes packable only because of the newer one,
		// deep inside the sent prefix. It never rewrites at an ordinary turn; at a crossing it is part
		// of the one priced batch, packing when the batch is admitted and staying as sent when declined.
		const read = (index: number, path: string): AgentMessage[] => [
			{
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${index}`, name: "read", arguments: { path } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "test",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: index,
			} as AgentMessage,
			{ ...toolResult(index), toolName: "read", toolCallId: `call-${index}` },
		];
		const filler = (index: number): AgentMessage =>
			({ role: "user", content: `turn ${index}`, timestamp: index }) as AgentMessage;
		const buildPool = (): AgentMessage[] => {
			const built: AgentMessage[] = [...read(0, "/repo/a.txt")];
			for (let index = 2; index < 40; index++) built.push(filler(index));
			built.push(...read(40, "/repo/a.txt"));
			return built;
		};
		const deepBase = { ...griddedBase, tools: ["read"] };
		// A crossing: mark 38 -> previous boundary quantize(30, 4) = 28; 42 messages -> boundary 32.
		const declinedPool = buildPool();
		const declined = applyContextGc(declinedPool, { ...deepBase, frozenBelow: 38, admitSentPrefixRewrite: DECLINE });
		expect(declined.report.records.some((record) => record.messageIndex === 1)).toBe(false);
		expect(declined.messages[1]).toBe(declinedPool[1]);
		expect(declined.report.sentPrefixRewrite).toMatchObject({ earliestIndex: 1, packCount: 1, admit: false });
		const admitted = applyContextGc(buildPool(), { ...deepBase, frozenBelow: 38 });
		expect(
			admitted.report.records.some((record) => record.messageIndex === 1 && record.reason === "superseded-read"),
		).toBe(true);
		// Outside a crossing a never-packed deep candidate does not rewrite, admitted or not (a fresh
		// pool: the admitted pass above memoized the packed form on its own pool's objects, and a
		// packed message staying packed is the frozen-stub contract, not a rewrite).
		const fresh = buildPool();
		const quiet = applyContextGc(fresh, { ...deepBase, frozenBelow: 42 });
		expect(quiet.messages[1]).toBe(fresh[1]);
		expect(quiet.report.sentPrefixRewrite).toBeUndefined();
	});
});
