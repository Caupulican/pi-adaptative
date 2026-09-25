import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	biomeCoveredFiles,
	globToRegExp,
	partitionBiomeFiles,
	planCarriedTests,
	planStagedGates,
	stagedCopyPath,
	withoutHookGitLocation,
} from "./precommit-staged.mjs";

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
	assert.deepEqual(plan, { biome: [], browserSmoke: false, typecheck: false, tests: [], relatedTests: [] });
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

test("staged tests drop the hook git location and keep the rest of the environment", () => {
	const env = withoutHookGitLocation({
		PATH: "/usr/bin",
		KEEP: "yes",
		GIT_DIR: "/repo/.git",
		GIT_WORK_TREE: "/repo",
		GIT_INDEX_FILE: "/repo/.git/index",
		GIT_OBJECT_DIRECTORY: "/repo/.git/objects",
		GIT_COMMON_DIR: "/repo/.git",
	});
	assert.equal(env.PATH, "/usr/bin");
	assert.equal(env.KEEP, "yes");
	assert.equal(env.GIT_DIR, undefined);
	assert.equal(env.GIT_WORK_TREE, undefined);
	assert.equal(env.GIT_INDEX_FILE, undefined);
	assert.equal(env.GIT_OBJECT_DIRECTORY, undefined);
	assert.equal(env.GIT_COMMON_DIR, undefined);
	assert.equal("GIT_INDEX_FILE" in env, false);
});

test("a staged blob is checked as a sibling copy with the same extension", () => {
	assert.equal(stagedCopyPath("packages/coding-agent/src/core/agent-session.ts"), "packages/coding-agent/src/core/.precommit-staged-agent-session.ts");
	assert.equal(stagedCopyPath("top.mjs"), ".precommit-staged-top.mjs");
});

test("tests importing a staged source run as one batch per workspace, never twice and never destructive", () => {
	const plan = planStagedGates(
		["packages/coding-agent/src/core/python-runtime.ts", "packages/coding-agent/test/python-runtime.test.ts"],
		{
			biomeIncludes,
			findRelated: (workspace, files) => {
				assert.ok(files.includes("packages/coding-agent/src/core/python-runtime.ts"));
				return workspace === "packages/coding-agent"
					? [
							"packages/coding-agent/test/python-runtime.test.ts",
							"packages/coding-agent/test/windows-shell-engine.test.ts",
							"packages/coding-agent/test-destructive/chaos.test.ts",
						]
					: [];
			},
		},
	);
	assert.deepEqual(plan.relatedTests, [
		{ cwd: "packages/coding-agent", runner: "vitest", files: ["test/windows-shell-engine.test.ts"] },
	]);
});

test("carried failing tests from a red CI run batch per workspace and skip files that no longer exist", () => {
	assert.deepEqual(
		planCarriedTests(
			[
				{ workspace: "packages/coding-agent", file: "test/a.test.ts", platforms: ["ubuntu"] },
				{ workspace: "packages/coding-agent", file: "test/deleted.test.ts", platforms: ["windows"] },
				{ workspace: "packages/agent", file: "test/b.test.ts", platforms: ["ubuntu"] },
			],
			(path) => !path.endsWith("deleted.test.ts"),
			"ubuntu",
		),
		[
			{ cwd: "packages/coding-agent", runner: "vitest", files: ["test/a.test.ts"], elsewhere: [] },
			{ cwd: "packages/agent", runner: "vitest", files: ["test/b.test.ts"], elsewhere: [] },
		],
	);
});

test("a carried test that failed only on another platform still runs, and is named as not cleared here", () => {
	assert.deepEqual(
		planCarriedTests(
			[
				{ workspace: "packages/coding-agent", file: "test/tools.test.ts", platforms: ["windows"] },
				{ workspace: "packages/coding-agent", file: "test/both.test.ts", platforms: ["ubuntu", "windows"] },
			],
			() => true,
			"ubuntu",
		),
		[
			{
				cwd: "packages/coding-agent",
				runner: "vitest",
				files: ["test/tools.test.ts", "test/both.test.ts"],
				elsewhere: [{ file: "test/tools.test.ts", platforms: ["windows"] }],
			},
		],
	);
});
