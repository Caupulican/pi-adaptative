import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	codingAgentRelatedFiles,
	codingAgentShards,
	EMPTY_PLAN,
	enrichWithScanIncludes,
	FULL_PLAN,
	isReleaseMetadataSubject,
	listChangedFiles,
	parseCarriedFiles,
	planAffected,
	workspaceOf,
} from "./ci-affected.mjs";
import { WORKSPACES } from "./workspace-test-plan.mjs";

test("workspaceOf reads the first packages/ segment on POSIX and Windows paths", () => {
	assert.equal(workspaceOf("packages/tui/src/foo.ts"), "packages/tui");
	assert.equal(workspaceOf("packages\\agent\\src\\bar.ts"), "packages/agent");
	assert.equal(workspaceOf("scripts/ci-affected.mjs"), undefined);
});

test("release metadata subjects match only the exact Release/Repair commit titles", () => {
	assert.equal(isReleaseMetadataSubject("Release v1.2.3"), true);
	assert.equal(isReleaseMetadataSubject("Repair release v1.2.3\n\nbody"), true);
	assert.equal(isReleaseMetadataSubject("Add [Unreleased] section for next cycle"), false);
	assert.equal(isReleaseMetadataSubject("Release v1.2.3 extra"), false);
});

test("full suite is the complete Linux/Windows matrix", () => {
	assert.deepEqual(planAffected({ fullSuite: true }).workspaces, [...WORKSPACES]);
	assert.equal(planAffected({ fullSuite: true }).codingAgent, true);
	assert.equal(planAffected({ fullSuite: true }).check, true);
	assert.deepEqual(planAffected({ fullSuite: true }).os, ["ubuntu-latest", "windows-latest"]);
	assert.equal(planAffected({ fullSuite: true }).full, true);
});

test("a tui source commit also runs coding-agent, the workspace that imports tui", () => {
	const plan = planAffected({ paths: ["packages/tui/src/viewport-mode.ts"] });
	assert.equal(plan.full, false);
	assert.equal(plan.check, true);
	assert.deepEqual(plan.workspaces, ["packages/tui", "packages/coding-agent"]);
	assert.deepEqual(plan.nonCodingAgentWorkspaces, ["packages/tui"]);
	assert.deepEqual(plan.os, ["ubuntu-latest", "windows-latest"]);
	assert.equal(plan.codingAgent, true);
	assert.equal(plan.nativeProcess, false);
	assert.equal(plan.coverage, true);
	assert.equal(plan.longSession, true);
	assert.equal(plan.windowsIncident, true);
	assert.equal(plan.qualityJob, true);
});

test("a tui test-only commit does not pull coding-agent", () => {
	const plan = planAffected({ paths: ["packages/tui/test/viewport-mode.test.ts"] });
	assert.equal(plan.check, false);
	assert.deepEqual(plan.workspaces, ["packages/tui"]);
	assert.equal(plan.codingAgent, false);
	assert.deepEqual(plan.os, ["ubuntu-latest"]);
});

test("an agent source commit runs agent tests, native control, and coding-agent", () => {
	const plan = planAffected({ paths: ["packages/agent/src/agent-loop.ts"] });
	assert.equal(plan.check, true);
	assert.deepEqual(plan.workspaces, ["packages/agent", "packages/coding-agent"]);
	assert.deepEqual(plan.os, ["ubuntu-latest", "windows-latest"]);
	assert.equal(plan.codingAgent, true);
	assert.equal(plan.nativeProcess, true);
	assert.equal(plan.coverage, true);
	assert.equal(plan.windowsIncident, true);
});

test("an ai source commit runs ai, agent, and coding-agent", () => {
	const plan = planAffected({ paths: ["packages/ai/src/index.ts"] });
	assert.deepEqual(plan.workspaces, ["packages/ai", "packages/agent", "packages/coding-agent"]);
	assert.equal(plan.nativeProcess, true);
	assert.equal(plan.codingAgent, true);
	assert.equal(plan.check, true);
});

test("a coding-agent-only commit shards that workspace and skips tui/ai/agent tests", () => {
	const plan = planAffected({ paths: ["packages/coding-agent/src/core/agent-session.ts"] });
	assert.deepEqual(plan.workspaces, ["packages/coding-agent"]);
	assert.deepEqual(plan.nonCodingAgentWorkspaces, []);
	assert.equal(plan.codingAgent, true);
	assert.equal(plan.longSession, true);
	assert.equal(plan.windowsIncident, true);
	assert.equal(plan.nativeProcess, false);
	assert.deepEqual(plan.os, ["ubuntu-latest", "windows-latest"]);
});

test("docs-only and empty path lists buy no test jobs", () => {
	assert.deepEqual(planAffected({ paths: ["docs/index.md", "AGENTS.md", "packages/tui/CHANGELOG.md"] }).qualityJob, false);
	assert.equal(planAffected({ paths: [] }).qualityJob, false);
	assert.equal(planAffected({}).qualityJob, EMPTY_PLAN.qualityJob);
});

test("a Release metadata subject skips tests even when package.json is in the diff", () => {
	const plan = planAffected({
		paths: ["package.json", "packages/tui/package.json", "packages/tui/CHANGELOG.md"],
		subject: "Release v0.99.39",
	});
	assert.equal(plan.qualityJob, false);
	assert.equal(plan.codingAgent, false);
});

test("shared test-runner files buy the full matrix", () => {
	assert.equal(planAffected({ paths: [".github/workflows/ci.yml"] }).full, true);
	assert.equal(planAffected({ paths: ["scripts/ci-affected.mjs"] }).full, true);
	assert.equal(planAffected({ paths: ["test.sh"] }).full, true);
	assert.deepEqual(planAffected({ paths: ["scripts/run-workspace-tests.mjs"] }).os, [...FULL_PLAN.os]);
});

test("a lockfile or root package.json commit is Linux check-only", () => {
	for (const path of ["package-lock.json", "package.json", "biome.json"]) {
		const plan = planAffected({ paths: [path] });
		assert.equal(plan.full, false, path);
		assert.equal(plan.check, true, path);
		assert.equal(plan.qualityJob, true, path);
		assert.equal(plan.codingAgent, false, path);
		assert.deepEqual(plan.workspaces, [], path);
		assert.deepEqual(plan.os, ["ubuntu-latest"], path);
	}
});

test("a scripts-only change runs the Linux quality job with check and without workspace vitest", () => {
	const plan = planAffected({ paths: ["scripts/release.mjs"] });
	assert.equal(plan.qualityJob, true);
	assert.equal(plan.check, true);
	assert.deepEqual(plan.workspaces, []);
	assert.equal(plan.codingAgent, false);
	assert.deepEqual(plan.os, ["ubuntu-latest"]);
});

test("a single coding-agent TypeScript source change narrows to that file for vitest related", () => {
	const plan = planAffected({ paths: ["packages/coding-agent/src/core/agent-session.ts"] });
	assert.deepEqual(plan.codingAgentRelatedFiles, ["src/core/agent-session.ts"]);
	assert.deepEqual(codingAgentShards(plan), [1]);
});

test("a coding-agent test-file-only change also narrows (vitest related runs that exact file)", () => {
	const plan = planAffected({ paths: ["packages/coding-agent/test/agent-session-closure-surfaces.test.ts"] });
	assert.deepEqual(plan.codingAgentRelatedFiles, ["test/agent-session-closure-surfaces.test.ts"]);
});

test("multiple coding-agent TypeScript changes all narrow together", () => {
	const plan = planAffected({
		paths: ["packages/coding-agent/src/a.ts", "packages/coding-agent/src/b.mts"],
	});
	assert.deepEqual(plan.codingAgentRelatedFiles, ["src/a.ts", "src/b.mts"]);
});

test("a non-TypeScript coding-agent change (fixture/asset/python) disables narrowing", () => {
	for (const path of [
		"packages/coding-agent/test/fixtures/sample.json",
		"packages/coding-agent/src/bundled-resources/runtimes/pi-shell-engine/commands/foo.py",
		"packages/coding-agent/src/modes/interactive/assets/logo.png",
	]) {
		const plan = planAffected({ paths: [path, "packages/coding-agent/src/core/agent-session.ts"] });
		assert.equal(plan.codingAgentRelatedFiles, null, path);
		assert.deepEqual(codingAgentShards(plan), [1, 2, 3, 4], path);
	}
});

test("a change to coding-agent's own vitest config or setupFile disables narrowing", () => {
	for (const path of ["packages/coding-agent/vitest.config.ts", "packages/coding-agent/test/test-agent-dir-isolation-setup.ts"]) {
		const plan = planAffected({ paths: [path] });
		assert.equal(plan.codingAgentRelatedFiles, null, path);
	}
});

test("a producer (tui/ai/agent) source change disables coding-agent narrowing even alongside a local change", () => {
	const plan = planAffected({
		paths: ["packages/ai/src/index.ts", "packages/coding-agent/src/core/agent-session.ts"],
	});
	assert.equal(plan.codingAgentRelatedFiles, null);
	assert.deepEqual(plan.workspaces, ["packages/ai", "packages/agent", "packages/coding-agent"]);
});

test("a producer test-only or docs change does not disable coding-agent narrowing", () => {
	const plan = planAffected({
		paths: ["packages/tui/test/viewport-mode.test.ts", "packages/coding-agent/src/core/agent-session.ts"],
	});
	assert.deepEqual(plan.codingAgentRelatedFiles, ["src/core/agent-session.ts"]);
});

test("coding-agent pulled in only as a consumer (no direct coding-agent change) is not narrowed", () => {
	const plan = planAffected({ paths: ["packages/agent/src/agent-loop.ts"] });
	assert.equal(plan.codingAgentRelatedFiles, null);
});

test("full suite and empty/doc-only plans never narrow", () => {
	assert.equal(FULL_PLAN.codingAgentRelatedFiles, null);
	assert.equal(EMPTY_PLAN.codingAgentRelatedFiles, null);
	assert.equal(planAffected({ fullSuite: true }).codingAgentRelatedFiles, null);
	assert.equal(planAffected({ paths: [] }).codingAgentRelatedFiles, null);
});

test("codingAgentRelatedFiles is a pure helper independent of workspace selection", () => {
	assert.deepEqual(codingAgentRelatedFiles(["packages/coding-agent/src/x.ts"]), ["src/x.ts"]);
	assert.equal(codingAgentRelatedFiles(["packages/coding-agent/src/x.js"]), null);
	assert.equal(codingAgentRelatedFiles(["packages/tui/src/y.ts"]), null);
});

test("enrichWithScanIncludes adds a scan hit to an already-narrowed plan, deduped", () => {
	const plan = { codingAgentRelatedFiles: ["src/x.ts"] };
	const scan = (changed) => {
		assert.deepEqual(changed, ["packages/coding-agent/src/x.ts"]);
		return ["test/reads-x-as-text.test.ts", "src/x.ts" /* would-be duplicate, must be deduped */];
	};
	assert.deepEqual(enrichWithScanIncludes(plan, scan), { codingAgentRelatedFiles: ["src/x.ts", "test/reads-x-as-text.test.ts"] });
});

test("enrichWithScanIncludes never calls scan and returns the plan unchanged when narrowing does not apply", () => {
	const plan = { codingAgentRelatedFiles: null, full: true };
	const scan = () => {
		throw new Error("scan must not run on a full-suite plan");
	};
	assert.deepEqual(enrichWithScanIncludes(plan, scan), plan);
});

test("enrichWithScanIncludes leaves the plan unchanged (same shape) when the scan finds nothing new", () => {
	const plan = { codingAgentRelatedFiles: ["src/x.ts"] };
	assert.deepEqual(enrichWithScanIncludes(plan, () => []), plan);
});

test("parseCarriedFiles accepts the { full: false, files } shape and filters non-string entries", () => {
	assert.deepEqual(parseCarriedFiles('{"full":false,"files":["packages/coding-agent/test/a.test.ts"]}'), {
		full: false,
		files: ["packages/coding-agent/test/a.test.ts"],
	});
	assert.deepEqual(parseCarriedFiles('{"full":false,"files":[]}'), { full: false, files: [] });
	assert.deepEqual(parseCarriedFiles('{"full":false,"files":[1,"packages/coding-agent/test/a.test.ts",null]}'), {
		full: false,
		files: ["packages/coding-agent/test/a.test.ts"],
	});
});

test("parseCarriedFiles treats absent/empty input as nothing to carry, not a failure", () => {
	// The carry-forward step only runs on push-to-main; every other event leaves this env var
	// empty, which must read as "ordinary diff-based plan", not "fail closed to full".
	assert.deepEqual(parseCarriedFiles(undefined), { full: false, files: [] });
	assert.deepEqual(parseCarriedFiles(""), { full: false, files: [] });
});

test("parseCarriedFiles honors an explicit { full: true, reason } marker", () => {
	assert.deepEqual(parseCarriedFiles('{"full":true,"reason":"job X failed"}'), { full: true, reason: "job X failed" });
	assert.deepEqual(parseCarriedFiles('{"full":true}'), { full: true, reason: "carry-forward requested the full suite" });
});

test("parseCarriedFiles fails closed to full on any unrecognized or malformed shape", () => {
	for (const raw of ["not json", '{"not":"a recognized shape"}', "[]", '["packages/coding-agent/test/a.test.ts"]', "null", "42", '"full"']) {
		const result = parseCarriedFiles(raw);
		assert.equal(result.full, true, raw);
		assert.equal(typeof result.reason, "string", raw);
	}
});

test("a carried-forward failed coding-agent test file joins narrowing alongside the diff", () => {
	const plan = planAffected({
		paths: ["packages/coding-agent/src/core/agent-session.ts", "packages/coding-agent/test/some-other.test.ts"],
	});
	assert.deepEqual(plan.codingAgentRelatedFiles, ["src/core/agent-session.ts", "test/some-other.test.ts"]);
});

test("the CLI forces the full suite when carry-forward reports { full: true }", () => {
	const output = execFileSync(process.execPath, [fileURLToPath(new URL("./ci-affected.mjs", import.meta.url))], {
		encoding: "utf8",
		env: {
			...process.env,
			CI_FULL_SUITE: "",
			CI_EVENT_NAME: "push",
			CI_BEFORE: "HEAD",
			CI_CARRIED_FILES: '{"full":true,"reason":"a non-coding-agent job failed"}',
		},
	});
	const plan = JSON.parse(output);
	assert.equal(plan.full, true);
	assert.equal(plan.codingAgentRelatedFiles, null);
	assert.deepEqual(plan.os, ["ubuntu-latest", "windows-latest"]);
});

test("the CLI runs an ordinary diff-based plan when carry-forward reports nothing to carry", () => {
	const output = execFileSync(process.execPath, [fileURLToPath(new URL("./ci-affected.mjs", import.meta.url))], {
		encoding: "utf8",
		env: {
			...process.env,
			CI_FULL_SUITE: "",
			CI_EVENT_NAME: "push",
			CI_BEFORE: "HEAD",
			CI_CARRIED_FILES: '{"full":false,"files":[]}',
		},
	});
	const plan = JSON.parse(output);
	assert.equal(plan.full, false);
});

test("listChangedFiles uses the PR merge-base range, then the push before..HEAD, then HEAD~1", () => {
	const ranges = [];
	const read = (range) => {
		ranges.push(range);
		return ["packages/tui/src/a.ts"];
	};
	assert.deepEqual(
		listChangedFiles({ eventName: "pull_request", baseSha: "abc", before: "def" }, read),
		["packages/tui/src/a.ts"],
	);
	assert.deepEqual(listChangedFiles({ eventName: "push", before: "def" }, read), ["packages/tui/src/a.ts"]);
	assert.deepEqual(listChangedFiles({ eventName: "push", before: "0".repeat(40) }, read), ["packages/tui/src/a.ts"]);
	assert.deepEqual(ranges, ["abc...HEAD", "def...HEAD", "HEAD~1...HEAD"]);
});
