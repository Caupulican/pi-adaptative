import assert from "node:assert/strict";
import { test } from "node:test";
import { commitObligation, failingTestsFromReports, pickDecisiveRun, prePushTargets } from "./ci-status.mjs";

test("pre-push watches pushed branch heads, not deletions or tags", () => {
	assert.deepEqual(
		prePushTargets(
			[
				"refs/heads/main 1111111111111111111111111111111111111111 refs/heads/main 2222222222222222222222222222222222222222",
				"refs/heads/gone 0000000000000000000000000000000000000000 refs/heads/gone 3333333333333333333333333333333333333333",
				"refs/tags/v1 4444444444444444444444444444444444444444 refs/tags/v1 0000000000000000000000000000000000000000",
				"",
			].join("\n"),
		),
		[{ sha: "1111111111111111111111111111111111111111", branch: "main" }],
	);
});

test("the decisive run: a success wins, then a running run, then the newest non-cancelled result", () => {
	const sha = "abc";
	const run = (id, status, conclusion, createdAt) => ({ databaseId: id, headSha: sha, status, conclusion, createdAt });
	assert.equal(pickDecisiveRun([run(1, "completed", "failure", "1"), run(2, "completed", "success", "2")], sha).databaseId, 2);
	assert.equal(pickDecisiveRun([run(1, "completed", "cancelled", "2"), run(2, "in_progress", "", "3")], sha).databaseId, 2);
	assert.equal(pickDecisiveRun([run(1, "completed", "failure", "1"), run(2, "completed", "cancelled", "2")], sha).databaseId, 1);
	assert.equal(pickDecisiveRun([run(1, "completed", "success", "1")], "other"), undefined);
});

test("failing test files come from the vitest reports, per platform, repo-relative", () => {
	const report = (paths) => ({ testResults: paths.map(([name, status]) => ({ name, status })) });
	assert.deepEqual(
		failingTestsFromReports([
			{
				artifact: "test-report-coding-agent-ubuntu-latest-2",
				report: report([
					["/home/runner/work/r/r/packages/coding-agent/test/a.test.ts", "failed"],
					["/home/runner/work/r/r/packages/coding-agent/test/ok.test.ts", "passed"],
				]),
			},
			{
				artifact: "test-report-coding-agent-windows-latest-1",
				report: report([["D:\\a\\r\\r\\packages\\coding-agent\\test\\a.test.ts", "failed"]]),
			},
		]),
		[{ workspace: "packages/coding-agent", file: "test/a.test.ts", platforms: ["ubuntu", "windows"] }],
	);
});

test("a commit carries a red verdict only for its own history", () => {
	const red = {
		sha: "abc",
		state: "completed",
		conclusion: "failure",
		failedJobs: ["Coding-agent test (ubuntu-latest, shard 2/4)", "Build, check, test (ubuntu-latest)"],
		failingTests: [{ workspace: "packages/coding-agent", file: "test/a.test.ts", platforms: ["ubuntu"] }],
	};
	assert.deepEqual(commitObligation(red, () => true), {
		kind: "red",
		status: red,
		tests: red.failingTests,
		untestedFailures: ["Build, check, test (ubuntu-latest)"],
	});
	assert.equal(commitObligation(red, () => false).kind, "none");
	assert.equal(commitObligation({ ...red, conclusion: "success" }, () => true).kind, "none");
	assert.equal(commitObligation({ sha: "abc", state: "pending" }, () => true).kind, "pending");
	assert.equal(commitObligation(undefined, () => true).kind, "none");
	// Without reports, every failed job stays an open failure rather than silently passing.
	assert.deepEqual(commitObligation({ ...red, failingTests: [] }, () => true).untestedFailures, red.failedJobs);
});
