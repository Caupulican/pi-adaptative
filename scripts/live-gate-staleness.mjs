#!/usr/bin/env node
/**
 * Live-gate staleness: the commit the newest live-gate report tested, and how far HEAD has moved since. Read-only: it
 * runs no scenario and calls no model. The stamp it reads (`commit`, `dirty`, `installed`, `binary`, `verdict`) is
 * written by `scripts/accept-harness-live.mjs` into `<git-common-dir>/pi-audits/live-validation/<stamp>/report.json`.
 *
 *   node scripts/live-gate-staleness.mjs
 *
 * Exit 0 when the newest report carries a commit that this repository knows; the printed counts say how stale it is.
 * Exit 2 when there is no report, the report has no commit (it predates the stamp), or the commit is not in this
 * repository (its history was rewritten, or the report came from another clone).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = resolve(fileURLToPath(new URL("..", import.meta.url)));
const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: REPO, encoding: "utf8" }).trim();
const fail = (message) => {
	console.error(`live-gate-staleness: ${message}`);
	process.exit(2);
};

const LIVE_DIR = join(resolve(REPO, git("rev-parse", "--git-common-dir")), "pi-audits", "live-validation");
// Stamp names are fixed-width ISO times, so the name order is the time order. A directory without a report is an
// aborted run.
const newest = existsSync(LIVE_DIR)
	? readdirSync(LIVE_DIR)
			.filter((name) => existsSync(join(LIVE_DIR, name, "report.json")))
			.sort()
			.at(-1)
	: undefined;
if (!newest) fail(`no live-gate report under ${LIVE_DIR}`);

const report = JSON.parse(readFileSync(join(LIVE_DIR, newest, "report.json"), "utf8"));
if (typeof report.commit !== "string") fail(`${newest} has no commit: it predates the commit stamp`);
const probe = spawnSync("git", ["cat-file", "-e", `${report.commit}^{commit}`], { cwd: REPO, stdio: "ignore" });
const known = probe.status === 0;
if (!known) fail(`commit ${report.commit} of ${newest} is not in this repository`);

const head = git("rev-parse", "HEAD");
const commitsSince = Number(git("rev-list", "--count", `${report.commit}..HEAD`));
const sourceDiff = git("diff", "--stat", `${report.commit}..HEAD`, "--", "packages/coding-agent/src");

console.log(`report: ${newest}`);
console.log(`verdict: ${report.verdict}`);
console.log(`commit: ${report.commit}`);
console.log(`dirty: ${report.dirty}`);
console.log(`installed: ${report.installed}`);
if (report.binary) console.log(`binary: ${report.binary}`);
console.log(`HEAD: ${head}`);
console.log(`commits from the tested commit to HEAD: ${commitsSince}`);
console.log(
	sourceDiff
		? `packages/coding-agent/src changed since the tested commit:\n${sourceDiff}`
		: "packages/coding-agent/src unchanged since the tested commit",
);
console.log("scenarios:");
for (const result of report.results) console.log(`  ${result.id} ${result.status}`);
