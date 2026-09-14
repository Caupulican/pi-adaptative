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
	assert.equal(hasCompleteCiMatrix(Array.from({ length: 8 }, () => complete[2])), false);
});

test("proof binds successful runs to the requested SHA and examines the complete jobs from one run", () => {
	const sha = "a".repeat(40);
	const complete = completeCiJobs();
	const run = { headSha: sha, databaseId: 1, status: "completed", conclusion: "success" };
	const calls = [];
	const read = (command, args) => {
		calls.push([command, args]);
		return JSON.stringify(args[1] === "list" ? [{ ...run, databaseId: 2 }, run] : { jobs: args[2] === "1" ? complete : complete.slice(0, 2) });
	};
	assert.equal(requireCiProof(sha, "owner/repo", read), 1);
	assert.equal(calls.length, 3);
	for (const bad of [{ headSha: "b".repeat(40) }, { status: "in_progress" }, { conclusion: "failure" }]) {
		assert.throws(() => requireCiProof(sha, "owner/repo", (_command, args) => JSON.stringify(args[1] === "list" ? [{ ...run, ...bad }] : { jobs: complete })), /complete/);
	}
});

test("metadata candidates inherit only a parent proven equivalent by the shared diff gate", () => {
	const release = "a".repeat(40);
	const parent = "b".repeat(40);
	for (const subject of ["Release v1.0.1", "Repair release v1.0.1", "Actual source change"]) {
		let diffChecked = false;
		const read = (command, args) => {
			if (command === "git") return args[0] === "show" ? subject : parent;
			if (command === process.execPath) { diffChecked = true; assert.deepEqual(args.slice(1), [parent, release]); return ""; }
			const expected = subject === "Actual source change" ? release : parent;
			if (args[1] === "list") {
				assert.equal(args[args.indexOf("--commit") + 1], expected);
				assert.equal(diffChecked, expected === parent);
				return JSON.stringify([{ headSha: expected, databaseId: 1, status: "completed", conclusion: "success" }]);
			}
			return JSON.stringify({ jobs: completeCiJobs() });
		};
		assert.equal(requireReleaseCiProof(release, "owner/repo", read), 1);
	}
	assert.throws(() => requireReleaseCiProof(release, "owner/repo", (command, args) => {
		if (command === "git") return args[0] === "show" ? "Release v1.0.1" : parent;
		throw new Error("untested production change");
	}), /untested production/);
});
