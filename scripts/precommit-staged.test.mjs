import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
	createWorktreeResolveHook,
	isBarePackageSpecifier,
	resolveMainCheckoutRoot,
} from "./lib/tool-resolution.mjs";
import {
	biomeCoveredFiles,
	globToRegExp,
	partitionBiomeFiles,
	planStagedGates,
	stagedCopyPath,
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
	assert.deepEqual(plan, { biome: [], browserSmoke: false, typecheck: false });
});

test("a TypeScript source buys biome on that file and one project type check", () => {
	const plan = planStagedGates(["packages\\tui\\src\\viewport-mode.ts"], { biomeIncludes });
	assert.deepEqual(plan.biome, ["packages/tui/src/viewport-mode.ts"]);
	assert.equal(plan.typecheck, true);
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

test("a staged blob is checked as a sibling copy with the same extension", () => {
	assert.equal(stagedCopyPath("packages/coding-agent/src/core/agent-session.ts"), "packages/coding-agent/src/core/.precommit-staged-agent-session.ts");
	assert.equal(stagedCopyPath("top.mjs"), ".precommit-staged-top.mjs");
});

test("worktree bare-specifier hook retries only bare ERR_MODULE_NOT_FOUND against the main checkout manifest", () => {
	assert.equal(isBarePackageSpecifier("@caupulican/pi-ai"), true);
	assert.equal(isBarePackageSpecifier("typebox"), true);
	assert.equal(isBarePackageSpecifier("./ci-status.mjs"), false);
	assert.equal(isBarePackageSpecifier("../packages/a.ts"), false);
	assert.equal(isBarePackageSpecifier("/abs/path.mjs"), false);
	assert.equal(isBarePackageSpecifier("#internal"), false);
	assert.equal(isBarePackageSpecifier("node:fs"), false);
	assert.equal(isBarePackageSpecifier("fs"), false);
	assert.equal(isBarePackageSpecifier("file:///tmp/a.mjs"), false);

	const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-hook-")));
	try {
		const fallbackParentURL = pathToFileURL(join(root, "package.json")).href;
		const srcFileURL = pathToFileURL(join(root, "src-index.ts")).href;
		const missingDistURL = pathToFileURL(join(root, "dist-missing.js")).href;
		writeFileSync(join(root, "src-index.ts"), "export const ok = true;\n");

		let fallbackCalls = 0;
		const hook = createWorktreeResolveHook({
			getFallbackParentURL: () => {
				fallbackCalls++;
				return fallbackParentURL;
			},
		});

		// Direct hit never consults the fallback parent URL.
		const direct = hook("typebox", { parentURL: "file:///wt/a.ts" }, () => ({ url: srcFileURL }));
		assert.equal(direct.url, srcFileURL);
		assert.equal(fallbackCalls, 0);

		// Relative specifier ERR_MODULE_NOT_FOUND is rethrown untouched.
		assert.throws(
			() =>
				hook("./missing.mjs", { parentURL: "file:///wt/a.ts" }, () => {
					const err = new Error("not found");
					err.code = "ERR_MODULE_NOT_FOUND";
					throw err;
				}),
			{ code: "ERR_MODULE_NOT_FOUND" },
		);
		assert.equal(fallbackCalls, 0);

		// Bare workspace specifier retries at fallbackParentURL and falls back to pi-source when dist/ is absent.
		const seenContexts = [];
		const resolved = hook(
			"@caupulican/pi-ai",
			{ parentURL: "file:///wt/packages/coding-agent/src/a.ts", conditions: ["node", "import"] },
			(_specifier, ctx) => {
				seenContexts.push(ctx);
				if (ctx.parentURL !== fallbackParentURL) {
					const err = new Error("not found in worktree");
					err.code = "ERR_MODULE_NOT_FOUND";
					throw err;
				}
				return { url: ctx.conditions?.includes("pi-source") ? srcFileURL : missingDistURL };
			},
		);
		assert.equal(resolved.url, srcFileURL);
		assert.equal(seenContexts.length, 3);
		assert.deepEqual(seenContexts[2].conditions, ["pi-source", "node", "import"]);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("linked git worktree without node_modules resolves main-checkout packages through worktree-module-resolution", () => {
	const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "pi-wt-e2e-")));
	const mainDir = join(sandbox, "main");
	const linkedDir = join(sandbox, "linked");
	const scriptsRoot = fileURLToPath(new URL(".", import.meta.url));
	try {
		mkdirSync(join(mainDir, "scripts", "lib"), { recursive: true });
		mkdirSync(join(mainDir, "packages", "app", "src"), { recursive: true });
		mkdirSync(join(mainDir, "packages", "pkg", "src"), { recursive: true });
		writeFileSync(join(mainDir, "package.json"), JSON.stringify({ name: "wt-fixture", private: true, type: "module" }));
		writeFileSync(
			join(mainDir, "packages", "pkg", "package.json"),
			JSON.stringify({
				name: "@scope/pkg",
				type: "module",
				exports: {
					".": {
						"pi-source": "./src/index.ts",
						import: "./dist/index.js",
					},
				},
			}),
		);
		writeFileSync(
			join(mainDir, "packages", "pkg", "src", "index.ts"),
			'import { EXT_SUFFIX } from "ext-pkg";\nexport const MARKER: string = `resolved-${EXT_SUFFIX}`;\n',
		);
		copyFileSync(
			join(scriptsRoot, "lib", "tool-resolution.mjs"),
			join(mainDir, "scripts", "lib", "tool-resolution.mjs"),
		);
		copyFileSync(
			join(scriptsRoot, "lib", "worktree-module-resolution.mjs"),
			join(mainDir, "scripts", "lib", "worktree-module-resolution.mjs"),
		);
		writeFileSync(
			join(mainDir, "packages", "app", "src", "cmd.ts"),
			'import { MARKER } from "@scope/pkg";\nexport function readMarker(): string { return MARKER; }\n',
		);
		writeFileSync(
			join(mainDir, "scripts", "hook.mjs"),
			[
				'import "./lib/worktree-module-resolution.mjs";',
				'const { readMarker } = await import("../packages/app/src/cmd.ts");',
				"process.stdout.write(`${readMarker()}\\n`);",
				"",
			].join("\n"),
		);

		const gitEnv = ["-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false"];
		execFileSync("git", ["init", "-q"], { cwd: mainDir });
		execFileSync("git", ["add", "."], { cwd: mainDir });
		execFileSync("git", [...gitEnv, "commit", "-q", "-m", "init"], { cwd: mainDir });

		// Install @scope/pkg (workspace symlink to packages/pkg with unbuilt dist/ and live src/index.ts)
		// and ext-pkg (third-party physical .mjs package) ONLY in mainDir/node_modules.
		mkdirSync(join(mainDir, "node_modules", "@scope"), { recursive: true });
		symlinkSync(
			join(mainDir, "packages", "pkg"),
			join(mainDir, "node_modules", "@scope", "pkg"),
			process.platform === "win32" ? "junction" : "dir",
		);
		mkdirSync(join(mainDir, "node_modules", "ext-pkg"), { recursive: true });
		writeFileSync(
			join(mainDir, "node_modules", "ext-pkg", "package.json"),
			JSON.stringify({ name: "ext-pkg", type: "module", exports: "./index.mjs" }),
		);
		writeFileSync(
			join(mainDir, "node_modules", "ext-pkg", "index.mjs"),
			'export const EXT_SUFFIX = "from-main";\n',
		);

		execFileSync("git", ["worktree", "add", "-q", "--detach", linkedDir], { cwd: mainDir });
		assert.equal(existsSync(join(linkedDir, "node_modules")), false);
		assert.equal(resolveMainCheckoutRoot(mainDir), undefined);
		assert.equal(resolveMainCheckoutRoot(linkedDir), mainDir);

		const run = spawnSync(process.execPath, [join(linkedDir, "scripts", "hook.mjs")], {
			cwd: linkedDir,
			encoding: "utf8",
		});
		assert.equal(run.status, 0, run.stderr);
		assert.equal(run.stdout, "resolved-from-main\n");
	} finally {
		rmSync(sandbox, { recursive: true, force: true });
	}
});
