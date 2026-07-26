import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const vitestCli = resolve(repositoryRoot, "node_modules/vitest/dist/cli.js");
const maxReporterBufferBytes = 16 * 1024 * 1024;
const maxDiagnosticCharacters = 32 * 1024;

const campaigns = [
	{
		name: "crash/restart",
		packagePath: "packages/coding-agent",
		files: [
			"test/agent-session-worker-delegation.test.ts",
			"test/delegation-orchestration-ledger.test.ts",
			"test/durable-task-runtime.test.ts",
			"test/worker-lifecycle.test.ts",
		],
	},
	{
		name: "multi-session concurrency",
		packagePath: "packages/coding-agent",
		files: [
			"test/atomic-file.test.ts",
			"test/model-adaptation-store.test.ts",
			"test/orchestration-event-store.test.ts",
			"test/tool-recovery-logger.test.ts",
		],
	},
	{
		name: "concurrent transcript persistence",
		packagePath: "packages/agent",
		files: ["test/session/concurrent-file.test.ts"],
	},
	{
		name: "long-context compaction/resume soak",
		packagePath: "packages/agent",
		files: ["test/session/compacted-payload-release.test.ts"],
	},
	{
		name: "durable state across compaction",
		packagePath: "packages/coding-agent",
		files: ["test/goal-task-compaction-survival.test.ts"],
	},
	{
		name: "provider contract matrix",
		packagePath: "packages/coding-agent",
		files: [
			"test/model-contract-matrix.test.ts",
			"test/model-tool-protocol.test.ts",
			"test/worker-runner.test.ts",
			"test/agent-session-retry.test.ts",
		],
	},
	{
		name: "adversarial UAC",
		packagePath: "packages/coding-agent",
		files: [
			"test/extensions-lazy-loading.test.ts",
			"test/profile-strict-uac.test.ts",
			"test/profile-io-gating.test.ts",
			"test/runtime-builder-worker-ceiling.test.ts",
			"test/extension-live-load-unload.test.ts",
		],
	},
];

function writeBoundedDiagnostic(label, value) {
	const text = String(value ?? "").trim();
	if (!text) return;
	const suffix = text.length > maxDiagnosticCharacters ? "\n[diagnostic truncated by core acceptance]" : "";
	process.stderr.write(`${label}${text.slice(0, maxDiagnosticCharacters)}${suffix}\n`);
}

function parseVitestReport(stdout, campaignName) {
	try {
		const report = JSON.parse(stdout);
		if (
			typeof report !== "object" ||
			report === null ||
			typeof report.success !== "boolean" ||
			typeof report.numTotalTests !== "number" ||
			typeof report.numPassedTests !== "number" ||
			typeof report.numFailedTests !== "number" ||
			typeof report.numPendingTests !== "number" ||
			typeof report.numTodoTests !== "number" ||
			!Array.isArray(report.testResults)
		) {
			throw new Error("missing required Vitest JSON fields");
		}
		return report;
	} catch (error) {
		writeBoundedDiagnostic(`[core acceptance] ${campaignName} reporter output:\n`, stdout);
		throw new Error(
			`Unable to parse Vitest JSON for ${campaignName}: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function reportProblems(report) {
	const failures = [];
	const incomplete = [];
	for (const file of report.testResults) {
		if (!file || typeof file !== "object") continue;
		if (typeof file.message === "string" && file.message.trim()) {
			failures.push(`${String(file.name ?? "unknown test file")}: ${file.message}`);
		}
		if (!Array.isArray(file.assertionResults)) continue;
		for (const assertion of file.assertionResults) {
			if (!assertion || typeof assertion !== "object") continue;
			if (assertion.status === "failed") {
				const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
				failures.push(`${String(assertion.fullName ?? assertion.title ?? "failed test")}\n${messages.join("\n")}`);
			} else if (["pending", "skipped", "todo"].includes(assertion.status)) {
				incomplete.push(String(assertion.fullName ?? assertion.title ?? "incomplete test"));
			}
		}
	}
	writeBoundedDiagnostic("[core acceptance] failures:\n", failures.join("\n\n"));
	writeBoundedDiagnostic("[core acceptance] skipped/todo:\n", incomplete.join("\n"));
}

for (const campaign of campaigns) {
	process.stdout.write(`\n[core acceptance] ${campaign.name}\n`);
	const result = spawnSync(process.execPath, [vitestCli, "--run", ...campaign.files, "--reporter=json", "--silent"], {
		cwd: resolve(repositoryRoot, campaign.packagePath),
		encoding: "utf8",
		env: process.env,
		maxBuffer: maxReporterBufferBytes,
	});
	if (result.error) throw result.error;
	writeBoundedDiagnostic("", result.stderr);
	const report = parseVitestReport(result.stdout ?? "", campaign.name);
	const incompleteTests = report.numPendingTests + report.numTodoTests;
	process.stdout.write(
		`[core acceptance] ${report.numPassedTests}/${report.numTotalTests} passed, ${report.numFailedTests} failed, ${incompleteTests} skipped/todo\n`,
	);
	if (result.status !== 0 || !report.success || incompleteTests > 0) {
		reportProblems(report);
		if (incompleteTests > 0) {
			process.stderr.write(
				`[core acceptance] ${campaign.name} is incomplete: skipped/todo tests are forbidden in release evidence\n`,
			);
		}
		process.exit(result.status && result.status > 0 ? result.status : 1);
	}
}

process.stdout.write(`\n[core acceptance] all ${campaigns.length} reliability campaigns passed\n`);
