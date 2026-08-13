#!/usr/bin/env node
/**
 * Release script for pi-mono
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *   node scripts/release.mjs promote
 *
 * The release flow is split into two gated phases so a CI failure never costs a version number:
 *
 * PREPARE (major|minor|patch|x.y.z) - a pure function of the committed tree, no tag:
 * 1. Preflight: on main, clean tree, origin/main is an ancestor of HEAD, prospective tag unused.
 * 2. Run the full isolated test suite.
 * 3. Bump version via npm run version:xxx or set an explicit version.
 * 4. Update CHANGELOG.md files: [Unreleased] -> [version] - date.
 * 5. Regenerate the coding-agent shrinkwrap.
 * 6. Run checks.
 * 7. Commit "Release vX.Y.Z" and push main (this is the commit CI must validate).
 * 8. Add new [Unreleased] sections to changelogs, commit, and push main again.
 * Any failure during steps 3-8 resets the local tree back to the preflight commit.
 *
 * PROMOTE (automatic after prepare, or standalone via `promote` to resume later):
 * 9. Locate the "Release vX.Y.Z" commit and poll GitHub Actions (workflow ci.yml) for its
 *    conclusion on that exact SHA.
 * 10. Only on success: create and push the vX.Y.Z tag, which triggers build-binaries.yml.
 * On CI failure or timeout, no tag is created; rerun `npm run release:promote` to resume once
 * CI is fixed or rerun. Never rerun the prepare step (release:patch/minor/major) for the same
 * version once its release commit has been pushed.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const isPrepareTarget = BUMP_TYPES.has(RELEASE_TARGET) || SEMVER_RE.test(RELEASE_TARGET);

if (RELEASE_TARGET !== "promote" && !isPrepareTarget) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z|promote>");
	process.exit(1);
}

const CI_WORKFLOW = "ci.yml";
const CI_POLL_INTERVAL_MS = 20_000;
const CI_POLL_TIMEOUT_MS = 60 * 60_000; // ci.yml's own per-OS job timeout is 45m; leave headroom for runner queueing.

class ReleaseCommandError extends Error {}

function run(cmd, options = {}) {
	console.log(`$ ${cmd}`);
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: options.silent ? "pipe" : "inherit", ...options });
	} catch (e) {
		if (options.ignoreError) {
			return null;
		}
		throw new ReleaseCommandError(`Command failed: ${cmd}${e.message ? `\n${e.message}` : ""}`);
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function compareVersions(a, b) {
	const aParts = a.split(".").map(Number);
	const bParts = b.split(".").map(Number);

	for (let i = 0; i < 3; i++) {
		const diff = (aParts[i] || 0) - (bParts[i] || 0);
		if (diff !== 0) {
			return diff;
		}
	}

	return 0;
}

function computeNextVersion(current, type) {
	const [major, minor, patch] = current.split(".").map(Number);
	if (type === "major") return `${major + 1}.0.0`;
	if (type === "minor") return `${major}.${minor + 1}.0`;
	return `${major}.${minor}.${patch + 1}`;
}

function shellQuote(value) {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function getRepoSlug() {
	const url = run("git remote get-url origin", { silent: true }).trim();
	const match = url.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?$/);
	if (!match) {
		throw new Error(`Could not parse a GitHub owner/repo from origin remote URL: ${url}`);
	}
	return match[1];
}

function computeReleaseAllowlist() {
	const allowlist = new Set(["package.json", "package-lock.json"]);
	const packageDirs = readdirSync("packages", { withFileTypes: true })
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name);

	for (const pkg of packageDirs) {
		const packageJsonPath = join("packages", pkg, "package.json");
		if (existsSync(packageJsonPath)) allowlist.add(packageJsonPath);
		const changelogPath = join("packages", pkg, "CHANGELOG.md");
		if (existsSync(changelogPath)) allowlist.add(changelogPath);
	}

	const aiSrcDir = join("packages", "ai", "src");
	if (existsSync(aiSrcDir)) {
		for (const file of readdirSync(aiSrcDir)) {
			if (file.endsWith(".generated.ts")) allowlist.add(join(aiSrcDir, file));
		}
	}

	const shrinkwrapPath = join("packages", "coding-agent", "npm-shrinkwrap.json");
	if (existsSync(shrinkwrapPath)) allowlist.add(shrinkwrapPath);

	return allowlist;
}

function parsePorcelainPath(line) {
	const path = line.slice(3);
	const arrowIndex = path.indexOf(" -> ");
	const finalPath = arrowIndex === -1 ? path : path.slice(arrowIndex + 4);
	return finalPath.replace(/^"/, "").replace(/"$/, "");
}

function stageChangedFiles() {
	const allowlist = computeReleaseAllowlist();
	const statusOutput = run("git status --porcelain", { silent: true }) || "";
	const changedPaths = statusOutput
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.map(parsePorcelainPath);

	const unexpected = changedPaths.filter((path) => !allowlist.has(path));
	if (unexpected.length > 0) {
		throw new Error(
			`Unexpected working-tree changes outside the release allowlist; refusing to stage them:\n${unexpected
				.map((path) => `  ${path}`)
				.join("\n")}`,
		);
	}

	const toStage = changedPaths.filter((path) => allowlist.has(path));
	if (toStage.length === 0) {
		return;
	}
	run(`git add -- ${toStage.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	// npm's package-age gate can otherwise block resolving a workspace package's own version
	// immediately after it was published; scoped to just this lockfile-refresh invocation.
	const lockfileRefreshEnv = { ...process.env, npm_config_min_release_age: "0" };

	if (BUMP_TYPES.has(target)) {
		console.log(`Bumping version (${target})...`);
		run(`npm run version:${target}`, { env: lockfileRefreshEnv });
		return getVersion();
	}

	console.log(`Setting explicit version (${target})...`);
	run(
		"npm version " +
			`${target} -ws --no-git-tag-version --workspaces-update=false && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`,
		{ env: lockfileRefreshEnv },
	);
	return getVersion();
}

function getChangelogs() {
	const packagesDir = "packages";
	const packages = readdirSync(packagesDir);
	return packages
		.map((pkg) => join(packagesDir, pkg, "CHANGELOG.md"))
		.filter((path) => existsSync(path));
}

function updateChangelogsForRelease(version) {
	const date = new Date().toISOString().split("T")[0];
	const changelogs = getChangelogs();

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (!content.includes("## [Unreleased]")) {
			throw new Error(`${changelog} has no "## [Unreleased]" section. Add one before releasing.`);
		}

		const updated = content.replace(
			"## [Unreleased]",
			`## [${version}] - ${date}`
		);
		writeFileSync(changelog, updated);
		console.log(`  Updated ${changelog}`);
	}
}

function addUnreleasedSection() {
	const changelogs = getChangelogs();
	const unreleasedSection = "## [Unreleased]\n\n";

	for (const changelog of changelogs) {
		const content = readFileSync(changelog, "utf-8");

		if (content.includes("## [Unreleased]")) {
			throw new Error(`${changelog} unexpectedly already has a "## [Unreleased]" section for the next cycle.`);
		}

		// Insert after "# Changelog\n\n" when the header exists; otherwise the
		// changelog starts directly with version sections, so prepend.
		const updated = /^# Changelog\n\n/.test(content)
			? content.replace(/^(# Changelog\n\n)/, `$1${unreleasedSection}`)
			: unreleasedSection + content;
		writeFileSync(changelog, updated);
		console.log(`  Added [Unreleased] to ${changelog}`);
	}
}

function computeProspectiveVersion() {
	const currentVersion = getVersion();
	if (BUMP_TYPES.has(RELEASE_TARGET)) {
		return computeNextVersion(currentVersion, RELEASE_TARGET);
	}
	if (compareVersions(RELEASE_TARGET, currentVersion) <= 0) {
		console.error(`Error: explicit version ${RELEASE_TARGET} must be greater than current version ${currentVersion}.`);
		process.exit(1);
	}
	return RELEASE_TARGET;
}

function assertTagIsFree(version) {
	const tag = `v${version}`;
	const localTag = run(`git tag -l ${shellQuote(tag)}`, { silent: true });
	if (localTag && localTag.trim()) {
		console.error(`Error: tag ${tag} already exists locally.`);
		process.exit(1);
	}
	const remoteTag = run(`git ls-remote --tags origin ${shellQuote(tag)}`, { silent: true });
	if (remoteTag && remoteTag.trim()) {
		console.error(`Error: tag ${tag} already exists on origin. This version was already released.`);
		process.exit(1);
	}
}

// All preflight checks are read-only (no local or remote mutation), so failures exit directly.
function preflight() {
	console.log("Running preflight checks...");

	const branch = run("git rev-parse --abbrev-ref HEAD", { silent: true }).trim();
	if (branch !== "main") {
		console.error(`Error: releases must run from the "main" branch (currently on "${branch}").`);
		process.exit(1);
	}

	const status = run("git status --porcelain", { silent: true });
	if (status && status.trim()) {
		console.error("Error: Uncommitted changes detected. Commit or stash first.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean");

	console.log("  Fetching origin...");
	run("git fetch origin --tags", { silent: true });

	const isAncestor = run("git merge-base --is-ancestor origin/main HEAD", { silent: true, ignoreError: true });
	if (isAncestor === null) {
		console.error(
			"Error: local main has diverged from origin/main (origin/main is not an ancestor of HEAD). Pull/rebase before releasing.",
		);
		process.exit(1);
	}

	const prospectiveVersion = computeProspectiveVersion();
	assertTagIsFree(prospectiveVersion);

	const preflightSha = run("git rev-parse HEAD", { silent: true }).trim();
	console.log(`  Preflight OK at ${preflightSha} (prospective version ${prospectiveVersion})\n`);
	return preflightSha;
}

function rollbackToPreflightSha(preflightSha) {
	console.error(`Rolling back local changes to preflight commit ${preflightSha}...`);
	run(`git reset --hard ${preflightSha}`, { ignoreError: true });
}

function prepareRelease() {
	console.log("\n=== Preparing release ===\n");
	const preflightSha = preflight();

	try {
		// 2. Run the full suite before any version, changelog, artifact, commit, or push mutation.
		console.log("Running full release test suite...");
		run("./test.sh");
		console.log();

		// 3. Bump or set version
		const version = bumpOrSetVersion(RELEASE_TARGET);
		console.log(`  New version: ${version}\n`);

		// 4. Update changelogs
		console.log("Updating CHANGELOG.md files...");
		updateChangelogsForRelease(version);
		console.log();

		// 5. Regenerate release artifacts. The generated model catalogs are intentionally NOT
		// regenerated here: builds are hermetic by default (see
		// packages/ai/scripts/model-catalog-generation-policy.ts), so this step no longer fetches
		// live data - the release is a pure function of the already-committed, already-tested tree.
		// Refreshing the catalogs from live pricing is a separate, explicitly reviewed change
		// (PI_FETCH_MODELS=1 npm run generate-models), governed by the weekly drift check.
		console.log("Regenerating release artifacts...");
		run("npm run shrinkwrap:coding-agent");
		console.log();

		// 6. Run checks
		console.log("Running checks...");
		run("npm run check");
		console.log();

		// 7. Commit and push (no tag yet - see promoteRelease)
		console.log("Committing release...");
		stageChangedFiles();
		run(`git commit -m "Release v${version}"`);
		console.log();

		console.log("Pushing release commit to origin/main...");
		run("git push origin main");
		console.log();

		// 8. Add new [Unreleased] sections for the next cycle
		console.log("Adding [Unreleased] sections for next cycle...");
		addUnreleasedSection();
		console.log();

		console.log("Committing changelog updates...");
		stageChangedFiles();
		run(`git commit -m "Add [Unreleased] section for next cycle"`);
		console.log();

		console.log("Pushing next-cycle commit to origin/main...");
		run("git push origin main");
		console.log();

		return version;
	} catch (error) {
		rollbackToPreflightSha(preflightSha);
		throw error;
	}
}

function findReleaseCommitSha(version) {
	run("git fetch origin --tags", { silent: true });
	const message = `Release v${version}`;
	const log = run("git log --all --format=%H%x1f%s", { silent: true }) || "";
	for (const line of log.split("\n")) {
		if (!line) continue;
		const separatorIndex = line.indexOf("\x1f");
		if (separatorIndex === -1) continue;
		const sha = line.slice(0, separatorIndex);
		const subject = line.slice(separatorIndex + 1);
		if (subject === message) return sha;
	}
	return undefined;
}

async function waitForCi(sha) {
	const repo = getRepoSlug();
	console.log(`  Waiting for CI (${CI_WORKFLOW}) on ${sha} in ${repo}...`);
	const deadline = Date.now() + CI_POLL_TIMEOUT_MS;

	while (Date.now() < deadline) {
		const listing = run(
			`gh run list -R ${shellQuote(repo)} --workflow=${CI_WORKFLOW} --json headSha,status,conclusion --limit 30`,
			{ silent: true, ignoreError: true },
		);
		if (listing) {
			const runs = JSON.parse(listing);
			const match = runs.find((r) => r.headSha === sha);
			if (match) {
				if (match.status === "completed") {
					console.log(`  CI run for ${sha}: ${match.conclusion}`);
					return match.conclusion;
				}
				console.log(`  CI run for ${sha}: ${match.status}...`);
			} else {
				console.log("  CI run not registered yet...");
			}
		}
		await sleep(CI_POLL_INTERVAL_MS);
	}

	throw new Error(`Timed out after ${Math.round(CI_POLL_TIMEOUT_MS / 60_000)}m waiting for CI on ${sha}.`);
}

function ensureTagPushed(tag) {
	const remoteTag = run(`git ls-remote --tags origin ${shellQuote(tag)}`, { silent: true });
	if (remoteTag && remoteTag.trim()) {
		console.log(`  ${tag} already pushed to origin.`);
		return;
	}
	console.log(`  ${tag} exists locally but not on origin; pushing...`);
	run(`git push origin ${tag}`);
}

async function promoteRelease(versionArg) {
	console.log("\n=== Promoting release ===\n");
	run("git fetch origin --tags", { silent: true });
	const version = versionArg ?? getVersion();
	const tag = `v${version}`;

	const existingLocalTag = run(`git tag -l ${shellQuote(tag)}`, { silent: true });
	if (existingLocalTag && existingLocalTag.trim()) {
		console.log(`  ${tag} already exists locally.`);
		ensureTagPushed(tag);
		console.log(`\n=== ${tag} already promoted ===\n`);
		return;
	}

	const releaseSha = findReleaseCommitSha(version);
	if (!releaseSha) {
		throw new Error(
			`Could not find a commit titled "Release v${version}" in any ref (local or origin). Run ` +
				'"npm run release:patch|minor|major" to prepare the release first.',
		);
	}
	console.log(`  Release commit: ${releaseSha}`);

	const conclusion = await waitForCi(releaseSha);
	if (conclusion !== "success") {
		throw new Error(
			`CI did not succeed for release commit ${releaseSha} (conclusion: ${conclusion}). No tag was created. ` +
				'Fix or rerun CI, then run "npm run release:promote" to resume.',
		);
	}

	console.log(`  CI succeeded for ${releaseSha}. Tagging ${tag}...`);
	try {
		// Release tags are plain lightweight refs. Disable host-level forced tag
		// signing/annotation (tag.gpgSign) so tagging never depends on local
		// signing setup.
		run(`git -c tag.gpgSign=false tag ${tag} ${releaseSha}`);
		run(`git push origin ${tag}`);
	} catch (error) {
		run(`git tag -d ${tag}`, { ignoreError: true });
		throw error;
	}

	console.log(`\n=== Released ${tag}; CI publishing starts now ===\n`);
}

// Main flow
console.log("\n=== Release Script ===\n");

try {
	if (RELEASE_TARGET === "promote") {
		await promoteRelease();
	} else {
		const version = prepareRelease();
		await promoteRelease(version);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
