/**
 * Released changelog sections are immutable (docs/maintainer-workflows.md). For every release tag from FIRST_CHECKED_TAG on,
 * the section of that version in each package changelog must equal what the tag holds. A tag that is not available locally
 * (a shallow checkout) is reported as skipped, never as passed.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const FIRST_CHECKED_TAG = [0, 104, 14];
const CHANGELOGS = ["packages/coding-agent/CHANGELOG.md", "packages/ai/CHANGELOG.md", "packages/tui/CHANGELOG.md"];

function git(args) {
	return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 });
}

function parseTag(tag) {
	const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function atOrAfter(version, floor) {
	for (let index = 0; index < 3; index++) {
		if (version[index] !== floor[index]) return version[index] > floor[index];
	}
	return true;
}

/** The text of `## [version]` up to the next `## [` heading, or undefined when the changelog has no such section. */
function sectionOf(changelog, version) {
	const lines = changelog.split("\n");
	const start = lines.findIndex((line) => line.startsWith(`## [${version}]`));
	if (start === -1) return undefined;
	let end = lines.findIndex((line, index) => index > start && line.startsWith("## ["));
	if (end === -1) end = lines.length;
	return lines.slice(start, end).join("\n").trimEnd();
}

let tags;
try {
	tags = git(["tag", "--list", "v*"]).split("\n").filter(Boolean);
} catch {
	console.log("check-changelog-immutable: skipped (not a git checkout)");
	process.exit(0);
}
const release = tags.filter((tag) => {
	const version = parseTag(tag);
	return version !== undefined && atOrAfter(version, FIRST_CHECKED_TAG);
});
if (release.length === 0) {
	console.log("check-changelog-immutable: skipped (no release tag from v0.104.14 on is available locally)");
	process.exit(0);
}

const failures = [];
for (const tag of release) {
	const version = tag.slice(1);
	for (const path of CHANGELOGS) {
		let atTag;
		try {
			atTag = sectionOf(git(["show", `${tag}:${path}`]), version);
		} catch {
			continue;
		}
		if (atTag === undefined) continue;
		const now = sectionOf(readFileSync(path, "utf8"), version);
		if (now !== atTag) failures.push(`${path}: the ${version} section differs from ${tag}`);
	}
}
if (failures.length > 0) {
	console.error("Released changelog sections are immutable; restore them and put new notes under [Unreleased]:");
	for (const failure of failures) console.error(`- ${failure}`);
	process.exit(1);
}
console.log(`check-changelog-immutable: ${release.length} release tag(s) checked`);
