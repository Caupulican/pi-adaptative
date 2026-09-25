#!/usr/bin/env node
/**
 * The push-side half of the commit/CI loop.
 *
 * `pre-push` starts one detached watcher per pushed branch head. The watcher follows that exact
 * commit's ci.yml run to its end and records the verdict (and, when it failed, the failing test
 * files from the runs' vitest reports) in `<git-common-dir>/pi-ci/<branch>.json`. That file is the
 * terminal signal and the bounded handoff: the next commit on any session in this clone reads it,
 * reruns the carried failing tests, and refuses to commit on top of a red branch until they pass.
 * Nothing polls it; it is read when git is next used.
 *
 *   node scripts/ci-status.mjs pre-push <remote> <url>   (git pre-push hook; refs on stdin)
 *   node scripts/ci-status.mjs watch <sha> <branch>      (the detached watcher)
 *   node scripts/ci-status.mjs show [branch]             (print the recorded verdict)
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const repoRoot = resolve(dirname(scriptPath), "..");
const WORKFLOW = "ci.yml";
const ZERO_SHA = /^0+$/u;
/** A just-pushed commit's run takes a moment to register; after this, "missing" is the verdict. */
const REGISTRATION_GRACE_MS = 5 * 60_000;
const REGISTRATION_INTERVAL_MS = 20_000;
const MAX_CARRIED_TESTS = 200;

function git(args, options = {}) {
	return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...options }).trim();
}

function gh(args) {
	return execFileSync("gh", args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
}

export function statusDirectory(root = repoRoot) {
	return join(resolve(root, git(["rev-parse", "--git-common-dir"])), "pi-ci");
}

export function statusFile(branch, root = repoRoot) {
	return join(statusDirectory(root), `${branch.replaceAll("/", "__")}.json`);
}

export function readCiStatus(branch, root = repoRoot) {
	const path = statusFile(branch, root);
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return { state: "unreadable", branch, path };
	}
}

/**
 * The run that decides a commit's verdict: a success anywhere wins (a rerun that passed), then a
 * run still going, then the newest completed run that was not superseded (cancelled).
 */
export function pickDecisiveRun(runs, sha) {
	const matches = runs.filter((run) => run.headSha === sha).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
	return (
		matches.find((run) => run.status === "completed" && run.conclusion === "success") ??
		matches.find((run) => run.status !== "completed") ??
		matches.find((run) => run.status === "completed" && run.conclusion !== "cancelled") ??
		matches[0]
	);
}

/** Repo-relative failing test files from vitest JSON reports, with the platforms each failed on. */
export function failingTestsFromReports(reports) {
	const byFile = new Map();
	for (const { artifact, report } of reports) {
		const platform = /(ubuntu|windows|macos)/u.exec(artifact)?.[1] ?? "unknown";
		for (const result of report?.testResults ?? []) {
			if (result.status !== "failed" || typeof result.name !== "string") continue;
			const normalized = result.name.replaceAll("\\", "/");
			const index = normalized.indexOf("packages/");
			if (index === -1) continue;
			const path = normalized.slice(index);
			const workspace = /^packages\/[^/]+/u.exec(path)?.[0];
			if (!workspace) continue;
			const entry = byFile.get(path) ?? { workspace, file: path.slice(workspace.length + 1), platforms: [] };
			if (!entry.platforms.includes(platform)) entry.platforms.push(platform);
			byFile.set(path, entry);
		}
	}
	return [...byFile.values()].sort((a, b) => `${a.workspace}/${a.file}`.localeCompare(`${b.workspace}/${b.file}`));
}

/**
 * What a new commit must do about the branch's recorded verdict. `isAncestorOfHead(sha)` says
 * whether the recorded commit is in this commit's history; a verdict about unrelated history
 * (another branch head, a rewritten main) carries nothing.
 */
export function commitObligation(status, isAncestorOfHead) {
	if (!status || typeof status.sha !== "string") return { kind: "none" };
	if (!isAncestorOfHead(status.sha)) return { kind: "none" };
	if (status.state === "pending") return { kind: "pending", status };
	if (status.state === "watch_failed" || status.state === "unreadable") return { kind: "unknown", status };
	if (status.state !== "completed" || status.conclusion === "success") return { kind: "none" };
	return {
		kind: "red",
		status,
		tests: status.failingTests ?? [],
		// Test jobs are covered by rerunning their failing files; anything else (check, coverage,
		// or a test job whose report was unavailable) can only be named.
		untestedFailures:
			(status.failingTests ?? []).length > 0
				? (status.failedJobs ?? []).filter((job) => !job.startsWith("Coding-agent test"))
				: (status.failedJobs ?? []),
	};
}

function writeStatus(branch, status) {
	const path = statusFile(branch);
	mkdirSync(dirname(path), { recursive: true });
	// Never let a slower watcher for an older commit overwrite a newer commit's verdict.
	const current = readCiStatus(branch);
	if (current?.sha && current.sha !== status.sha) {
		try {
			git(["merge-base", "--is-ancestor", status.sha, current.sha]);
			return false;
		} catch {
			// status.sha is not older than the recorded one: it replaces it.
		}
	}
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(status, null, 2)}\n`);
	renameSync(temporary, path);
	writeFileSync(join(dirname(path), "events.log"), `${new Date().toISOString()} ${branch} ${status.sha} ${status.state} ${status.conclusion ?? ""}\n`, { flag: "a" });
	return true;
}

function listRuns(sha) {
	return JSON.parse(gh(["run", "list", "--workflow", WORKFLOW, "--commit", sha, "--json", "databaseId,headSha,status,conclusion,url,createdAt", "--limit", "20"]));
}

function sleep(ms) {
	return new Promise((done) => setTimeout(done, ms));
}

function reportsFor(runId) {
	const directory = mkdtempSync(join(tmpdir(), "pi-ci-reports-"));
	try {
		// A red run without reports still records its failed jobs; commitObligation then reports
		// every one of them as unverifiable instead of pretending the tests passed.
		try {
			gh(["run", "download", String(runId), "-p", "test-report-*", "-D", directory]);
		} catch {
			return [];
		}
		return readdirSync(directory).flatMap((artifact) => {
			const path = join(directory, artifact, "test-report.json");
			return existsSync(path) ? [{ artifact, report: JSON.parse(readFileSync(path, "utf8")) }] : [];
		});
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

export async function watch(sha, branch) {
	const base = { sha, branch, workflow: WORKFLOW };
	writeStatus(branch, { ...base, state: "pending", startedAt: new Date().toISOString() });
	try {
		const startedAt = Date.now();
		for (;;) {
			const decisive = pickDecisiveRun(listRuns(sha), sha);
			if (!decisive) {
				if (Date.now() - startedAt > REGISTRATION_GRACE_MS) {
					writeStatus(branch, { ...base, state: "completed", conclusion: "missing", completedAt: new Date().toISOString() });
					return;
				}
				await sleep(REGISTRATION_INTERVAL_MS);
				continue;
			}
			if (decisive.status !== "completed") {
				// gh blocks until the run ends; its exit code is read from the run itself afterwards.
				try {
					gh(["run", "watch", String(decisive.databaseId), "--interval", "30"]);
				} catch {
					// The run listing, not the watch command, is the authority; re-read it after a pause.
					await sleep(REGISTRATION_INTERVAL_MS);
				}
				continue;
			}
			const jobs = JSON.parse(gh(["run", "view", String(decisive.databaseId), "--json", "jobs"])).jobs ?? [];
			const failedJobs = jobs.filter((job) => job.conclusion === "failure").map((job) => job.name);
			const failingTests = decisive.conclusion === "success" ? [] : failingTestsFromReports(reportsFor(decisive.databaseId));
			writeStatus(branch, {
				...base,
				state: "completed",
				conclusion: decisive.conclusion,
				runId: decisive.databaseId,
				url: decisive.url,
				failedJobs,
				failingTests: failingTests.slice(0, MAX_CARRIED_TESTS),
				omittedFailingTests: Math.max(0, failingTests.length - MAX_CARRIED_TESTS),
				completedAt: new Date().toISOString(),
			});
			return;
		}
	} catch (error) {
		writeStatus(branch, { ...base, state: "watch_failed", error: error instanceof Error ? error.message.slice(0, 2_000) : String(error), completedAt: new Date().toISOString() });
	}
}

/** pre-push: `<local ref> <local sha> <remote ref> <remote sha>` per line on stdin. */
export function prePushTargets(stdin) {
	return stdin
		.split("\n")
		.map((line) => line.trim().split(/\s+/u))
		.filter((parts) => parts.length === 4 && !ZERO_SHA.test(parts[1]) && parts[2].startsWith("refs/heads/"))
		.map(([, sha, remoteRef]) => ({ sha, branch: remoteRef.slice("refs/heads/".length) }));
}

function startWatchers(targets) {
	for (const { sha, branch } of targets) {
		const directory = statusDirectory();
		mkdirSync(directory, { recursive: true });
		const log = openSync(join(directory, `watch-${branch.replaceAll("/", "__")}.log`), "a");
		const child = spawn(process.execPath, [scriptPath, "watch", sha, branch], {
			cwd: repoRoot,
			detached: true,
			stdio: ["ignore", log, log],
			windowsHide: true,
		});
		child.unref();
		closeSync(log);
		process.stdout.write(`ci-status: watching ${WORKFLOW} for ${branch} at ${sha.slice(0, 9)} (verdict lands in ${statusFile(branch)})\n`);
	}
}

export function describeStatus(status) {
	if (!status) return "no recorded CI verdict";
	if (status.state === "pending") return `${status.branch} ${status.sha.slice(0, 9)}: ${WORKFLOW} still running`;
	if (status.state !== "completed") return `${status.branch} ${status.sha?.slice(0, 9)}: ${status.state}${status.error ? ` (${status.error})` : ""}`;
	const lines = [`${status.branch} ${status.sha.slice(0, 9)}: ${WORKFLOW} ${status.conclusion}${status.url ? ` ${status.url}` : ""}`];
	for (const job of status.failedJobs ?? []) lines.push(`  failed job: ${job}`);
	for (const test of status.failingTests ?? []) lines.push(`  failing test: ${test.workspace}/${test.file} (${test.platforms.join(", ")})`);
	return lines.join("\n");
}

async function main(argv) {
	const [command, ...rest] = argv;
	if (command === "watch") return watch(rest[0], rest[1]);
	if (command === "show") {
		const branch = rest[0] ?? git(["rev-parse", "--abbrev-ref", "HEAD"]);
		process.stdout.write(`${describeStatus(readCiStatus(branch))}\n`);
		return;
	}
	if (command === "pre-push") {
		const targets = prePushTargets(readFileSync(0, "utf8"));
		for (const { branch } of targets) {
			const previous = readCiStatus(branch);
			if (previous?.state === "completed" && previous.conclusion !== "success") {
				process.stdout.write(`ci-status: the last recorded ${WORKFLOW} on ${branch} is red:\n${describeStatus(previous)}\n`);
			}
		}
		startWatchers(targets);
		return;
	}
	throw new Error("usage: ci-status.mjs <pre-push|watch <sha> <branch>|show [branch]>");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
	main(process.argv.slice(2)).catch((error) => {
		process.stderr.write(`ci-status: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exit(process.argv[2] === "pre-push" ? 0 : 1);
	});
}
