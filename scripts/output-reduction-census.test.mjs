import assert from "node:assert/strict";
import { test } from "node:test";
import { censusSession } from "./output-reduction-census.mjs";

function toolCall(id, name, args) {
	return {
		type: "message",
		message: { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }] },
	};
}

function toolResult(id, name, text, details) {
	return {
		type: "message",
		message: { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text }], details },
	};
}

test("pairs results with their calls and classifies bash by the runtime's command family", () => {
	const entries = [
		toolCall("c1", "bash", { command: "cd /repo && git -C sub status --short | head -20" }),
		toolResult("c1", "bash", "M file.txt\n".repeat(10)),
		toolCall("c2", "bash", { command: "rg -n needle src" }),
		toolResult("c2", "bash", "src/a.ts:1:needle\n".repeat(40)),
		toolCall("c3", "read", { path: "/repo/file.txt" }),
		toolResult("c3", "read", "x".repeat(500)),
		toolCall("c4", "python", { code: "print(1)" }),
		toolResult("c4", "python", "1\n"),
		toolCall("c5", "bash", { command: "npx vitest run" }),
		toolResult("c5", "bash", "[FAIL] a\n", { outputProjection: { kind: "test", inputBytes: 5000, outputBytes: 9 } }),
	];
	const census = censusSession(entries, { replay: false });
	assert.equal(census.byTool.get("read").bytes, 500);
	assert.equal(census.byFamily.get("git status").n, 1);
	assert.equal(census.byFamily.get("rg").bytes, "src/a.ts:1:needle\n".length * 40);
	assert.equal(census.byFamily.get("python").n, 1);
	const projected = census.byFamily.get("vitest");
	assert.ok(projected, "the test runner is labeled by the program, not the launcher");
	assert.equal(projected.reducedN, 1);
	assert.equal(projected.reducedFrom, 5000);
	assert.equal(projected.reducedTo, 9);
});

test("replay leaves families with no reducer untouched and never throws on odd commands", () => {
	const entries = [
		toolCall("c1", "bash", { command: "some-unknown-tool --flag 'unterminated" }),
		toolResult("c1", "bash", "output\n"),
		toolResult("orphan", "bash", "no call recorded\n"),
	];
	const census = censusSession(entries, { replay: true });
	const unparsed = census.byFamily.get("(unparsed)");
	assert.ok(unparsed);
	assert.equal(unparsed.replayFrom, unparsed.replayTo);
	assert.equal(census.byFamily.get("(unpaired)").n, 1);
});
