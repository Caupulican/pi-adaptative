/**
 * Local test selection for the commit gate.
 *
 * `vitest related` (what CI runs, see ci-affected.mjs) follows the whole import graph. In this repo
 * that graph is dense: changing python-runtime.ts selects 429 coding-agent test files (~10 minutes),
 * so it cannot run on every commit. The commit gate instead runs the tests that import a staged
 * source file directly, which is bounded and catches the tests written for that module. The rest of
 * the transitive set stays CI's job, and a red CI run comes back to every later commit through
 * `ci-status.mjs` (see carriedFailingTests).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const IMPORT_SPECIFIER =
	/(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|\bvi\.mock\(\s*)(["'])(\.\.?\/[^"']+)\1/gu;
const RESOLVABLE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", "/index.ts"];

/** Every relative module specifier a test file imports, mocks, or requires. */
export function relativeImportSpecifiers(text) {
	const specifiers = new Set();
	IMPORT_SPECIFIER.lastIndex = 0;
	for (let match = IMPORT_SPECIFIER.exec(text); match; match = IMPORT_SPECIFIER.exec(text)) specifiers.add(match[2]);
	return [...specifiers];
}

/** Candidate repo-relative paths a specifier from `fromFile` may name (`.js` specifiers name `.ts` sources). */
export function resolveSpecifierCandidates(fromFile, specifier) {
	const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
	const stem = base.replace(/\.(?:js|mjs)$/u, "");
	return [...new Set([base, ...RESOLVABLE_EXTENSIONS.map((extension) => `${stem}${extension}`)])];
}

/**
 * Test files (repo-relative) that directly import one of `changedFiles`. Pure: the caller supplies
 * the candidate test list and a text reader.
 */
export function directImporterTests(changedFiles, testFiles, readText) {
	const changed = new Set(changedFiles.map((path) => path.replaceAll("\\", "/")));
	if (changed.size === 0) return [];
	return testFiles.filter((testFile) => {
		if (changed.has(testFile)) return false;
		return relativeImportSpecifiers(readText(testFile)).some((specifier) =>
			resolveSpecifierCandidates(testFile, specifier).some((candidate) => changed.has(candidate)),
		);
	});
}

/**
 * A module imported directly by more than this many tests is a hub (settings-manager, agent-session):
 * its importers are most of the suite, which is CI's job. For a hub only the tests named after it run.
 */
export const HUB_IMPORTER_THRESHOLD = 25;

/** The commit gate's selection: direct importers of each changed file, narrowed to named tests for hubs. */
export function selectCommitTests(changedFiles, testFiles, readText, hubThreshold = HUB_IMPORTER_THRESHOLD) {
	const selected = new Set();
	const text = new Map();
	const read = (path) => {
		if (!text.has(path)) text.set(path, readText(path));
		return text.get(path);
	};
	for (const changed of changedFiles) {
		const importers = directImporterTests([changed], testFiles, read);
		const stem = changed.split("/").pop().replace(/\.[^.]+$/u, "");
		const kept =
			importers.length > hubThreshold ? importers.filter((test) => test.split("/").pop().startsWith(stem)) : importers;
		for (const test of kept) selected.add(test);
	}
	return [...selected].sort();
}

/** Every `*.test.ts` under `<workspace>/test`, repo-relative, excluding the destructive suite. */
export function listWorkspaceTests(repoRoot, workspace) {
	const root = join(repoRoot, workspace, "test");
	if (!existsSync(root)) return [];
	const found = [];
	const walk = (directory, relative) => {
		for (const entry of readdirSync(directory)) {
			if (entry === "node_modules" || entry.startsWith(".")) continue;
			const full = join(directory, entry);
			const rel = relative ? `${relative}/${entry}` : entry;
			if (statSync(full).isDirectory()) walk(full, rel);
			else if (/\.test\.ts$/u.test(entry)) found.push(`${workspace}/test/${rel}`);
		}
	};
	walk(root, "");
	return found.sort();
}

/** The same, reading the repository on disk. */
export function findDirectImporterTests(repoRoot, workspace, changedFiles) {
	const inWorkspace = changedFiles.filter((path) => path.startsWith(`${workspace}/src/`));
	if (inWorkspace.length === 0) return [];
	return directImporterTests(inWorkspace, listWorkspaceTests(repoRoot, workspace), (path) =>
		readFileSync(join(repoRoot, path), "utf8"),
	);
}

/** The commit gate's selection for one workspace, reading the repository on disk. */
export function findCommitTests(repoRoot, workspace, changedFiles) {
	const inWorkspace = changedFiles.filter((path) => path.startsWith(`${workspace}/src/`));
	if (inWorkspace.length === 0) return [];
	return selectCommitTests(inWorkspace, listWorkspaceTests(repoRoot, workspace), (path) =>
		readFileSync(join(repoRoot, path), "utf8"),
	);
}
