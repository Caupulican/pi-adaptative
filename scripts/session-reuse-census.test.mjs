import assert from "node:assert/strict";
import { test } from "node:test";

import { DEFAULT_GATE, censusEntries, evaluateGate, groupSummaries, summarize } from "./session-reuse-census.mjs";

function assistant(index, { input, cacheRead, ttftMs = 1_000, provider = "xai", model = "grok" }) {
	const timestamp = 1_000_000 + index * 60_000;
	return {
		type: "message",
		id: `a${index}`,
		message: {
			role: "assistant",
			provider,
			model,
			content: [{ type: "text", text: "ok" }],
			usage: { input, cacheRead, cacheWrite: 0, output: 10, cost: { total: 0.5 } },
			timestamp,
			firstTokenAt: timestamp + ttftMs,
			streamEndAt: timestamp + ttftMs + 500,
		},
	};
}
const toolResult = (text) => ({ type: "message", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text }] } });
const user = (text) => ({ type: "message", message: { role: "user", content: text } });
const customMessage = (customType, content) => ({ type: "custom_message", customType, content });

const session = [
	{ type: "session", version: 4 },
	{ type: "custom", customType: "reflection_cue_state", data: { versionChange: { metadata: { runtimeVersion: "0.97.25" } } } },
	user("hi"),
	assistant(0, { input: 12_000, cacheRead: 0 }),
	toolResult("x".repeat(1_000)),
	customMessage("path_alias_legend", "PATH ALIASES\np/a=one\n"),
	assistant(1, { input: 200, cacheRead: 13_000 }),
	toolResult("y".repeat(1_000)),
	customMessage("path_alias_legend", "PATH ALIASES\np/a=one\np/b=two\n"),
	assistant(2, { input: 300, cacheRead: 13_500 }),
	customMessage("reflection_turn_trigger", "reflect"),
	assistant(3, { input: 7_000, cacheRead: 128, ttftMs: 9_000 }),
	{ type: "compaction", summary: "s" },
	{ type: "compaction_end", outcome: "fallback" },
	user("more"),
	assistant(4, { input: 3_000, cacheRead: 0 }),
];

test("classifies requests by trigger, counts wipes and misses, and reads TTFT", () => {
	const census = censusEntries(session);
	assert.equal(census.runtimeVersion, "0.97.25");
	assert.deepEqual(
		census.requests.map((r) => [r.group, r.wipe, r.miss]),
		[
			["user_turn", false, true],
			["tool_loop", false, false],
			["tool_loop", false, false],
			["reflection_turn", true, true],
			["after_compaction", false, true],
		],
	);
	const summary = summarize(census.requests);
	assert.equal(summary.n, 5);
	assert.equal(summary.wipes, 1);
	assert.equal(summary.misses, 3);
	assert.equal(summary.maxPrompt, 13_800);
	assert.equal(summary.ttftP90, 9);
	const groups = new Map(groupSummaries(census.requests).map((g) => [g.group, g]));
	assert.equal(groups.get("tool_loop").n, 2);
	assert.ok(groups.get("tool_loop").p50Reuse > 0.97);
	assert.ok(groups.get("reflection_turn").p50PromptRatio < 0.6);
});

test("censuses persisted host records against tool output and fails the gate", () => {
	const census = censusEntries(session);
	assert.equal(census.toolResultChars, 2_000);
	assert.equal(census.legendCopies, 2);
	assert.equal(census.compactions, 1);
	assert.equal(census.compactionFallbacks, 1);
	assert.ok(census.legendBytesRatio > 1.5 && census.legendBytesRatio < 2);
	const legend = census.records.find((r) => r.kind === "path_alias_legend");
	assert.deepEqual(legend, { kind: "path_alias_legend", count: 2, chars: 50, maxChars: 29, distinct: 2 });
	const failures = evaluateGate(census, DEFAULT_GATE);
	assert.ok(failures.some((f) => f.startsWith("user_turn p50 reuse")));
	assert.ok(failures.some((f) => f.startsWith("legend bytes ratio")));
	assert.ok(failures.some((f) => f.startsWith("compaction fallbacks 1")));
	assert.equal(evaluateGate(census, {}).length, 0);
});
