/**
 * Scale gate for alias expansion.
 *
 * Expansion runs on every tool argument and on every message rendered to the operator, while the
 * alias table grows for the whole session. Rebuilding the id->path lookup inside the call made
 * rendering O(messages x entries) — quadratic in session size, and invisible until a long session
 * with a large table crawled (measured before the fix: 2,000 messages against a 20,000-entry table
 * took 8.1 seconds; after, 2ms).
 *
 * The first gate is deterministic: it counts how many times the lookup is built, which is the exact
 * property that regressed and needs no clock. The timing gates that follow exist for the end-to-end
 * cost, and are written with a very large margin (the pre-fix signal is 400-500x) because
 * millisecond-scale wall-clock comparisons on a shared CI runner are noise.
 */

import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import { expandMessageForDisplay } from "../src/core/context/path-alias-display.ts";
import type { PathAliasEntry, PathAliasTable } from "../src/core/context/path-alias-table.ts";

function entriesOf(entryCount: number): PathAliasEntry[] {
	const entries: PathAliasEntry[] = [];
	for (let i = 0; i < entryCount; i++) {
		entries.push({ id: `p/module${i}.ts`, path: `packages/coding-agent/src/core/generated/module${i}.ts` });
	}
	return entries;
}

function tableOf(entryCount: number): PathAliasTable {
	return { cwd: "/repo", entries: entriesOf(entryCount), reservedIds: [] };
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
	// Warm the memoized lookup so this measures steady-state render cost, which is what a session
	// actually pays on every repaint.
	expandMessageForDisplay(table, messages[0] as AgentMessage);
	const started = performance.now();
	for (const message of messages) expandMessageForDisplay(table, message);
	return performance.now() - started;
}

describe("path alias display expansion scale", () => {
	it("builds its id lookup once for the whole table, never per call", () => {
		const real = entriesOf(50);
		let lookupBuilds = 0;
		// The lookup is built by mapping over the entries array; counting that access is a direct,
		// clock-free read of the property that regressed.
		const counted = new Proxy(real, {
			get(target, property, receiver) {
				if (property === "map") lookupBuilds++;
				return Reflect.get(target, property, receiver);
			},
		});
		const table: PathAliasTable = { cwd: "/repo", entries: counted, reservedIds: [] };

		for (const message of messagesOf(200)) expandMessageForDisplay(table, message);

		// Per-call rebuilding would be 200 here.
		expect(lookupBuilds).toBeLessThanOrEqual(1);
	});

	it("does not get slower as the alias table grows", () => {
		const smallTable = timeExpansion(100, 2_000);
		const hugeTable = timeExpansion(20_000, 2_000);
		// A 200x larger table rebuilt per call cost ~390x here; memoized it is free.
		expect(hugeTable / Math.max(smallTable, 0.05)).toBeLessThan(20);
	});

	it("renders a long session's worth of messages quickly", () => {
		// 3,608ms before the fix, ~7ms after; a full second is loaded-runner headroom, not a target.
		expect(timeExpansion(5_000, 5_000)).toBeLessThan(1_000);
	});
});
