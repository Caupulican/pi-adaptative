#!/usr/bin/env node

import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";

function git(args, input) {
	return spawnSync("git", args, {
		cwd: process.cwd(),
		input,
		encoding: args.includes("-z") ? "buffer" : "utf8",
	});
}

function textGit(args) {
	return execFileSync("git", args, { cwd: process.cwd(), encoding: "utf8" }).trim();
}

function splitNul(buffer) {
	return buffer
		.toString("utf8")
		.split("\0")
		.filter((part) => part.length > 0);
}

function normalizeRepoPath(path) {
	return path.replaceAll("\\", "/").replace(/^\.\//, "");
}

const staged = git(["diff", "--cached", "--name-only", "-z"]);
if (staged.status !== 0) {
	process.stderr.write(staged.stderr);
	process.exit(staged.status ?? 1);
}
if (staged.stdout.length === 0) process.exit(0);

const gitDirExclude = textGit(["rev-parse", "--git-path", "info/exclude"]);
const repoRoot = textGit(["rev-parse", "--show-toplevel"]);
const excludePath = normalizeRepoPath(gitDirExclude);
const absoluteExcludePath = normalizeRepoPath(resolve(repoRoot, gitDirExclude));

const ignored = git(["check-ignore", "-z", "-v", "--no-index", "--stdin"], staged.stdout);
if (ignored.status !== 0 && ignored.status !== 1) {
	process.stderr.write(ignored.stderr);
	process.exit(ignored.status ?? 1);
}

const fields = splitNul(ignored.stdout);
const blocked = [];
for (let index = 0; index + 3 < fields.length; index += 4) {
	const [source, line, pattern, path] = fields.slice(index, index + 4);
	const normalizedSource = normalizeRepoPath(source);
	const absoluteSource = normalizeRepoPath(resolve(repoRoot, source));
	if (normalizedSource !== excludePath && absoluteSource !== absoluteExcludePath) continue;
	blocked.push({ line, pattern, path });
}

if (blocked.length === 0) process.exit(0);

console.error("Refusing to commit staged paths matched by .git/info/exclude:");
for (const item of blocked) {
	console.error(`  ${item.path} (line ${item.line}: ${item.pattern})`);
}
console.error("Remove these paths from the index or update .git/info/exclude intentionally.");
process.exit(1);
