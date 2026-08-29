/**
 * Scale gate for alias expansion.
 *
 * Expansion runs on every tool argument and on every message rendered to the operator, while the
 * alias table grows for the whole session. Anything that rebuilds a per-entry structure inside the
 * call turns rendering into O(messages x entries) — quadratic in session size, and invisible until
 * a long session crawls. These gates assert the shape of the curve, not a wall-clock number, so
 * they stay meaningful on a loaded CI runner: doubling the work may not much more than double the
 * time, and growing the TABLE alone must not move per-message cost at all.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import { expandMessageForDisplay } from "../src/core/context/path-alias-display.ts";
import type { PathAliasEntry, PathAliasTable } from "../src/core/context/path-alias-table.ts";

function tableOf(entryCount: number): PathAliasTable {
	const entries: PathAliasEntry[] = [];
	for (let i = 0; i < entryCount; i++) {
		entries.push({ id: `p/module${i}.ts`, path: `packages/coding-agent/src/core/generated/module${i}.ts` });
	}
	return { cwd: "/repo", entries, reservedIds: [] };
}

function messagesOf(count: number): AgentMessage[] {
	const messages: AgentMessage[] = [];
	for (let i = 0; i < count; i++) {
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `Inspected p/module${i % 64}.ts and summarized it for the operator.` }],
			timestamp: i,
		} as unknown as AgentMessage);
	}
	return messages;
}

function timeExpansion(entryCount: number, messageCount: number): number {
	const table = tableOf(entryCount);
	const messages = messagesOf(messageCount);
	// Warm the memoized lookup so the measurement is steady-state render cost, which is what a
	// session actually pays on every repaint.
	expandMessageForDisplay(table, messages[0] as AgentMessage);
	const started = performance.now();
	for (const message of messages) expandMessageForDisplay(table, message);
	return performance.now() - started;
}

describe("path alias display expansion scale", () => {
	it("stays linear in the number of messages rendered", () => {
		const small = timeExpansion(2_000, 500);
		const large = timeExpansion(2_000, 4_000);
		// 8x the messages must not cost more than ~24x the time; quadratic growth would be ~64x.
		const ratio = large / Math.max(small, 0.05);
		expect(ratio).toBeLessThan(24);
	});

	it("does not get slower as the alias table grows", () => {
		const smallTable = timeExpansion(100, 2_000);
		const hugeTable = timeExpansion(20_000, 2_000);
		// A 200x larger table rebuilt per call would be catastrophic here; memoized it is free.
		const ratio = hugeTable / Math.max(smallTable, 0.05);
		expect(ratio).toBeLessThan(8);
	});

	it("renders a long session's worth of messages quickly", () => {
		expect(timeExpansion(5_000, 5_000)).toBeLessThan(1_000);
	});
});
