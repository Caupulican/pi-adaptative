import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Git porcelain and allowlist keys are POSIX paths on every host. */
function posixJoin(...parts) {
	return parts
		.filter((part) => part.length > 0)
		.join("/")
		.replace(/\\/g, "/");
}

/**
 * Git porcelain is a fixed 3-character prefix (`XY `). X or Y may themselves be
 * a space (unstaged-only is ` M path`). Never trim the line before slicing.
 */
export function parsePorcelainPath(line) {
	if (line.length < 4) return "";
	const path = line.slice(3);
	const arrowIndex = path.indexOf(" -> ");
	const finalPath = arrowIndex === -1 ? path : path.slice(arrowIndex + 4);
	return finalPath.replace(/^"/, "").replace(/"$/, "");
}

export function collectChangedPaths(statusOutput) {
	return (statusOutput || "")
		.split(/\r?\n/)
		.filter((line) => line.length >= 4)
		.map(parsePorcelainPath)
		.filter(Boolean);
}

function workspacePackageRelDirs(repoRoot) {
	const rootPkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
	const dirs = [];
	for (const pattern of rootPkg.workspaces ?? []) {
		if (pattern.endsWith("/*")) {
			const parentRel = pattern.slice(0, -2);
			const parentAbs = join(repoRoot, parentRel);
			if (!existsSync(parentAbs)) continue;
			for (const entry of readdirSync(parentAbs, { withFileTypes: true })) {
				if (entry.isDirectory()) dirs.push(posixJoin(parentRel, entry.name));
			}
			continue;
		}
		if (existsSync(join(repoRoot, pattern))) dirs.push(pattern);
	}
	return dirs;
}

/** Git-relative paths a lockstep version bump + changelog rewrite may stage. */
export function computeReleaseAllowlist(repoRoot = ".") {
	const allowlist = new Set(["package.json", "package-lock.json"]);

	for (const dir of workspacePackageRelDirs(repoRoot)) {
		if (existsSync(join(repoRoot, dir, "package.json"))) allowlist.add(posixJoin(dir, "package.json"));
		if (existsSync(join(repoRoot, dir, "package-lock.json"))) allowlist.add(posixJoin(dir, "package-lock.json"));
	}

	const packagesDir = join(repoRoot, "packages");
	if (existsSync(packagesDir)) {
		for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const changelogRel = posixJoin("packages", entry.name, "CHANGELOG.md");
			if (existsSync(join(repoRoot, changelogRel))) allowlist.add(changelogRel);
		}
	}

	const aiSrcDir = join(repoRoot, "packages", "ai", "src");
	if (existsSync(aiSrcDir)) {
		for (const file of readdirSync(aiSrcDir)) {
			if (file.endsWith(".generated.ts")) allowlist.add(posixJoin("packages", "ai", "src", file));
		}
	}

	const shrinkwrapRel = posixJoin("packages", "coding-agent", "npm-shrinkwrap.json");
	if (existsSync(join(repoRoot, shrinkwrapRel))) allowlist.add(shrinkwrapRel);

	return allowlist;
}

/** Prefer a successful run for a SHA over an earlier cancelled/failed one. */
export function pickWorkflowConclusion(runs, sha) {
	const matches = runs.filter((run) => run.headSha === sha);
	if (matches.some((run) => run.conclusion === "success")) return { state: "completed", conclusion: "success" };
	const active = matches.find((run) => run.status !== "completed");
	if (active) return { state: "pending", status: active.status };
	const done = matches.find((run) => run.status === "completed");
	if (done) return { state: "completed", conclusion: done.conclusion };
	return { state: "missing" };
}

/**
 * Snapshot verdict for starting a versioned prepare. Never polls: an unfinished
 * or missing CI run is a hard refuse so we do not buy a second full matrix.
 */
export function interpretHeadWorkflow(match, sha, workflow) {
	if (match.state === "completed" && match.conclusion === "success") return { ok: true };
	if (match.state === "pending") {
		return {
			ok: false,
			error: `HEAD ${sha} ${workflow} is ${match.status}. Wait for that run to succeed, then retry prepare. Do not start a versioned release while CI is unfinished.`,
		};
	}
	if (match.state === "completed") {
		return {
			ok: false,
			error: `HEAD ${sha} ${workflow} concluded ${match.conclusion}. Fix that commit; do not prepare a new version on a red tree.`,
		};
	}
	return {
		ok: false,
		error: `HEAD ${sha} has no ${workflow} run. Push main and wait for CI to succeed before prepare.`,
	};
}

export function matchesReleaseCandidateSubject(subject, version) {
	return subject === `Release v${version}` || subject === `Repair release v${version}`;
}

/** Remove the next-cycle marker only when it contains no release notes. */
export function stripEmptyUnreleasedSection(content) {
	const marker = /^## \[Unreleased\][ \t]*\r?$/m.exec(content);
	if (!marker || marker.index === undefined) {
		throw new Error('has no "## [Unreleased]" section');
	}
	const firstVersionHeading = /^## \[[^\r\n]+\][^\r\n]*\r?$/m.exec(content);
	if (!firstVersionHeading || firstVersionHeading.index !== marker.index) {
		throw new Error('does not have "## [Unreleased]" as its first version section');
	}

	const bodyStart = marker.index + marker[0].length;
	const nextHeading = /\r?\n## \[[^\r\n]+\]/.exec(content.slice(bodyStart));
	if (!nextHeading || nextHeading.index === undefined) {
		throw new Error('has no released version section after "## [Unreleased]"');
	}

	const nextHeadingStart = bodyStart + nextHeading.index;
	if (content.slice(bodyStart, nextHeadingStart).trim().length > 0) {
		throw new Error('the "## [Unreleased]" section contains release notes');
	}

	const headingOffset = content.startsWith("\r\n", nextHeadingStart) ? 2 : 1;
	return content.slice(0, marker.index) + content.slice(nextHeadingStart + headingOffset);
}

export function partitionReleaseChanges(statusOutput, repoRoot = ".") {
	const allowlist = computeReleaseAllowlist(repoRoot);
	const changedPaths = collectChangedPaths(statusOutput);
	return {
		allowed: changedPaths.filter((path) => allowlist.has(path)),
		unexpected: changedPaths.filter((path) => !allowlist.has(path)),
	};
}
