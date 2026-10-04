import assert from "node:assert/strict";
import test from "node:test";
import { hasCompleteCiMatrix, requireCiProof, requireReleaseCiProof } from "./release-ci-proof.mjs";

import { completeCiJobs } from "./test-fixtures/release-ci-jobs.mjs";

test("full matrix proof rejects each missing, duplicate, pending or skipped job and skipped test step", () => {
	const complete = completeCiJobs();
	assert.equal(hasCompleteCiMatrix(complete), true);
	for (let index = 0; index < complete.length; index++) {
		assert.equal(hasCompleteCiMatrix(complete.filter((_, i) => i !== index)), false);
		assert.equal(hasCompleteCiMatrix([...complete, complete[index]]), false);
		for (const patch of [{ status: "in_progress" }, { conclusion: "skipped" }, { steps: [] }]) {
			assert.equal(hasCompleteCiMatrix(complete.map((job, i) => i === index ? { ...job, ...patch } : job)), false);
		}
	}
	assert.equal(hasCompleteCiMatrix(Array.from({ length: 2 }, () => complete[0])), false);
});

test("proof binds successful runs to the requested SHA and examines the complete jobs from one run", () => {
	const sha = "a".repeat(40);
	const complete = completeCiJobs();
	const run = { headSha: sha, databaseId: 1, status: "completed", conclusion: "success" };
	const calls = [];
	const read = (command, args) => {
		calls.push([command, args]);
		return JSON.stringify(args[1] === "list" ? [{ ...run, databaseId: 2 }, run] : { jobs: args[2] === "1" ? complete : complete.slice(0, 1) });
	};
	assert.equal(requireCiProof(sha, "owner/repo", read), 1);
	assert.equal(calls.length, 3);
	for (const bad of [{ headSha: "b".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" }]) {
		assert.throws(() => requireCiProof(sha, "owner/repo", (_command, args) => JSON.stringify(args[1] === "list" ? [{ ...run, ...bad }] : { jobs: complete })), /complete/);
	}
});

test("release proof accepts the tag workflow quality-gate jobs when ci.yml has no run", () => {
	const sha = "c".repeat(40);
	const jobs = completeCiJobs().map((job) => ({ ...job, name: `quality-gate / ${job.name}` }));
	const calls = [];
	const read = (_command, args) => {
		calls.push(args[1]);
		if (args[1] === "view") return JSON.stringify({ headSha: sha, jobs });
		return JSON.stringify([]);
	};
	assert.equal(requireCiProof(sha, "owner/repo", read, "99"), 99);
	assert.deepEqual(calls, ["view"]);
});

test("a caller run for another SHA is not proof and an empty ci.yml list still fails", () => {
	const sha = "c".repeat(40);
	const read = (_command, args) => JSON.stringify(args[1] === "view"
		? { headSha: "d".repeat(40), jobs: completeCiJobs() }
		: []);
	assert.throws(() => requireCiProof(sha, "owner/repo", read, "99"), /complete/);
});

test("release proof examines the exact tagged SHA", () => {
	const sha = "a".repeat(40);
	const complete = completeCiJobs();
	const read = (command, args) => {
		assert.equal(command, "gh");
		if (args[1] === "list") {
			assert.equal(args[args.indexOf("--commit") + 1], sha);
			return JSON.stringify([{ headSha: sha, databaseId: 1, status: "completed", conclusion: "success" }]);
		}
		return JSON.stringify({ jobs: complete });
	};
	assert.equal(requireReleaseCiProof(sha, "owner/repo", read), 1);
});
