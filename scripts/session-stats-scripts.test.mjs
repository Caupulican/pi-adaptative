import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";

let sessionsDirectory;

before(async () => {
	sessionsDirectory = await mkdtemp(path.join(tmpdir(), "pi-session-reporters-"));
	const entries = [
		{ type: "session", cwd: "/fixture", timestamp: "2026-08-01T12:00:00.000Z" },
		{
			id: "assistant-1",
			type: "message",
			timestamp: "2026-08-01T12:00:01.000Z",
			message: {
				role: "assistant",
				provider: "openai",
				model: "gpt-4.1",
				usage: { totalTokens: 100 },
				content: [
					{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "/fixture/a.ts", offset: 1, limit: 10 } },
					{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "/fixture/a.ts", oldText: "old", newText: "new" } },
				],
			},
		},
		{
			type: "message",
			timestamp: "2026-08-01T12:00:02.000Z",
			message: { role: "toolResult", toolName: "edit", toolCallId: "edit-1", isError: false, content: [{ type: "text", text: "Updated /fixture/a.ts" }] },
		},
		{ type: "message", timestamp: "2026-08-01T12:00:03.000Z", message: { role: "user", content: "continue" } },
	];
	await writeFile(path.join(sessionsDirectory, "2026-08-01T12-00-00-000Z_fixture.jsonl"), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
});

after(async () => {
	await rm(sessionsDirectory, { force: true, recursive: true });
});

function runJson(script, extraArgs = []) {
	const result = spawnSync(process.execPath, [path.resolve("scripts", script), "--sessions-dir", sessionsDirectory, "--all-sessions", "--json", ...extraArgs], {
		cwd: path.resolve("."),
		encoding: "utf8",
	});
	assert.equal(result.status, 0, result.stderr);
	return JSON.parse(result.stdout);
}

test("edit stats retain tool-result matching through the shared scanner", () => {
	const output = runJson("edit-tool-stats.mjs", ["--include-records"]);
	assert.equal(output.summary.counts.totalEditCalls, 1);
	assert.equal(output.records[0].success, true);
	assert.equal(output.records[0].resultSummary, "Updated /fixture/a.ts");
});

test("read stats retain partial-read classification through the shared scanner", () => {
	const output = runJson("read-tool-stats.mjs", ["--include-records"]);
	assert.equal(output.summary.counts.totalReadCalls, 1);
	assert.equal(output.records[0].mode, "partial");
});

test("context stats retain session aggregation through the shared scanner", () => {
	const output = runJson("session-context-stats.mjs", ["--all-cwds"]);
	assert.equal(output.totals.sessions, 1);
	assert.equal(output.totals.assistantMessages, 1);
	assert.equal(output.totals.avgTurns, 1);
});
