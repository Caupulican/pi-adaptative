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

test("release proof rejects omitted or unsuccessful native process controls on either operating system", () => {
	const stepName = "Test native process-tree control alone";
	const complete = completeCiJobs().map((job) => job.name.startsWith("Build, check, test")
		? { ...job, steps: [...job.steps.filter((step) => step.name !== stepName), { name: stepName, conclusion: "success" }] }
		: job);
	assert.equal(hasCompleteCiMatrix(complete), true);
	for (const os of ["ubuntu-latest", "windows-latest"]) {
		for (const conclusion of [undefined, "skipped", "failure", "cancelled"]) {
			const jobs = complete.map((job) => job.name === `Build, check, test (${os})`
				? { ...job, steps: job.steps.flatMap((step) => step.name !== stepName ? [step] : conclusion ? [{ ...step, conclusion }] : []) }
				: job);
			assert.equal(hasCompleteCiMatrix(jobs), false, `${os} native control ${conclusion ?? "omitted"}`);
		}
	}
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
