import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	collectChangedPaths,
	computeReleaseAllowlist,
	parsePorcelainPath,
	partitionReleaseChanges,
	pickWorkflowConclusion,
} from "./release-staging.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

test("unstaged porcelain keeps the leading space so the path is not sliced", () => {
	assert.equal(parsePorcelainPath(" M package-lock.json"), "package-lock.json");
	assert.equal(parsePorcelainPath(" M packages/agent/CHANGELOG.md"), "packages/agent/CHANGELOG.md");
});

test("staged porcelain still parses the path after the XY prefix", () => {
	assert.equal(parsePorcelainPath("M  package-lock.json"), "package-lock.json");
	assert.equal(parsePorcelainPath("A  packages/agent/package.json"), "packages/agent/package.json");
});

test("collectChangedPaths does not trim the porcelain prefix", () => {
	const paths = collectChangedPaths(" M package-lock.json\n M packages/agent/CHANGELOG.md\n");
	assert.deepEqual(paths, ["package-lock.json", "packages/agent/CHANGELOG.md"]);
});

test("lockstep workspace package files are on the release allowlist", () => {
	const allowlist = computeReleaseAllowlist(repoRoot);
	assert.ok(allowlist.has("package-lock.json"));
	assert.ok(allowlist.has(join("packages", "agent", "CHANGELOG.md")));
	assert.ok(allowlist.has(join("packages", "coding-agent", "examples", "extensions", "sandbox", "package.json")));
});

test("partitionReleaseChanges accepts a typical unstaged version-bump tree", () => {
	const status = [
		" M package-lock.json",
		" M packages/agent/CHANGELOG.md",
		" M packages/agent/package.json",
		" M packages/coding-agent/examples/extensions/sandbox/package.json",
	].join("\n");
	const { allowed, unexpected } = partitionReleaseChanges(status, repoRoot);
	assert.equal(unexpected.length, 0);
	assert.equal(allowed.length, 4);
});

test("pickWorkflowConclusion prefers success over a cancelled run on the same SHA", () => {
	const sha = "abc";
	assert.deepEqual(
		pickWorkflowConclusion(
			[
				{ headSha: sha, status: "completed", conclusion: "cancelled" },
				{ headSha: sha, status: "completed", conclusion: "success" },
			],
			sha,
		),
		{ state: "completed", conclusion: "success" },
	);
	assert.deepEqual(
		pickWorkflowConclusion([{ headSha: sha, status: "in_progress", conclusion: null }], sha),
		{ state: "pending", status: "in_progress" },
	);
});
