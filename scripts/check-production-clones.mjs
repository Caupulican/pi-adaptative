import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

import {
	CLONE_CROSS_FORMATS,
	CLONE_LIMITS,
	CLONE_SOURCE_ROOTS,
	discoverCloneCandidates,
	validateCandidateLimits,
	validateCloneExclusions,
	validateCloneReport,
	validateCoverageSummary,
} from "./production-clone-gate.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const jscpdRunner = resolve(repositoryRoot, "node_modules", "jscpd", "run-jscpd.js");
const reportFilename = "jscpd-report.json";

function parseArguments(argv) {
	if (argv.length === 0) return undefined;
	if (argv.length === 2 && argv[0] === "--report-dir" && argv[1]) return resolve(argv[1]);
	throw new Error("usage: node scripts/check-production-clones.mjs [--report-dir <directory>]");
}

function displayPath(filePath) {
	const repositoryPath = relative(repositoryRoot, filePath);
	if (repositoryPath.startsWith("..")) return filePath;
	return sep === "/" ? repositoryPath : repositoryPath.split(sep).join("/");
}

function printCloneSummary(report, limit = 25) {
	const clones = [...report.duplicates].sort((left, right) => (right.lines ?? 0) - (left.lines ?? 0));
	for (const clone of clones.slice(0, limit)) {
		const first = clone.firstFile ?? {};
		const second = clone.secondFile ?? {};
		console.error(
			`- ${clone.lines ?? "?"} lines: ${displayPath(first.name ?? "unknown")}:${first.start ?? "?"} <-> ${displayPath(second.name ?? "unknown")}:${second.start ?? "?"}`,
		);
	}
	if (clones.length > limit) console.error(`- ${clones.length - limit} additional clones omitted from console output`);
}

function boundedProcessOutput(result) {
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.replace(/\u001b\[[0-9;]*m/gu, "").trim();
	return output.length <= 4_000 ? output : `${output.slice(0, 4_000)}\n... scanner output truncated`;
}

let temporaryReport = false;
let reportDirectory;
let report;
let candidates = [];
let eligibleCandidates = [];
let belowMinimumCandidates = [];

try {
	const requestedReportDirectory = parseArguments(process.argv.slice(2));
	reportDirectory = requestedReportDirectory ?? mkdtempSync(join(tmpdir(), "pi-jscpd-"));
	temporaryReport = requestedReportDirectory === undefined;
	if (requestedReportDirectory !== undefined) mkdirSync(reportDirectory, { recursive: true });

	validateCloneExclusions(repositoryRoot);
	candidates = discoverCloneCandidates(repositoryRoot);
	validateCandidateLimits(candidates);
	if (!existsSync(jscpdRunner)) throw new Error("jscpd is not installed; run npm install --ignore-scripts");
	eligibleCandidates = candidates.filter((candidate) => candidate.lines >= CLONE_LIMITS.minLines);
	belowMinimumCandidates = candidates.filter((candidate) => candidate.lines < CLONE_LIMITS.minLines);
	const configPath = resolve(repositoryRoot, ".jscpd.json");

	const coverageResult = spawnSync(
		process.execPath,
		[
			jscpdRunner,
			...CLONE_SOURCE_ROOTS,
			"--config",
			configPath,
			"--reporters",
			"silent",
			"--min-tokens",
			"1",
			"--threshold",
			"1000000",
			"--no-colors",
			"--no-tips",
		],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	if (coverageResult.error) throw coverageResult.error;
	if (coverageResult.signal || coverageResult.status !== 0) {
		const output = boundedProcessOutput(coverageResult);
		throw new Error(
			`jscpd coverage scan exited abnormally (${coverageResult.signal ?? coverageResult.status})${output ? `:\n${output}` : ""}`,
		);
	}
	validateCoverageSummary(`${coverageResult.stdout ?? ""}${coverageResult.stderr ?? ""}`, eligibleCandidates.length);

	const result = spawnSync(
		process.execPath,
		[
			jscpdRunner,
			...CLONE_SOURCE_ROOTS,
			"--config",
			configPath,
			"--output",
			reportDirectory,
			"--cross-formats",
			CLONE_CROSS_FORMATS,
		],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
		},
	);
	if (result.error) throw result.error;

	const reportPath = join(reportDirectory, reportFilename);
	if (!existsSync(reportPath)) {
		const output = boundedProcessOutput(result);
		throw new Error(`jscpd did not emit ${reportFilename}${output ? `:\n${output}` : ""}`);
	}
	report = JSON.parse(readFileSync(reportPath, "utf8"));
	const total = validateCloneReport(report);
	if (result.signal || (result.status !== 0 && result.status !== null)) {
		const output = boundedProcessOutput(result);
		throw new Error(`jscpd exited abnormally (${result.signal ?? result.status})${output ? `:\n${output}` : ""}`);
	}

	const largestLines = Math.max(...candidates.map((candidate) => candidate.lines));
	const largestBytes = Math.max(...candidates.map((candidate) => candidate.bytes));
	console.log(
		`Production clone gate passed: ${eligibleCandidates.length}/${candidates.length} eligible/owned files covered, ${total.sources} files in the 50-token detection pass, 0 clones (largest ${largestLines} lines / ${largestBytes} bytes).`,
	);
	if (temporaryReport) rmSync(reportDirectory, { recursive: true, force: true });
} catch (error) {
	console.error(`Production clone gate failed: ${error instanceof Error ? error.message : String(error)}`);
	if (candidates.length > 0) {
		console.error(
			`Coverage: ${eligibleCandidates.length}/${candidates.length} scanner-eligible/owned files; ${belowMinimumCandidates.length} files are shorter than minLines=${CLONE_LIMITS.minLines}.`,
		);
		for (const candidate of belowMinimumCandidates) console.error(`- below detection floor: ${candidate.path} (${candidate.lines} lines)`);
	}
	if (report?.statistics?.total?.sources !== undefined) {
		console.error(`Detection pass: ${report.statistics.total.sources} sources after pinned 50-token/cross-format normalization.`);
	}
	if (report?.duplicates?.length > 0) printCloneSummary(report);
	if (reportDirectory) console.error(`Full jscpd evidence: ${join(reportDirectory, reportFilename)}`);
	process.exitCode = 1;
}
