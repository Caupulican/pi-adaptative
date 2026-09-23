import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	classifyFailedRunJobs,
	codingAgentReportArtifactName,
	fetchCarryForward,
	matchCodingAgentJob,
	parseFailedTestFiles,
	selectCarryForwardRun,
} from "./ci-carry-forward.mjs";

const CI_YML_PATH = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

// GitHub Actions expression placeholders this test knows how to render. Extend this map (and the
// combinations tested below) if ci.yml's templates ever gain another variable.
function renderTemplate(template, { os, shard, shardCount }) {
	return template
		.replaceAll("${{ matrix.os }}", os)
		.replaceAll("${{ matrix.shard }}", String(shard))
		.replaceAll("${{ needs.plan.outputs.coding_agent_shard_count }}", String(shardCount));
}

function extractTemplate(yaml, prefix, label) {
	const pattern = new RegExp(`^\\s*name: (${prefix}[^\\n]+)\\s*$`, "mu");
	const match = pattern.exec(yaml);
	if (!match) throw new Error(`${label} template not found in ci.yml`);
	return match[1];
}

// (shard, shardCount) pairs the plan can actually emit: narrowed collapses to a single shard
// "1/1" (see codingAgentShards in ci-affected.mjs); unnarrowed is the full "N/4" sharded matrix.
const SHARD_COMBINATIONS = [
	[1, 1],
	[1, 4],
	[2, 4],
	[3, 4],
	[4, 4],
];

test("parseFailedTestFiles keeps only failed entries, as repo-relative coding-agent paths", () => {
	const report = {
		testResults: [
			{ name: "/home/runner/work/pi-adaptative/pi-adaptative/packages/coding-agent/test/a.test.ts", status: "passed" },
			{ name: "/home/runner/work/pi-adaptative/pi-adaptative/packages/coding-agent/test/b.test.ts", status: "failed" },
			{ name: "D:\\a\\pi-adaptative\\pi-adaptative\\packages\\coding-agent\\test\\c.test.ts", status: "failed" },
		],
	};
	assert.deepEqual(parseFailedTestFiles(report), ["packages/coding-agent/test/b.test.ts", "packages/coding-agent/test/c.test.ts"]);
});

test("parseFailedTestFiles dedupes and ignores malformed or non-coding-agent entries", () => {
	const report = {
		testResults: [
			{ name: "/x/packages/coding-agent/test/b.test.ts", status: "failed" },
			{ name: "/x/packages/coding-agent/test/b.test.ts", status: "failed" },
			{ name: "/x/packages/agent/test/other.test.ts", status: "failed" },
			{ status: "failed" },
			{ name: 42, status: "failed" },
		],
	};
	assert.deepEqual(parseFailedTestFiles(report), ["packages/coding-agent/test/b.test.ts"]);
});

test("parseFailedTestFiles tolerates a missing or malformed report", () => {
	assert.deepEqual(parseFailedTestFiles({}), []);
	assert.deepEqual(parseFailedTestFiles(undefined), []);
	assert.deepEqual(parseFailedTestFiles({ testResults: "not an array" }), []);
});

test("selectCarryForwardRun returns the newest run other than the excluded (current) one", () => {
	const runs = [
		{ databaseId: 3, conclusion: "success" },
		{ databaseId: 2, conclusion: "failure" },
		{ databaseId: 1, conclusion: "failure" },
	];
	assert.deepEqual(selectCarryForwardRun(runs, { excludeRunId: 3 }), { databaseId: 2, conclusion: "failure" });
	assert.deepEqual(selectCarryForwardRun(runs, { excludeRunId: "3" }), { databaseId: 2, conclusion: "failure" });
	assert.equal(selectCarryForwardRun([], { excludeRunId: 3 }), undefined);
});

test("matchCodingAgentJob parses the (os, shard) out of the job name, ignoring the shard-count denominator", () => {
	assert.deepEqual(matchCodingAgentJob("Coding-agent test (ubuntu-latest, shard 1/4)"), { os: "ubuntu-latest", shard: "1" });
	assert.deepEqual(matchCodingAgentJob("Coding-agent test (windows-latest, shard 1/1)"), { os: "windows-latest", shard: "1" });
	assert.equal(matchCodingAgentJob("Build, check, test (ubuntu-latest)"), null);
	assert.equal(matchCodingAgentJob("Plan affected tests"), null);
	assert.equal(matchCodingAgentJob(undefined), null);
});

// These two tests read ci.yml itself rather than hardcoding a copy of its templates: they render
// the coding-agent-test job's actual `name:` template and the actual upload-artifact `name:`
// template for every (os, shard) combination the plan can emit, and check them against
// matchCodingAgentJob / codingAgentReportArtifactName. Editing either template in ci.yml without
// updating the matching function in ci-carry-forward.mjs fails one of these, instead of silently
// drifting until a real failed run goes unrecognized in production.
test("the coding-agent-test job's name: template in ci.yml renders to something matchCodingAgentJob parses back exactly", () => {
	const yaml = readFileSync(CI_YML_PATH, "utf8");
	const template = extractTemplate(yaml, "Coding-agent test \\(", "coding-agent-test job name");
	for (const os of ["ubuntu-latest", "windows-latest"]) {
		for (const [shard, shardCount] of SHARD_COMBINATIONS) {
			const rendered = renderTemplate(template, { os, shard, shardCount });
			assert.deepEqual(matchCodingAgentJob(rendered), { os, shard: String(shard) }, rendered);
		}
	}
});

test("the upload-artifact name: template in ci.yml renders to exactly what codingAgentReportArtifactName builds", () => {
	const yaml = readFileSync(CI_YML_PATH, "utf8");
	const template = extractTemplate(yaml, "test-report-coding-agent-", "test-report-coding-agent artifact name");
	for (const os of ["ubuntu-latest", "windows-latest"]) {
		for (const [shard, shardCount] of SHARD_COMBINATIONS) {
			const rendered = renderTemplate(template, { os, shard, shardCount });
			assert.equal(rendered, codingAgentReportArtifactName(os, String(shard)), rendered);
		}
	}
});

test("classifyFailedRunJobs fails closed when a non-coding-agent job did not conclude cleanly", () => {
	const jobs = [
		{ name: "Plan affected tests", conclusion: "success" },
		{ name: "Build, check, test (ubuntu-latest)", conclusion: "failure" },
		{ name: "Coding-agent test (ubuntu-latest, shard 1/4)", conclusion: "success" },
	];
	assert.deepEqual(classifyFailedRunJobs(jobs), { kind: "full", reason: 'job "Build, check, test (ubuntu-latest)" concluded "failure"' });
});

test("classifyFailedRunJobs fails closed on a non-coding-agent job that was cancelled or timed out", () => {
	for (const conclusion of ["cancelled", "timed_out", "action_required", "stale", "neutral"]) {
		const jobs = [{ name: "Build, check, test (windows-latest)", conclusion }];
		assert.equal(classifyFailedRunJobs(jobs).kind, "full", conclusion);
	}
});

test("classifyFailedRunJobs fails closed when nothing concluded uncleanly at all", () => {
	const jobs = [
		{ name: "Plan affected tests", conclusion: "success" },
		{ name: "Build, check, test (ubuntu-latest)", conclusion: "success" },
	];
	assert.equal(classifyFailedRunJobs(jobs).kind, "full");
});

test("classifyFailedRunJobs returns exactly the non-clean coding-agent-test jobs when nothing else failed", () => {
	const jobs = [
		{ name: "Plan affected tests", conclusion: "success" },
		{ name: "Build, check, test (ubuntu-latest)", conclusion: "success" },
		{ name: "Build, check, test (windows-latest)", conclusion: "success" },
		{ name: "Coding-agent test (ubuntu-latest, shard 1/4)", conclusion: "success" },
		{ name: "Coding-agent test (ubuntu-latest, shard 2/4)", conclusion: "failure" },
		{ name: "Coding-agent test (windows-latest, shard 3/4)", conclusion: "cancelled" },
	];
	assert.deepEqual(classifyFailedRunJobs(jobs), {
		kind: "jobs",
		jobs: [
			{ os: "ubuntu-latest", shard: "2" },
			{ os: "windows-latest", shard: "3" },
		],
	});
});

function deps(overrides = {}) {
	return {
		repo: "o/r",
		excludeRunId: 10,
		runGh: () => {
			throw new Error("unexpected runGh call");
		},
		viewJobs: () => {
			throw new Error("unexpected viewJobs call");
		},
		listArtifacts: () => {
			throw new Error("unexpected listArtifacts call");
		},
		downloadReport: () => {
			throw new Error("unexpected downloadReport call");
		},
		...overrides,
	};
}

test("fetchCarryForward carries nothing when there is no previous run", async () => {
	const result = await fetchCarryForward(deps({ runGh: () => JSON.stringify([]) }));
	assert.deepEqual(result, { full: false, files: [] });
});

test("fetchCarryForward carries nothing when the previous run succeeded", async () => {
	const result = await fetchCarryForward(deps({ runGh: () => JSON.stringify([{ databaseId: 9, conclusion: "success" }]) }));
	assert.deepEqual(result, { full: false, files: [] });
});

test("fetchCarryForward fails closed when a non-coding-agent job failed", async () => {
	const result = await fetchCarryForward(
		deps({
			runGh: () => JSON.stringify([{ databaseId: 9, conclusion: "failure" }]),
			viewJobs: () => [
				{ name: "Build, check, test (ubuntu-latest)", conclusion: "failure" },
				{ name: "Coding-agent test (ubuntu-latest, shard 1/4)", conclusion: "success" },
			],
		}),
	);
	assert.equal(result.full, true);
	assert.match(result.reason, /Build, check, test/);
});

test("fetchCarryForward fails closed when a failed coding-agent job has no matching artifact", async () => {
	const result = await fetchCarryForward(
		deps({
			runGh: () => JSON.stringify([{ databaseId: 9, conclusion: "failure" }]),
			viewJobs: () => [{ name: "Coding-agent test (ubuntu-latest, shard 1/4)", conclusion: "failure" }],
			listArtifacts: () => [{ id: 1, name: "release-binaries" }],
		}),
	);
	assert.equal(result.full, true);
	assert.match(result.reason, /no test report artifact/);
});

test("fetchCarryForward fails closed when the matching artifact's report lists no failed tests", async () => {
	// e.g. the shard's own tests passed but a later step in the same job (the Windows shell
	// corpus wall) failed, so the job is red but the uploaded report shows nothing wrong.
	const result = await fetchCarryForward(
		deps({
			runGh: () => JSON.stringify([{ databaseId: 9, conclusion: "failure" }]),
			viewJobs: () => [{ name: "Coding-agent test (windows-latest, shard 1/4)", conclusion: "failure" }],
			listArtifacts: () => [{ id: 101, name: "test-report-coding-agent-windows-latest-1" }],
			downloadReport: () => [{ testResults: [{ name: "/x/packages/coding-agent/test/a.test.ts", status: "passed" }] }],
		}),
	);
	assert.equal(result.full, true);
	assert.match(result.reason, /lists no failed tests/);
});

test("fetchCarryForward fails closed when downloading or parsing an artifact throws", async () => {
	await assert.rejects(
		fetchCarryForward(
			deps({
				runGh: () => JSON.stringify([{ databaseId: 9, conclusion: "failure" }]),
				viewJobs: () => [{ name: "Coding-agent test (ubuntu-latest, shard 1/4)", conclusion: "failure" }],
				listArtifacts: () => [{ id: 101, name: "test-report-coding-agent-ubuntu-latest-1" }],
				downloadReport: () => {
					throw new Error("unzip failed");
				},
			}),
		),
		/unzip failed/,
	);
});

test("fetchCarryForward carries exactly the failed test files when every failed coding-agent job has a verified report", async () => {
	const result = await fetchCarryForward(
		deps({
			runGh: () => JSON.stringify([{ databaseId: 9, conclusion: "failure" }]),
			viewJobs: () => [
				{ name: "Build, check, test (ubuntu-latest)", conclusion: "success" },
				{ name: "Build, check, test (windows-latest)", conclusion: "success" },
				{ name: "Coding-agent test (ubuntu-latest, shard 1/4)", conclusion: "failure" },
				{ name: "Coding-agent test (windows-latest, shard 2/4)", conclusion: "failure" },
			],
			listArtifacts: () => [
				{ id: 101, name: "test-report-coding-agent-ubuntu-latest-1" },
				{ id: 102, name: "test-report-coding-agent-windows-latest-2" },
			],
			downloadReport: (id) => {
				const byId = {
					101: [{ testResults: [{ name: "/x/packages/coding-agent/test/a.test.ts", status: "failed" }] }],
					102: [{ testResults: [{ name: "/x/packages/coding-agent/test/b.test.ts", status: "failed" }] }],
				};
				return byId[id];
			},
		}),
	);
	assert.equal(result.full, false);
	assert.deepEqual(result.files.sort(), ["packages/coding-agent/test/a.test.ts", "packages/coding-agent/test/b.test.ts"]);
});

test("fetchCarryForward propagates a run-list lookup error to the caller (CLI fails closed on it)", async () => {
	await assert.rejects(
		fetchCarryForward(
			deps({
				runGh: () => {
					throw new Error("gh: network error");
				},
			}),
		),
		/network error/,
	);
});
