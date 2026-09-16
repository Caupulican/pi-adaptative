import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REQUIRED_JOBS = new Map([
	["Build, check, test (ubuntu-latest)", ["Verification-harness coverage gate", "Test non-coding-agent workspaces", "Test native process-tree control alone"]],
	["Build, check, test (windows-latest)", ["Test non-coding-agent workspaces", "Test native process-tree control alone", "Test native incident collector with Windows PowerShell 5.1"]],
	...["ubuntu-latest", "windows-latest"].flatMap((os) => [1, 2, 3, 4].map((shard) => [
		`Coding-agent test (${os}, shard ${shard}/4)`, ["Test coding-agent shard"],
	])),
]);

/** A green workflow can skip tests. Require every distinct platform/shard and its actual test steps. */
export function hasCompleteCiMatrix(jobs) {
	if (!Array.isArray(jobs)) return false;
	return [...REQUIRED_JOBS].every(([name, steps]) => {
		const matching = jobs.filter((job) => job.name === name);
		return matching.length === 1 && matching[0].status === "completed" && matching[0].conclusion === "success" &&
			steps.every((step) => matching[0].steps?.some((entry) => entry.name === step && entry.conclusion === "success"));
	});
}

function readCommand(command, args) {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 8 * 1024 * 1024 });
}

/** The full matrix must belong to one successful, complete run on exactly this source tree. */
export function requireCiProof(sha, repo, read = readCommand) {
	const runs = JSON.parse(read("gh", ["run", "list", "-R", repo, "--workflow=ci.yml", "--commit", sha,
		"--limit", "100", "--json", "databaseId,headSha,status,conclusion"]));
	for (const run of runs) {
		if (run.headSha !== sha || run.status !== "completed" || run.conclusion !== "success") continue;
		const detail = JSON.parse(read("gh", ["run", "view", String(run.databaseId), "-R", repo, "--json", "jobs"]));
		if (hasCompleteCiMatrix(detail.jobs)) return run.databaseId;
	}
	throw new Error(`ci.yml has no successful complete Linux/Windows matrix for tested commit ${sha}`);
}

/** Release metadata may inherit its parent's proof only after the shared metadata-diff gate passes. */
export function requireReleaseCiProof(sha, repo, read = readCommand) {
	let testedSha = sha;
	const subject = read("git", ["show", "-s", "--format=%s", sha]).trim();
	if (/^(?:Release v|Repair release v)\d+\.\d+\.\d+$/u.test(subject)) {
		testedSha = read("git", ["rev-parse", `${sha}^`]).trim();
		read(process.execPath, [join(import.meta.dirname, "verify-release-metadata-diff.mjs"), testedSha, sha]);
	}
	return requireCiProof(testedSha, repo, read);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	try {
		const [sha, repo] = process.argv.slice(2);
		if (!/^[a-f0-9]{40}$/iu.test(sha ?? "") || !repo) throw new Error("Usage: release-ci-proof.mjs <sha> <repo>");
		const run = requireReleaseCiProof(sha, repo);
		console.log(`Complete CI matrix proven by run ${run}`);
	} catch (error) {
		console.error(`::error::${error.message}`);
		process.exitCode = 1;
	}
}
