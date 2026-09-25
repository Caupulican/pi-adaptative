/**
 * Local test selection for the commit gate.
 *
 * `vitest related` (what CI runs, see ci-affected.mjs) follows the whole import graph. In this repo
 * that graph is dense: changing python-runtime.ts selects 429 coding-agent test files (~10 minutes),
 * so it cannot run on every commit. The commit gate instead runs the tests that import a staged
 * source file directly, which is bounded and catches the tests written for that module. The rest of
 * the transitive set stays CI's job, and a red CI run comes back to every later commit through
 * `ci-status.mjs` (see commitObligation).
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const IMPORT_PREFIX = String.raw`(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+|\brequire\(\s*|\bvi\.mock\(\s*)`;
const IMPORT_SPECIFIER = new RegExp(`${IMPORT_PREFIX}(["'])(\\.\\.?\\/[^"']+)\\1`, "gu");
const PACKAGE_SPECIFIER = new RegExp(`${IMPORT_PREFIX}(["'])(@[a-z0-9-]+\\/[a-z0-9-]+(?:\\/[^"']*)?)\\1`, "gu");
const REEXPORT_SPECIFIER =
	/\bexport\s+(?:type\s+)?(?:\*|\{[^}]*\})(?:\s+as\s+\w+)?\s+from\s+(["'])(\.\.?\/[^"']+)\1/gu;
const RESOLVABLE_EXTENSIONS = ["", ".ts", ".tsx", ".mts", "/index.ts"];
/** How deep a barrel's re-export chain is followed. */
const MAX_REEXPORT_DEPTH = 6;

function matchAll(pattern, text) {
	const found = new Set();
	pattern.lastIndex = 0;
	for (let match = pattern.exec(text); match; match = pattern.exec(text)) found.add(match[2]);
	return [...found];
}

/** Every relative module specifier a test file imports, mocks, or requires. */
export function relativeImportSpecifiers(text) {
	return matchAll(IMPORT_SPECIFIER, text);
}

/** Every workspace-package specifier (`@scope/name` or `@scope/name/subpath`) a file imports. */
export function packageImportSpecifiers(text) {
	return matchAll(PACKAGE_SPECIFIER, text);
}

/** Relative modules a file re-exports (`export * from`, `export { x } from`): what a barrel stands for. */
export function reexportSpecifiers(text) {
	return matchAll(REEXPORT_SPECIFIER, text);
}

/** Candidate repo-relative paths a specifier from `fromFile` may name (`.js` specifiers name `.ts` sources). */
export function resolveSpecifierCandidates(fromFile, specifier) {
	const base = posix.normalize(posix.join(posix.dirname(fromFile), specifier));
	const stem = base.replace(/\.(?:js|mjs)$/u, "");
	return [...new Set([base, ...RESOLVABLE_EXTENSIONS.map((extension) => `${stem}${extension}`)])];
}

/**
 * Map a workspace package specifier to its source file through the package's `exports` map and the
 * `pi-source` condition the tests resolve with. Unknown packages and subpaths map to nothing.
 */
export function createPackageResolver(packages) {
	return (specifier) => {
		for (const { name, directory, exports } of packages) {
			if (specifier !== name && !specifier.startsWith(`${name}/`)) continue;
			const subpath = specifier === name ? "." : `.${specifier.slice(name.length)}`;
			const entry = exports?.[subpath];
			const target = typeof entry === "string" ? entry : entry?.["pi-source"];
			return typeof target === "string" && target.startsWith("./src/")
				? posix.normalize(posix.join(directory, target))
				: undefined;
		}
		return undefined;
	};
}

/**
 * Test files (repo-relative) that directly import one of `changedFiles`: by relative path, or by a
 * workspace package specifier (`resolvePackage`, see createPackageResolver). An imported barrel
 * counts as importing what it re-exports, so `@scope/pkg/node` reaches the module behind it. Pure:
 * the caller supplies the candidate test list and a text reader that returns undefined for a file
 * that does not exist.
 */
export function directImporterTests(changedFiles, testFiles, readText, resolvePackage = () => undefined) {
	const changed = new Set(changedFiles.map((path) => path.replaceAll("\\", "/")));
	if (changed.size === 0) return [];
	const closures = new Map();
	/** The existing source files a resolved target stands for: itself plus its re-export closure. */
	const reaches = (candidates) => {
		const key = candidates.join("\0");
		if (closures.has(key)) return closures.get(key);
		const seen = new Set();
		const visit = (options, depth) => {
			const file = options.find((candidate) => readText(candidate) !== undefined);
			if (!file || seen.has(file)) return;
			seen.add(file);
			if (depth >= MAX_REEXPORT_DEPTH) return;
			for (const specifier of reexportSpecifiers(readText(file))) {
				visit(resolveSpecifierCandidates(file, specifier), depth + 1);
			}
		};
		visit(candidates, 0);
		closures.set(key, seen);
		return seen;
	};
	const hits = (candidates) =>
		candidates.some((candidate) => changed.has(candidate)) || [...reaches(candidates)].some((file) => changed.has(file));
	return testFiles.filter((testFile) => {
		if (changed.has(testFile)) return false;
		const text = readText(testFile) ?? "";
		return (
			relativeImportSpecifiers(text).some((specifier) => hits(resolveSpecifierCandidates(testFile, specifier))) ||
			packageImportSpecifiers(text).some((specifier) => {
				const target = resolvePackage(specifier);
				return target !== undefined && hits([target]);
			})
		);
	});
}

/**
 * A module imported directly by more than this many tests is a hub (settings-manager, agent-session,
 * a package root barrel): its importers are most of the suite, which is CI's job. For a hub only the
 * tests named after it run.
 */
export const HUB_IMPORTER_THRESHOLD = 25;

/** The commit gate's selection: direct importers of each changed file, narrowed to named tests for hubs. */
export function selectCommitTests(
	changedFiles,
	testFiles,
	readText,
	hubThreshold = HUB_IMPORTER_THRESHOLD,
	resolvePackage = () => undefined,
) {
	const selected = new Set();
	const text = new Map();
	const read = (path) => {
		if (!text.has(path)) text.set(path, readText(path));
		return text.get(path);
	};
	for (const changed of changedFiles) {
		const importers = directImporterTests([changed], testFiles, read, resolvePackage);
		const stem = changed.split("/").pop().replace(/\.[^.]+$/u, "");
		const kept =
			importers.length > hubThreshold ? importers.filter((test) => test.split("/").pop().startsWith(stem)) : importers;
		for (const test of kept) selected.add(test);
	}
	return [...selected].sort();
}

/** Every `*.test.ts` under `<workspace>/test`, repo-relative. */
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

/** Every workspace package's name, directory and exports map. */
export function readWorkspacePackages(repoRoot) {
	const packagesRoot = join(repoRoot, "packages");
	if (!existsSync(packagesRoot)) return [];
	return readdirSync(packagesRoot).flatMap((directory) => {
		const manifest = join(packagesRoot, directory, "package.json");
		if (!existsSync(manifest)) return [];
		const { name, exports } = JSON.parse(readFileSync(manifest, "utf8"));
		return typeof name === "string" ? [{ name, directory: `packages/${directory}`, exports }] : [];
	});
}

/**
 * The commit gate's selection for one workspace's tests, reading the repository on disk. Any
 * package's staged source counts: a coding-agent test that imports `@caupulican/pi-agent-core/…`
 * is selected by a change behind that entry point.
 */
export function findCommitTests(repoRoot, workspace, changedFiles) {
	const sources = changedFiles.filter((path) => /^packages\/[^/]+\/src\//u.test(path));
	if (sources.length === 0) return [];
	const readText = (path) => {
		const full = join(repoRoot, path);
		return existsSync(full) && statSync(full).isFile() ? readFileSync(full, "utf8") : undefined;
	};
	return selectCommitTests(
		sources,
		listWorkspaceTests(repoRoot, workspace),
		readText,
		HUB_IMPORTER_THRESHOLD,
		createPackageResolver(readWorkspacePackages(repoRoot)),
	);
}
