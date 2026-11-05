import assert from "node:assert/strict";
import { test } from "node:test";
import { GithubActionsCiProvider } from "../packages/coding-agent/src/host/ci/github-actions-ci-provider.ts";
import { commitObligation, prePushTargets } from "./ci-status.mjs";

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

test("the decisive run is the newest exact attempt regardless of conclusion", async () => {
	const sha = "a".repeat(40);
	const base = "repos/harness/repository";
	for (const [status, conclusion] of [["completed", "failure"], ["in_progress", null], ["completed", "cancelled"]]) {
		const run = (id, runNumber, state, result) => ({
			id, run_number: runNumber, run_attempt: 1, status: state, conclusion: result,
			head_sha: sha, workflow_id: 601, repository: { id: 501 },
			html_url: `https://github.com/harness/repository/actions/runs/${id}`,
		});
		const earlier = run(701, 1, "completed", "success");
		const latest = run(702, 2, status, conclusion);
		const responses = new Map([
			[base, { id: 501 }],
			[`${base}/actions/workflows/ci.yml`, { id: 601, path: ".github/workflows/ci.yml" }],
			[`${base}/actions/workflows/601/runs?head_sha=${sha}&per_page=100`, { total_count: 2, workflow_runs: [latest, earlier] }],
			[`${base}/actions/runs/701/attempts/1`, earlier],
			[`${base}/actions/runs/702/attempts/1`, latest],
		]);
		const provider = new GithubActionsCiProvider({ run: async (executable, args) => {
			assert.equal(executable, "gh");
			if (args[0] === "repo") return JSON.stringify({ nameWithOwner: "harness/repository", url: "https://github.com/harness/repository" });
			assert.equal(args[0], "api");
			assert.ok(responses.has(args.at(-1)), `Unexpected CI endpoint: ${args.at(-1)}`);
			return JSON.stringify(responses.get(args.at(-1)));
		} });
		const collected = await provider.collect(sha, new AbortController().signal);
		assert.equal(collected.current.runId, 702);
		assert.equal(collected.current.status, status);
		assert.equal(collected.current.conclusion, conclusion ?? undefined);
		assert.equal(collected.events.find((event) => event.identity.runId === 701).conclusion, "success");
	}
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
