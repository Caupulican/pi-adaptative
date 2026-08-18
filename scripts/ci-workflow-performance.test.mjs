import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

test("normal CI keeps small workspaces on the quality job and shards coding-agent four ways", () => {
	assert.match(workflow, /run: npm test -- packages\/tui packages\/ai packages\/agent/u);
	assert.match(workflow, /^  coding-agent-test:\n/mu);
	assert.match(workflow, /shard: \[1, 2, 3, 4\]/u);
	assert.match(workflow, /--shard=\$\{\{ matrix\.shard \}\}\/4/u);
	assert.doesNotMatch(workflow, /^\s+run: npm test\s*$/mu);
});

test("normal CI reserves twenty minutes for runner setup plus bounded suite execution", () => {
	const shardJobStart = workflow.indexOf("  coding-agent-test:");
	assert.notEqual(shardJobStart, -1);
	const qualityJob = workflow.slice(0, shardJobStart);
	const shardJob = workflow.slice(shardJobStart);
	assert.match(qualityJob, /^    timeout-minutes: 20$/mu);
	assert.match(shardJob, /^    timeout-minutes: 20$/mu);
});

test("release fast paths skip every coding-agent shard after the exact suite already passed", () => {
	const qualityJob = workflow.slice(0, workflow.indexOf("  coding-agent-test:"));
	assert.match(qualityJob, /runner\.os == 'Linux' &&\n\s+inputs\.skip_tests != true/u);
	assert.match(qualityJob, /runner\.os == 'Windows' &&\n\s+inputs\.skip_tests != true/u);

	const shardJobStart = workflow.indexOf("  coding-agent-test:");
	assert.notEqual(shardJobStart, -1);
	const shardJob = workflow.slice(shardJobStart);
	assert.match(shardJob, /inputs\.skip_tests != true/u);
	assert.match(shardJob, /!startsWith\(github\.event\.head_commit\.message, 'Release v'\)/u);
});
