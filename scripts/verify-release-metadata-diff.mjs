#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { partitionReleasePaths } from "./release-staging.mjs";

const commits = process.argv.slice(2);
if (commits.length !== 2 || commits.some((commit) => !/^[a-f0-9]{40}$/i.test(commit))) {
	console.error("::error::Usage: node scripts/verify-release-metadata-diff.mjs <tested-sha> <release-sha>");
	process.exit(1);
}

const diff = spawnSync("git", ["diff", "--name-only", "-z", commits[0], commits[1], "--"], {
	encoding: "utf8",
	maxBuffer: 4 * 1024 * 1024,
});
if (diff.error || diff.status !== 0) {
	const detail = diff.error?.message ?? diff.stderr.trim() ?? `git diff exited ${diff.status}`;
	console.error(`::error::Could not inspect release metadata diff: ${detail}`);
	process.exit(1);
}

const changedPaths = diff.stdout.split("\0").filter(Boolean);
const { unexpected } = partitionReleasePaths(changedPaths);
if (unexpected.length > 0) {
	for (const path of unexpected) console.error(`::error::Release metadata commit changes untested path ${path}`);
	process.exit(1);
}
