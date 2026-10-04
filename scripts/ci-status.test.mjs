import assert from "node:assert/strict";
import { test } from "node:test";
import { commitObligation, pickDecisiveRun, prePushTargets } from "./ci-status.mjs";

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

test("a commit reports a red verdict only for its own history", () => {
	const red = {
		sha: "abc",
		state: "completed",
		conclusion: "failure",
		failedJobs: ["Build, check (ubuntu-latest)"],
	};
	assert.deepEqual(commitObligation(red, () => true), { kind: "red", status: red, failedJobs: red.failedJobs });
	assert.equal(commitObligation(red, () => false).kind, "none");
	assert.equal(commitObligation({ ...red, conclusion: "success" }, () => true).kind, "none");
	assert.equal(commitObligation({ sha: "abc", state: "pending" }, () => true).kind, "pending");
	assert.equal(commitObligation(undefined, () => true).kind, "none");
});
