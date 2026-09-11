import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { biomeCoveredFiles, globToRegExp, partitionBiomeFiles, planStagedGates } from "./precommit-staged.mjs";

const biomeIncludes = JSON.parse(readFileSync(new URL("../biome.json", import.meta.url), "utf8")).files.includes;

test("biome globs: includes cover package sources and tests, negations remove generated and vendored files", () => {
	assert.equal(globToRegExp("packages/*/src/**/*.ts").regex.test("packages/tui/src/viewport-mode.ts"), true);
	assert.equal(globToRegExp("packages/*/src/**/*.ts").regex.test("packages/tui/src/a/b/c.ts"), true);
	assert.equal(globToRegExp("packages/*/src/**/*.ts").regex.test("packages/tui/src/a.mjs"), false);
	assert.deepEqual(globToRegExp("!!.claude"), { negated: true, regex: globToRegExp(".claude").regex });
	assert.deepEqual(
		biomeCoveredFiles(
			[
				"packages/tui/src/viewport-mode.ts",
				"packages/coding-agent/test/workbench.test.ts",
				"packages/ai/src/models.generated.ts",
				"packages/coding-agent/test/test-sessions.ts",
				"scripts/precommit-staged.mjs",
				"README.md",
				"packages/coding-agent/examples/extensions/with-deps/index.ts",
			],
			biomeIncludes,
		),
		[
			"packages/tui/src/viewport-mode.ts",
			"packages/coding-agent/test/workbench.test.ts",
			"packages/coding-agent/examples/extensions/with-deps/index.ts",
		],
	);
});

test("a docs-only commit buys no gate beyond the guards", () => {
	const plan = planStagedGates(["docs/workbench.md", "AGENTS.md"], { biomeIncludes });
	assert.deepEqual(plan, { biome: [], browserSmoke: false, typecheck: false, tests: [] });
});

test("a staged test file runs only itself, with its workspace's runner", () => {
	const plan = planStagedGates(
		["packages/coding-agent/test/workbench.test.ts", "packages/tui/test/viewport-mode.test.ts", "scripts/precommit-staged.test.mjs"],
		{ biomeIncludes },
	);
	assert.deepEqual(plan.tests, [
		{ cwd: "packages/coding-agent", runner: "vitest", file: "test/workbench.test.ts" },
		{ cwd: "packages/tui", runner: "node-test", file: "test/viewport-mode.test.ts" },
		{ cwd: ".", runner: "node-test", file: "scripts/precommit-staged.test.mjs" },
	]);
	assert.equal(plan.typecheck, true);
});

test("a TypeScript source buys biome on that file and one project type check; the destructive suite never runs", () => {
	const plan = planStagedGates(
		["packages\\tui\\src\\viewport-mode.ts", "packages/coding-agent/test-destructive/chaos.test.ts"],
		{ biomeIncludes },
	);
	assert.deepEqual(plan.biome, ["packages/tui/src/viewport-mode.ts", "packages/coding-agent/test-destructive/chaos.test.ts"]);
	assert.equal(plan.typecheck, true);
	assert.deepEqual(plan.tests, []);
});

test("browser smoke runs only when its inputs are staged", () => {
	assert.equal(planStagedGates(["packages/ai/src/index.ts"], { biomeIncludes }).browserSmoke, true);
	assert.equal(planStagedGates(["package-lock.json"], { biomeIncludes }).browserSmoke, true);
	assert.equal(planStagedGates(["packages/agent/src/agent.ts"], { biomeIncludes }).browserSmoke, false);
	assert.equal(planStagedGates(["scripts/precommit-staged.mjs"], { biomeIncludes }).typecheck, false);
});

test("a partially staged file is checked on its staged content, never rewritten or restaged", () => {
	const { whole, partiallyStaged } = partitionBiomeFiles(
		["packages/coding-agent/src/a.ts", "packages/coding-agent/src/b.ts", "scripts/c.mjs"],
		["packages/coding-agent/src/b.ts"],
	);
	assert.deepEqual(whole, ["packages/coding-agent/src/a.ts", "scripts/c.mjs"]);
	assert.deepEqual(partiallyStaged, ["packages/coding-agent/src/b.ts"]);
});
