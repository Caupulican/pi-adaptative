import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

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
				if (entry.isDirectory()) dirs.push(join(parentRel, entry.name));
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
		if (existsSync(join(repoRoot, dir, "package.json"))) allowlist.add(join(dir, "package.json"));
		if (existsSync(join(repoRoot, dir, "package-lock.json"))) allowlist.add(join(dir, "package-lock.json"));
	}

	const packagesDir = join(repoRoot, "packages");
	if (existsSync(packagesDir)) {
		for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
			if (!entry.isDirectory()) continue;
			const changelogRel = join("packages", entry.name, "CHANGELOG.md");
			if (existsSync(join(repoRoot, changelogRel))) allowlist.add(changelogRel);
		}
	}

	const aiSrcDir = join(repoRoot, "packages", "ai", "src");
	if (existsSync(aiSrcDir)) {
		for (const file of readdirSync(aiSrcDir)) {
			if (file.endsWith(".generated.ts")) allowlist.add(join("packages", "ai", "src", file));
		}
	}

	const shrinkwrapRel = join("packages", "coding-agent", "npm-shrinkwrap.json");
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

export function partitionReleaseChanges(statusOutput, repoRoot = ".") {
	const allowlist = computeReleaseAllowlist(repoRoot);
	const changedPaths = collectChangedPaths(statusOutput);
	return {
		allowed: changedPaths.filter((path) => allowlist.has(path)),
		unexpected: changedPaths.filter((path) => !allowlist.has(path)),
	};
}
