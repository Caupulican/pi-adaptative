import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, test } from "node:test";

import { writeTranscriptShards } from "./lib/transcript-shards.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

test("writes bounded shards in one pass and isolates oversized transcripts", async () => {
	const outputDir = await mkdtemp(path.join(tmpdir(), "pi-transcript-shards-"));
	temporaryDirectories.push(outputDir);
	let consumed = 0;
	function* transcripts(): Generator<string> {
		for (const value of ["aaaaaa", "bbbbbb", "c".repeat(25)]) {
			consumed++;
			yield value;
		}
	}

	const result = writeTranscriptShards(transcripts(), { outputDir, maxChars: 10 });

	assert.equal(consumed, 3);
	assert.deepEqual(
		result.files.map(({ name, chars, oversized }) => ({ name, chars, oversized })),
		[
			{ name: "session-transcripts-000.txt", chars: 6, oversized: false },
			{ name: "session-transcripts-001.txt", chars: 6, oversized: false },
			{ name: "session-transcripts-002.txt", chars: 25, oversized: true },
		],
	);
	assert.equal(await readFile(path.join(outputDir, result.files[0].name), "utf8"), "aaaaaa");
	assert.equal(await readFile(path.join(outputDir, result.files[2].name), "utf8"), "c".repeat(25));
});

test("keeps transcript and live-preview assembly off accumulated-prefix paths", async () => {
	const script = await readFile(new URL("./session-transcripts.ts", import.meta.url), "utf8");
	const writer = await readFile(new URL("./lib/transcript-shards.ts", import.meta.url), "utf8");
	assert.doesNotMatch(script, /textBuffer\s*\+=|currentContent\s*\+=|allTranscripts/);
	assert.match(writer, /writeShard\(parts\.join\(""\), newlines, false\)/);
});
