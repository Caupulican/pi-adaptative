#!/usr/bin/env node
/**
 * Failure carry-forward for the coding-agent workspace.
 *
 * When the previous push-to-main CI run failed, its coding-agent test jobs uploaded their own
 * `--reporter=json` output as a `test-report-coding-agent-<os>-<shard>` artifact (see ci.yml).
 * This script reads that real report — never guesses or replays a log — and returns the exact
 * failed test files so the next push runs them again, in addition to whatever its own diff
 * already selects, until a run on main is green.
 *
 * Fails CLOSED, not open: this script's only job is to tell the caller whether it is safe to
 * narrow at all. It returns `{ full: false, files: [...] }` (possibly an empty list, meaning
 * "nothing to carry") only when it can prove the previous run's failure is fully accounted for by
 * coding-agent-test jobs that each produced a report naming real failed tests. Anything else —
 * a non-coding-agent job in a non-clean state, a coding-agent job with no/unreadable/empty
 * report, a malformed run/job/artifact shape, or any lookup error — returns
 * `{ full: true, reason: "..." }`. The caller (ci-affected.mjs) must run the complete suite in
 * that case: a narrowed run that silently drops an unaccounted-for failure is exactly the
 * regression this feature exists to prevent, in reverse.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Job/run conclusions that are NOT "nothing to worry about". `success` (and, for a whole run,
// "no previous run at all") are the only conclusions that carry nothing forward; every other
// conclusion (including ones we may never have seen in practice, like `stale`) must be treated as
// evidence of an unresolved problem until proven otherwise.
const NOT_CLEAN_CONCLUSIONS = new Set(["failure", "cancelled", "timed_out", "action_required", "stale", "neutral"]);

// Must stay in sync with the coding-agent-test job's `name:` template in ci.yml
// ("Coding-agent test (${{ matrix.os }}, shard ${{ matrix.shard }}/${{
// needs.plan.outputs.coding_agent_shard_count }})") — ci-carry-forward.test.mjs renders that
// template out of ci.yml itself and checks it against this regex, so an edit to one side without
// the other fails the test instead of silently drifting.
const CODING_AGENT_JOB_NAME = /^Coding-agent test \(([^,]+), shard (\d+)\/\d+\)$/u;

/** Repo-relative failed test file paths from one vitest `--reporter=json` report object. */
export function parseFailedTestFiles(report) {
	const results = Array.isArray(report?.testResults) ? report.testResults : [];
	const marker = "packages/coding-agent/";
	const failed = [];
	for (const result of results) {
		if (result?.status !== "failed" || typeof result.name !== "string") continue;
		const normalized = result.name.replaceAll("\\", "/");
		const index = normalized.lastIndexOf(marker);
		if (index === -1) continue;
		failed.push(normalized.slice(index));
	}
	return Array.from(new Set(failed));
}

/** The most recent completed push-to-main run other than the one currently planning. */
export function selectCarryForwardRun(runs, { excludeRunId } = {}) {
	for (const run of runs) {
		if (excludeRunId !== undefined && String(run.databaseId) === String(excludeRunId)) continue;
		return run;
	}
	return undefined;
}

/** Parses a coding-agent-test job's name back into the (os, shard) that named its artifact. */
export function matchCodingAgentJob(name) {
	const match = CODING_AGENT_JOB_NAME.exec(name ?? "");
	return match ? { os: match[1], shard: match[2] } : null;
}

/**
 * The exact artifact name a coding-agent-test job's (os, shard) uploads its report under. Must
 * stay byte-for-byte in sync with the `name:` template on ci.yml's "Upload coding-agent test
 * report for failure carry-forward" step (`test-report-coding-agent-${{ matrix.os }}-${{
 * matrix.shard }}`) — see ci-carry-forward.test.mjs, which renders that template straight out of
 * ci.yml and checks it against this function so an edit to one side without the other fails.
 */
export function codingAgentReportArtifactName(os, shard) {
	return `test-report-coding-agent-${os}-${shard}`;
}

/**
 * Classifies a failed run's jobs. Any job outside the coding-agent-test matrix that did not
 * conclude cleanly makes the failure's scope unprovable from here — full suite. Otherwise returns
 * the coding-agent-test (os, shard) pairs that need a verified report before anything can narrow.
 */
export function classifyFailedRunJobs(jobs) {
	const codingAgentFailures = [];
	for (const job of jobs) {
		const match = matchCodingAgentJob(job.name);
		if (match) {
			if (NOT_CLEAN_CONCLUSIONS.has(job.conclusion)) codingAgentFailures.push(match);
			continue;
		}
		if (NOT_CLEAN_CONCLUSIONS.has(job.conclusion)) {
			return { kind: "full", reason: `job "${job.name}" concluded "${job.conclusion}"` };
		}
	}
	if (codingAgentFailures.length === 0) {
		return { kind: "full", reason: "previous run did not conclude cleanly but no coding-agent-test job did either" };
	}
	return { kind: "jobs", jobs: codingAgentFailures };
}

/**
 * @param {object} deps
 * @param {string} deps.repo - "owner/name"
 * @param {string|number} [deps.excludeRunId]
 * @param {(args: string[]) => string} deps.runGh - executes `gh` with args, returns stdout
 * @param {(runId: string|number) => {name: string, conclusion: string}[]} deps.viewJobs
 * @param {(runId: string|number) => {id: string|number, name: string}[]} deps.listArtifacts
 * @param {(artifactId: string|number) => object[]} deps.downloadReport - downloads and unzips one
 *   artifact, returns its parsed JSON report file(s)
 * @returns {Promise<{full: true, reason: string} | {full: false, files: string[]}>}
 */
export async function fetchCarryForward({ repo, excludeRunId, runGh, viewJobs, listArtifacts, downloadReport }) {
	const runsJson = runGh([
		"run",
		"list",
		"-R",
		repo,
		"--workflow",
		"ci.yml",
		"--branch",
		"main",
		"--event",
		"push",
		"--status",
		"completed",
		"--json",
		"databaseId,conclusion",
		"--limit",
		"5",
	]);
	const runs = JSON.parse(runsJson);
	const previous = selectCarryForwardRun(runs, { excludeRunId });
	if (!previous || previous.conclusion === "success") return { full: false, files: [] };

	const jobs = viewJobs(previous.databaseId);
	const classification = classifyFailedRunJobs(jobs);
	if (classification.kind === "full") return { full: true, reason: classification.reason };

	const artifacts = listArtifacts(previous.databaseId);
	const artifactIdByName = new Map(artifacts.map((artifact) => [artifact.name, artifact.id]));

	const failed = new Set();
	for (const { os, shard } of classification.jobs) {
		const artifactName = codingAgentReportArtifactName(os, shard);
		const artifactId = artifactIdByName.get(artifactName);
		if (artifactId === undefined) {
			return { full: true, reason: `no test report artifact "${artifactName}" for a failed coding-agent-test job` };
		}
		const reports = downloadReport(artifactId);
		const jobFailed = new Set();
		for (const report of reports) for (const file of parseFailedTestFiles(report)) jobFailed.add(file);
		if (jobFailed.size === 0) {
			return {
				full: true,
				reason: `test report artifact "${artifactName}" lists no failed tests despite a non-clean job conclusion`,
			};
		}
		for (const file of jobFailed) failed.add(file);
	}
	return { full: false, files: Array.from(failed) };
}

function runGhDefault(args) {
	return execFileSync("gh", args, { encoding: "utf8" });
}

function viewJobsDefault(repo) {
	return (runId) => {
		const json = execFileSync("gh", ["run", "view", String(runId), "-R", repo, "--json", "jobs"], { encoding: "utf8" });
		return JSON.parse(json).jobs.map((job) => ({ name: job.name, conclusion: job.conclusion }));
	};
}

function listArtifactsDefault(repo) {
	return (runId) => {
		const json = execFileSync("gh", ["api", `repos/${repo}/actions/runs/${runId}/artifacts`, "--jq", ".artifacts"], { encoding: "utf8" });
		return JSON.parse(json).map((artifact) => ({ id: artifact.id, name: artifact.name }));
	};
}

function downloadReportDefault(repo) {
	return (artifactId) => {
		const dir = mkdtempSync(join(tmpdir(), "ci-carry-forward-"));
		try {
			const zipPath = join(dir, "artifact.zip");
			execFileSync("gh", ["api", `repos/${repo}/actions/artifacts/${artifactId}/zip`, "--output", zipPath]);
			execFileSync("unzip", ["-o", "-q", zipPath, "-d", dir]);
			return readdirSync(dir)
				.filter((name) => name.endsWith(".json"))
				.map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	};
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const repo = process.env.GITHUB_REPOSITORY;
	const excludeRunId = process.env.GITHUB_RUN_ID;
	if (!repo) {
		console.error("ci-carry-forward: GITHUB_REPOSITORY is required; failing closed to the full suite");
		console.log(JSON.stringify({ full: true, reason: "GITHUB_REPOSITORY was not set" }));
		process.exit(0);
	}
	try {
		const result = await fetchCarryForward({
			repo,
			excludeRunId,
			runGh: runGhDefault,
			viewJobs: viewJobsDefault(repo),
			listArtifacts: listArtifactsDefault(repo),
			downloadReport: downloadReportDefault(repo),
		});
		console.log(JSON.stringify(result));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`ci-carry-forward: lookup failed (${message}); failing closed to the full suite`);
		console.log(JSON.stringify({ full: true, reason: `carry-forward lookup failed: ${message}` }));
	}
}
