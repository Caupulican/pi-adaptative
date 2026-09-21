import assert from "node:assert/strict";
import test from "node:test";
import { EMPTY_PLAN, FULL_PLAN, isReleaseMetadataSubject, listChangedFiles, planAffected, workspaceOf } from "./ci-affected.mjs";
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
