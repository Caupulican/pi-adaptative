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
 * The release flow is split into two gated phases. Neither phase needs main to stand still: pushes that
 * land while a release waits or runs are simply part of the next release.
 *
 * PREPARE (major|minor|patch|x.y.z) - a pure function of the committed tree, no tag:
 * 1. Preflight: on main, clean tree, local main is behind-or-equal origin/main and fast-forwards to it,
 *    prospective tag unused, and the base commit's own ci.yml has not already concluded red.
 *    Nothing waits for a green ci.yml here: the tag's quality-gate is the single full CI of the release commit.
 * 2. Run local checks below; GitHub Actions on the exact tag is the platform/provider and
 *    artifact-acceptance authority.
 * 3. Bump version via npm run version:xxx or set an explicit version.
 * 4. Update CHANGELOG.md files: [Unreleased] -> [version] - date.
 * 5. Run checks.
 * 6. Commit "Release vX.Y.Z", add the next-cycle [Unreleased] sections, commit them, and publish both
 *    with one push. A push refused because origin/main moved is a lost race: nothing remote changed, the
 *    script exits 75 and release.yml restarts it from the new tip (never the bump on top of a pushed one).
 * Any other failure during steps 3-6 retains files, index and commits for state-aware recovery.
 *
 * REPAIR - recover an untagged prepared version after a gate exposed a required fix:
 * - Require the original Release commit in current main's ancestry and a free version tag.
 * - Fold the notes added to the next-cycle [Unreleased] sections since then into the version
 *   section, commit "Repair release vX.Y.Z", and push it as the new release candidate without
 *   another version bump. Restore the next-cycle sections afterward.
 * - Promote the repaired candidate: tag it.
 *
 * PROMOTE (automatic after prepare, or standalone via `promote` to resume later):
 * 8. Locate the "Release vX.Y.Z" commit.
 * 9. Create and push the vX.Y.Z tag, which triggers build-binaries.yml. That workflow runs the
 *    complete ci.yml matrix as quality-gate, in parallel with the binary build, and publishes assets
 *    only after that matrix and provenance succeed. The release commit is not given a second ci.yml
 *    run before the tag.
 * If the tag workflow fails, rerun that tag workflow or delete the tag, fix, then
 * `npm run release:repair`. Never rerun prepare (release:patch/minor/major) for the same
 * version once its release commit has been pushed.
 */

import { execSync } from "child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { parseGithubOriginSlug } from "./github-origin.mjs";
import { executeReleaseMutation, ReleaseRaceError } from "./release-recovery.mjs";
import {
	matchesReleaseCandidateSubject,
	partitionReleaseChanges,
	mainCiGateDecision,
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

if (
	RELEASE_TARGET !== "promote" &&
	!isPrepareTarget &&
	!isRepairTarget &&
	!isAdoptTarget &&
	RELEASE_TARGET !== "status"
) {
	console.error("Usage: node scripts/release.mjs <major|minor|patch|x.y.z|repair|adopt|status|promote>");
	process.exit(1);
}

const MAIN_CI_WORKFLOW = "ci.yml";

/** Exit status that tells release.yml the run lost a push race and can start again from the new origin/main. */
const RACE_EXIT_CODE = 75;

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

function getVersion() {
	const pkg = JSON.parse(readFileSync("packages/ai/package.json", "utf-8"));
	return pkg.version;
}

function getReleaseSource() {
	return {
		branch: run("git rev-parse --abbrev-ref HEAD", { silent: true }).trim(),
		sha: run("git rev-parse HEAD", { silent: true }).trim(),
	};
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
			`${target} --workspaces --no-git-tag-version --workspaces-update=false && node scripts/sync-versions.js && npm install --package-lock-only --ignore-scripts`,
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

/**
 * Fold the notes added to each next-cycle [Unreleased] section since the release commit into the prepared
 * version's section, or drop the marker when it is empty. Commits pushed after the release commit are part of
 * the repaired candidate, so their notes ship with it; requiring empty markers would leave no repair path
 * while main keeps moving.
 */
function foldUnreleasedIntoPreparedVersion(version) {
	const updates = getChangelogs().map((changelog) => {
		const content = readFileSync(changelog, "utf-8");
		if (!content.includes(`## [${version}]`)) {
			throw new Error(`${changelog} has no section for prepared version ${version}.`);
		}
		try {
			return { changelog, content: prepareAdoptedChangelog(content, version) };
		} catch (error) {
			throw new Error(`${changelog} ${error instanceof Error ? error.message : String(error)}; refusing release repair.`);
		}
	});
	for (const update of updates) {
		writeFileSync(update.changelog, update.content);
		console.log(`  Folded [Unreleased] into [${version}] in ${update.changelog}`);
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
		console.error("Error: Uncommitted changes detected. Commit owned changes or resolve unexpected changes before releasing.");
		console.error(status);
		process.exit(1);
	}
	console.log("  Working directory clean");

	console.log("  Fetching origin...");
	run("git fetch origin --tags", { silent: true });

	// origin/main is the release base. Commits pushed while this run waited or queued are part of it, so a
	// behind checkout fast-forwards instead of aborting; only local commits origin/main lacks are an error.
	const isBehindOrEqual = run("git merge-base --is-ancestor HEAD origin/main", { silent: true, ignoreError: true });
	if (isBehindOrEqual === null) {
		console.error("Error: local main has commits origin/main lacks (ahead or diverged). Push or rebase before releasing.");
		process.exit(1);
	}
	if (run("git rev-parse HEAD", { silent: true }).trim() !== run("git rev-parse origin/main", { silent: true }).trim()) {
		run("git merge --ff-only origin/main");
	}

	assertTagIsFree(prospectiveVersion);

	const source = getReleaseSource();
	rejectRedMainCi(source.sha);
	console.log(`  Preflight OK at ${source.sha} (prospective version ${prospectiveVersion})\n`);
	return source.sha;
}

/**
 * Fail fast when the base commit's own ci.yml already concluded red: nothing a release adds can fix it.
 * A run still in progress or not yet registered does not block: the tag's quality-gate runs the full
 * ci.yml on the release commit itself, in parallel with the binary build, and that run decides.
 */
function rejectRedMainCi(sha) {
	const listing = run(
		`gh run list -R ${shellQuote(getRepoSlug())} --workflow=${MAIN_CI_WORKFLOW} --commit ${shellQuote(sha)} --json headSha,status,conclusion,url --limit 20`,
		{ silent: true, ignoreError: true },
	);
	const runs = listing ? JSON.parse(listing) : [];
	const decision = mainCiGateDecision(runs, sha);
	if (decision.verdict === "red") {
		const urls = runs.filter((entry) => entry.headSha === sha).map((entry) => entry.url).join("\n  ");
		console.error(
			`${MAIN_CI_WORKFLOW} on ${sha} concluded "${decision.conclusion}"; main is not releasable.\n  ${urls}\n` +
				"Fix the failures on main, then release again.",
		);
		process.exit(1);
	}
	console.log(`  ${MAIN_CI_WORKFLOW} on ${sha}: ${decision.verdict === "green" ? "success" : decision.verdict === "wait" ? decision.status : "not registered yet"}`);
}

function prepareRelease() {
	console.log("\n=== Preparing release ===\n");
	const prospectiveVersion = computeProspectiveVersion();
	const preflightSha = preflight(prospectiveVersion);

	return executeReleaseMutation({ phase: "prepare", sha: preflightSha }, getReleaseSource, () => {
		// 2. Local checks do not replace exact-tag platform/provider and artifact gates.
		console.log(`Local checks run below; exact-tag GitHub platform/provider and artifact gates remain required.\n`);

		// 3. Bump or set version
		const version = bumpOrSetVersion(RELEASE_TARGET);
		console.log(`  New version: ${version}\n`);

		// 4. Update changelogs
		console.log("Updating CHANGELOG.md files...");
		updateChangelogsForRelease(version);
		console.log();

		finishPreparedRelease(`Release v${version}`, preflightSha);

		return version;
	});
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
	const preflightSha = preflight(version, recoveredPaths);
	if (findReleaseCandidateSha(version)) throw new Error("A canonical candidate already exists; use release:repair or release:promote.");
	validateAdoptionVersions(".", version);
	const updates = getChangelogs().map((path) => ({ path, content: prepareAdoptedChangelog(readFileSync(path, "utf8"), version) }));
	if (updates.length === 0) throw new Error("No changelogs found for release adoption.");
	return executeReleaseMutation({ phase: "adopt", sha: preflightSha }, getReleaseSource, () => {
		console.log(`Adopting prepared version ${version} without another version bump...`);
		for (const update of updates) writeFileSync(update.path, update.content);
		finishPreparedRelease(`Release v${version}`, preflightSha);
		return version;
	});
}

/**
 * Both release commits are committed locally and published by one push, so there is no state in which the
 * release commit is on origin/main without its next-cycle markers, and a concurrent push can only reject the
 * whole publication.
 */
function finishPreparedRelease(subject, baseSha) {
	console.log("Running checks...");
	run("npm run check");
	stageChangedFiles();
	run(`git commit -m ${shellQuote(subject)}`);
	addUnreleasedSection();
	stageChangedFiles();
	run('git commit -m "Add [Unreleased] section for next cycle"');
	publishPreparedRelease(baseSha);
}

/**
 * A refused push of commits built on `baseSha` is a lost race when origin/main has since moved and does not
 * contain them: nothing remote changed and the run can start again from the new tip. A push whose outcome is
 * unknown but whose commits are on origin/main already succeeded, and is never repeated (that would bump twice).
 */
function publishPreparedRelease(baseSha) {
	try {
		run("git push origin main");
	} catch (error) {
		run("git fetch origin", { silent: true });
		const published = run("git merge-base --is-ancestor HEAD origin/main", { silent: true, ignoreError: true });
		if (published !== null) return;
		const tip = run("git rev-parse origin/main", { silent: true }).trim();
		if (tip !== baseSha) {
			throw new ReleaseRaceError(`origin/main moved from ${baseSha} to ${tip} while the release was prepared; nothing was pushed.`);
		}
		throw error;
	}
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

	return executeReleaseMutation({ phase: "repair", sha: preflightSha }, getReleaseSource, () => {
		console.log(`Repairing prepared version ${version} without another version bump...`);
		foldUnreleasedIntoPreparedVersion(version);
		console.log();

		finishPreparedRelease(`Repair release v${version}`, preflightSha);

		return version;
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

function promoteRelease(versionArg) {
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

	if (existingLocalTag?.trim()) {
		ensureTagPushed(tag);
		console.log(`\n=== ${tag} already promoted ===\n`);
		return;
	}
	console.log(`  Tagging ${tag} at ${releaseSha}; the tag's quality-gate runs the full ci.yml on it before any asset is published...`);
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

	console.log(`\n=== Promoted ${tag}; standalone artifact publication remains gated ===\n`);
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
		promoteRelease(adoptRelease());
	} else if (RELEASE_TARGET === "promote") {
		promoteRelease();
	} else if (isRepairTarget) {
		promoteRelease(prepareReleaseRepair());
	} else {
		promoteRelease(prepareRelease());
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	// 75 (EX_TEMPFAIL): the push lost a race and nothing remote changed; release.yml starts over from the new tip.
	process.exit(error instanceof ReleaseRaceError ? RACE_EXIT_CODE : 1);
}
