import assert from "node:assert/strict";
import test from "node:test";
import { buildRelatedArgs } from "./run-coding-agent-related.mjs";

test("buildRelatedArgs turns the plan's JSON file list into a vitest related invocation", () => {
	assert.deepEqual(buildRelatedArgs('["src/a.ts","test/b.test.ts"]'), ["related", "src/a.ts", "test/b.test.ts", "--run"]);
});

test("buildRelatedArgs forwards extra CLI args after --run", () => {
	assert.deepEqual(buildRelatedArgs('["src/a.ts"]', ["--bail=0"]), ["related", "src/a.ts", "--run", "--bail=0"]);
});

test("buildRelatedArgs rejects missing, malformed, empty, or non-string-array input", () => {
	for (const bad of [undefined, "", "not json", "{}", "[]", "[1,2]", '["ok", 3]']) {
		assert.throws(() => buildRelatedArgs(bad), /PI_CI_RELATED_FILES/);
	}
});
