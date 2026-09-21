#!/usr/bin/env node
/**
 * Release script for Pi Adaptative
 *
 * Usage:
 *   node scripts/release.mjs <major|minor|patch>
 *   node scripts/release.mjs <x.y.z>
 *   node scripts/release.mjs repair
 *   node scripts/release.mjs promote
 *   node scripts/release.mjs adopt
 *   node scripts/release.mjs status
 *
 * The release flow is split into two gated phases. The complete ci.yml matrix runs
 * only on the version tag (build-binaries.yml quality-gate), not on ordinary commits.
 *
 * PREPARE (major|minor|patch|x.y.z) - a pure function of the committed tree, no tag:
 * 1. Preflight: on main, clean tree, origin/main is an ancestor of HEAD, prospective tag unused.
 * 2. The release command never runs the full suite locally. GitHub Actions on the tag is
 *    the full-suite authority.
 * 3. Bump version via npm run version:xxx or set an explicit version.
 * 4. Update CHANGELOG.md files: [Unreleased] -> [version] - date.
 * 5. Run checks.
 * 6. Commit "Release vX.Y.Z" and push main.
 * 7. Add new [Unreleased] sections to changelogs, commit, and push main again.
 * Any failure during steps 3-7 resets the local tree back to the preflight commit.
 *
 * REPAIR - recover an untagged prepared version after a gate exposed a required fix:
 * - Require the original Release commit in current main's ancestry, a free version tag,
 *   and empty next-cycle changelog sections.
 * - Remove only those empty sections, commit "Repair release vX.Y.Z", and push it as the new
 *   release candidate without another version bump. Restore the next-cycle sections afterward.
 * - Promote the repaired candidate through the destructive gate, then tag.
 *
 * PROMOTE (automatic after prepare, or standalone via `promote` to resume later):
 * 8. Locate the "Release vX.Y.Z" commit.
 * 9. Poll destructive.yml on that exact SHA. If none exists, push `release-vX.Y.Z` at that
 *     SHA and dispatch workflow_dispatch on that branch (GitHub rejects a raw SHA ref).
 * 10. Only on destructive success: create and push the vX.Y.Z tag, which triggers
 *     build-binaries.yml. That workflow runs the complete ci.yml matrix as quality-gate
 *     and publishes assets only after that matrix and provenance succeed.
 * If the tag workflow fails, rerun that tag workflow or delete the tag, fix, then
 * `npm run release:repair`. Never rerun prepare (release:patch/minor/major) for the same
 * version once its release commit has been pushed.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseGithubOriginSlug } from "./github-origin.mjs";
import {
	matchesReleaseCandidateSubject,
	partitionReleaseChanges,
	pickWorkflowConclusion,
	stripEmptyUnreleasedSection,
	prepareAdoptedChangelog,
	validateAdoptionVersions,
	collectChangedPaths,
} from "./release-staging.mjs";

const RELEASE_TARGET = process.argv[2];
const BUMP_TYPES = new Set(["major", "minor", "patch"]);
const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const isPrepareTarget = BUMP_TYPES.has(RELEASE_TARGET) || SEMVER_RE.test(RELEASE_TARGET);
const isRepairTarget = RELEASE_TARGET === "repair";
const isAdoptTarget = RELEASE_TARGET === "adopt";

if (RELEASE_TARGET !== "promote" && !isPrepareTarget && !isRepairTarget && !isAdoptTarget && RELEASE_TARGET !== "status") {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z|repair|adopt|status|promote>");
	process.exit(1);
}

const DESTRUCTIVE_WORKFLOW = "destructive.yml";
const CI_POLL_INTERVAL_MS = Number.parseInt(process.env.PI_RELEASE_WORKFLOW_POLL_INTERVAL_MS ?? "", 10) || 20_000;
const CI_POLL_TIMEOUT_MS = Number.parseInt(process.env.PI_RELEASE_WORKFLOW_POLL_TIMEOUT_MS ?? "", 10) || 60 * 60_000;

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
	const fromEnv = process.env.GH_REPO?.trim();
	if (fromEnv) return fromEnv;
	const url = run("git remote get-url origin", { silent: true }).trim();
	try {
		return parseGithubOriginSlug(url);
	} catch {
		throw new Error(`Could not parse a GitHub owner/repo from origin remote URL: ${url}`);
	}
}

function stageChangedFiles() {
	const statusOutput = run("git status --porcelain", { silent: true }) || "";
	const { allowed, unexpected } = partitionReleaseChanges(statusOutput);

	if (unexpected.length > 0) {
		throw new Error(
			`Unexpected working-tree changes outside the release allowlist; refusing to stage them:\n${unexpected
				.map((path) => `  ${path}`)
				.join("\n")}`,
		);
	}

	if (allowed.length === 0) {
		return;
	}
	run(`git add -- ${allowed.map(shellQuote).join(" ")}`);
}

function bumpOrSetVersion(target) {
	// Keep npm's package-age gate scoped to the lockfile refresh used by versioning. This
	// prevents a recently resolved dependency from making a release non-reproducible.
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

function removeEmptyUnreleasedSections(version) {
	const updates = getChangelogs().map((changelog) => {
		const content = readFileSync(changelog, "utf-8");
		if (!content.includes(`## [${version}]`)) {
			throw new Error(`${changelog} has no section for prepared version ${version}.`);
		}
		try {
			return { changelog, content: stripEmptyUnreleasedSection(content) };
		} catch (error) {
			throw new Error(`${changelog} ${error instanceof Error ? error.message : String(error)}; refusing release repair.`);
		}
	});
	for (const update of updates) {
		writeFileSync(update.changelog, update.content);
		console.log(`  Removed empty [Unreleased] from ${update.changelog}`);
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
function preflight(prospectiveVersion, recoveredPaths = new Set()) {
	console.log("Running preflight checks...");

	const branch = run("git rev-parse --abbrev-ref HEAD", { silent: true }).trim();
	if (branch !== "main") {
		console.error(`Error: releases must run from the "main" branch (currently on "${branch}").`);
		process.exit(1);
	}

	const status = run("git status --porcelain", { silent: true });
	if (status && collectChangedPaths(status).some((path) => !recoveredPaths.has(path))) {
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
	const prospectiveVersion = computeProspectiveVersion();
	const preflightSha = preflight(prospectiveVersion);

	try {
		// 2. The tag workflow is the full-suite authority. Prepare never runs the local suite.
		console.log(`GitHub Actions on the version tag is the full-suite authority; no local suite is run.\n`);

		// 3. Bump or set version
		const version = bumpOrSetVersion(RELEASE_TARGET);
		console.log(`  New version: ${version}\n`);

		// 4. Update changelogs
		console.log("Updating CHANGELOG.md files...");
		updateChangelogsForRelease(version);
		console.log();

		finishPreparedRelease(`Release v${version}`);

		return version;
	} catch (error) {
		rollbackToPreflightSha(preflightSha);
		throw error;
	}
}

function findReleaseCandidateSha(version, includeRepairs = true) {
	run("git fetch origin --tags", { silent: true });
	const log = run("git log origin/main --format=%H%x1f%s", { silent: true }) || "";
	for (const line of log.split("\n")) {
		if (!line) continue;
		const separatorIndex = line.indexOf("\x1f");
		if (separatorIndex === -1) continue;
		const sha = line.slice(0, separatorIndex);
		const subject = line.slice(separatorIndex + 1);
		if (includeRepairs ? matchesReleaseCandidateSubject(subject, version) : subject === `Release v${version}`) return sha;
	}
	return undefined;
}

function adoptRelease() {
	const version = getVersion();
	// Recover only bytes this deterministic transformation would have written from HEAD.
	// An unrelated edit, including another session's changelog note, still fails preflight.
	const recoveredPaths = new Set();
	for (const path of getChangelogs()) {
		const original = run(`git show ${shellQuote(`HEAD:${path}`)}`, { silent: true });
		const expected = prepareAdoptedChangelog(original, version);
		if (readFileSync(path, "utf8") === expected) recoveredPaths.add(path);
	}
	preflight(version, recoveredPaths);
	if (findReleaseCandidateSha(version)) throw new Error("A canonical candidate already exists; use release:repair or release:promote.");
	validateAdoptionVersions(".", version);
	const updates = getChangelogs().map((path) => ({ path, content: prepareAdoptedChangelog(readFileSync(path, "utf8"), version) }));
	if (updates.length === 0) throw new Error("No changelogs found for release adoption.");
	console.log(`Adopting prepared version ${version} without another version bump...`);
	for (const update of updates) writeFileSync(update.path, update.content);
	// On failure, retain the bounded edits for inspection. Never reset a shared worktree.
	finishPreparedRelease(`Release v${version}`);
	return version;
}

function finishPreparedRelease(subject) {
	console.log("Running checks...");
	run("npm run check");
	stageChangedFiles();
	run(`git commit -m ${shellQuote(subject)}`);
	run("git push origin main");
	addUnreleasedSection();
	stageChangedFiles();
	run('git commit -m "Add [Unreleased] section for next cycle"');
	run("git push origin main");
}

function prepareReleaseRepair() {
	console.log("\n=== Repairing untagged release ===\n");
	const version = getVersion();
	const preflightSha = preflight(version);
	const originalReleaseSha = findReleaseCandidateSha(version, false);
	if (!originalReleaseSha) {
		throw new Error(`Could not find the original "Release v${version}" commit; refusing release repair.`);
	}
	const isAncestor = run(`git merge-base --is-ancestor ${shellQuote(originalReleaseSha)} HEAD`, {
		silent: true,
		ignoreError: true,
	});
	if (isAncestor === null) {
		throw new Error(`Original release commit ${originalReleaseSha} is not an ancestor of HEAD; refusing release repair.`);
	}

	try {
		console.log(`Repairing prepared version ${version} without another version bump...`);
		removeEmptyUnreleasedSections(version);
		console.log();

		finishPreparedRelease(`Repair release v${version}`);

		return version;
	} catch (error) {
		rollbackToPreflightSha(preflightSha);
		throw error;
	}
}

async function waitForWorkflow(sha, workflow, options = {}) {
	const repo = getRepoSlug();
	console.log(`  Waiting for ${workflow} on ${sha} in ${repo}...`);
	const deadline = Date.now() + CI_POLL_TIMEOUT_MS;
	let dispatched = false;

	while (Date.now() < deadline) {
		const listing = run(
			`gh run list -R ${shellQuote(repo)} --workflow=${workflow} --json headSha,status,conclusion --limit 30`,
			{ silent: true, ignoreError: true },
		);
		if (listing) {
			const runs = JSON.parse(listing);
			const match = pickWorkflowConclusion(runs, sha);
			if (match.state === "completed") {
				console.log(`  ${workflow} for ${sha}: ${match.conclusion}`);
				return match.conclusion;
			}
			if (match.state === "pending") {
				console.log(`  ${workflow} for ${sha}: ${match.status}...`);
			} else if (options.dispatchIfMissing && !dispatched) {
				const dispatchRef = options.dispatchRef;
				if (!dispatchRef) {
					throw new Error(`Cannot dispatch ${workflow}: dispatchRef is required (workflow_dispatch rejects a raw SHA).`);
				}
				console.log(`  No ${workflow} run on ${sha}; dispatching on ${dispatchRef}...`);
				run(`git push origin ${shellQuote(sha)}:refs/heads/${dispatchRef}`);
				const dispatchedRun = run(
					`gh workflow run ${workflow} -R ${shellQuote(repo)} --ref ${shellQuote(dispatchRef)}`,
					{ ignoreError: true },
				);
				if (dispatchedRun === undefined) {
					throw new Error(`Failed to dispatch ${workflow} on ${dispatchRef}.`);
				}
				dispatched = true;
			} else {
				console.log(`  ${workflow} run not registered yet...`);
			}
		}
		await sleep(CI_POLL_INTERVAL_MS);
	}

	throw new Error(`Timed out after ${Math.round(CI_POLL_TIMEOUT_MS / 60_000)}m waiting for ${workflow} on ${sha}.`);
}

async function waitForDestructive(sha, version) {
	return waitForWorkflow(sha, DESTRUCTIVE_WORKFLOW, {
		dispatchIfMissing: true,
		dispatchRef: `release-v${version}`,
	});
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

	const releaseSha = findReleaseCandidateSha(version);
	if (!releaseSha) {
		throw new Error(
			`Could not find a release candidate for v${version} in any ref (local or origin). Run ` +
				'"npm run release:patch|minor|major" to prepare it, or "npm run release:repair" after a corrected failed gate.',
		);
	}
	console.log(`  Release candidate: ${releaseSha}`);
	if (existingLocalTag?.trim()) {
		const taggedSha = run(`git rev-parse ${shellQuote(`${tag}^{commit}`)}`, { silent: true }).trim();
		if (taggedSha !== releaseSha) throw new Error(`Existing ${tag} does not name release candidate ${releaseSha}.`);
	}

	const destructive = await waitForDestructive(releaseSha, version);
	if (destructive !== "success") {
		throw new Error(
			`Destructive suite did not succeed for release commit ${releaseSha} (conclusion: ${destructive}). ` +
				"No tag was created. Fix or rerun destructive.yml, then run \"npm run release:promote\" to resume.",
		);
	}

	if (existingLocalTag?.trim()) {
		ensureTagPushed(tag);
		console.log(`\n=== ${tag} already promoted ===\n`);
		return;
	}
	console.log(`  Destructive suite succeeded for ${releaseSha}. Tagging ${tag}...`);
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

	console.log(`\n=== Released ${tag}; standalone binary publishing starts now ===\n`);
}

// Main flow
console.log("\n=== Release Script ===\n");

try {
	if (RELEASE_TARGET === "status") {
		const version = getVersion();
		const repo = getRepoSlug();
		const sha = run("git rev-parse HEAD", { silent: true }).trim();
		console.log(JSON.stringify({ version, repo, sha, workingTree: run("git status --porcelain", { silent: true }).trim(), remoteTag: run(`git ls-remote --tags origin ${shellQuote(`v${version}`)}`, { silent: true }).trim() }, null, 2));
	} else if (RELEASE_TARGET === "adopt") {
		await promoteRelease(adoptRelease());
	} else if (RELEASE_TARGET === "promote") {
		await promoteRelease();
	} else if (isRepairTarget) {
		const version = prepareReleaseRepair();
		await promoteRelease(version);
	} else {
		const version = prepareRelease();
		await promoteRelease(version);
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
