import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { parseSessionFileTimestamp, scanSessionJsonl } from "./session-stats-common.mjs";

const temporaryDirectories = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test("parses Pi session timestamps without accepting unrelated filenames", () => {
	assert.equal(parseSessionFileTimestamp("/sessions/2026-08-01T14-55-00-123Z_abc.jsonl"), Date.parse("2026-08-01T14:55:00.123Z"));
	assert.equal(parseSessionFileTimestamp("/sessions/not-a-session.jsonl"), null);
});

test("streams sorted JSONL sessions once, skips old files, and isolates malformed lines", async () => {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-session-stats-"));
	temporaryDirectories.push(directory);
	await mkdir(path.join(directory, "nested"));
	await writeFile(path.join(directory, "2026-07-31T10-00-00-000Z_old.jsonl"), `${JSON.stringify({ id: "old" })}\n`);
	await writeFile(path.join(directory, "2026-08-01T12-00-00-000Z_b.jsonl"), `${JSON.stringify({ id: "b1" })}\nnot-json\n${JSON.stringify({ id: "b2" })}\n`);
	await writeFile(path.join(directory, "nested", "2026-08-01T11-00-00-000Z_a.jsonl"), `${JSON.stringify({ id: "a" })}\n`);
	await writeFile(path.join(directory, "nested", "ignored.txt"), "not a session");

	const visits = [];
	const result = await scanSessionJsonl({
		sessionsDir: directory,
		sinceMs: Date.parse("2026-08-01T00:00:00.000Z"),
		createSession: (sessionFile) => path.basename(sessionFile),
		onEntry: (entry, session) => visits.push(`${session}:${entry.id}`),
	});

	assert.deepEqual(visits, ["2026-08-01T12-00-00-000Z_b.jsonl:b1", "2026-08-01T12-00-00-000Z_b.jsonl:b2", "2026-08-01T11-00-00-000Z_a.jsonl:a"]);
	assert.deepEqual(result.meta, {
		sessionsDir: directory,
		sessionFilesScanned: 3,
		sessionFilesIncluded: 2,
		sessionFilesSkippedOlderThanSince: 1,
		malformedLines: 1,
	});
});

test("keeps transcript processing on a streaming path without accumulated prefixes", async () => {
	const source = await readFile(new URL("./session-stats-common.mjs", import.meta.url), "utf8");
	assert.match(source, /createReadStream\(sessionFile/);
	assert.doesNotMatch(source, /readFile\(sessionFile|(?:text|content|buffer|pending)\s*\+=\s*line|lines\.join\(/);
});
