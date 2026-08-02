import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";

export const CLONE_SOURCE_ROOTS = [
	"packages/agent/src",
	"packages/ai/src",
	"packages/coding-agent/src",
	"packages/tui/src",
	"scripts",
];

export const CLONE_FORMATS = [
	"typescript",
	"tsx",
	"javascript",
	"jsx",
	"python",
	"bash",
	"powershell",
	"css",
	"markup",
];

export const CLONE_CROSS_FORMATS = "js-ts";

export const CLONE_LIMITS = Object.freeze({
	maxBytes: 2 * 1024 * 1024,
	maxLines: 20_000,
	minLines: 5,
	minTokens: 50,
});

export const CLONE_EXCLUSIONS = new Map([
	[
		"packages/ai/src/models.generated.ts",
		{ kind: "generated", owner: "packages/ai/scripts/generate-models.ts" },
	],
	[
		"packages/ai/src/image-models.generated.ts",
		{ kind: "generated", owner: "packages/ai/scripts/generate-image-models.ts" },
	],
	[
		"packages/coding-agent/src/core/export-html/vendor/highlight.min.js",
		{ kind: "vendored", marker: "Highlight.js" },
	],
	[
		"packages/coding-agent/src/core/export-html/vendor/marked.min.js",
		{ kind: "vendored", marker: "marked v" },
	],
]);

const NON_PRODUCTION_GLOBS = ["**/*.test.*", "**/*.spec.*"];
const SOURCE_EXTENSIONS = new Set([
	".ts",
	".tsx",
	".mts",
	".cts",
	".js",
	".jsx",
	".mjs",
	".cjs",
	".py",
	".sh",
	".ps1",
	".css",
	".html",
]);

export const CLONE_SCANNER_IGNORES = [...NON_PRODUCTION_GLOBS, ...CLONE_EXCLUSIONS.keys()];

function normalizePath(filePath) {
	return sep === "/" ? filePath : filePath.split(sep).join("/");
}

function isNonProductionSource(filePath) {
	const filename = filePath.slice(filePath.lastIndexOf("/") + 1);
	return filename.includes(".test.") || filename.includes(".spec.");
}

function countLines(source) {
	if (source.length === 0) return 0;
	const lines = source.split(/\r?\n/u).length;
	return source.endsWith("\n") ? lines - 1 : lines;
}

export function discoverCloneCandidates(
	repositoryRoot,
	{ exclusions = CLONE_EXCLUSIONS, sourceRoots = CLONE_SOURCE_ROOTS } = {},
) {
	const candidates = [];

	function visit(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const absolutePath = join(directory, entry.name);
			const repositoryPath = normalizePath(relative(repositoryRoot, absolutePath));
			if (entry.isSymbolicLink()) {
				throw new Error(`production clone scope contains unsupported symlink: ${repositoryPath}`);
			}
			if (entry.isDirectory()) {
				visit(absolutePath);
				continue;
			}
			if (!entry.isFile() || !SOURCE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
			if (isNonProductionSource(repositoryPath) || exclusions.has(repositoryPath)) continue;

			const source = readFileSync(absolutePath, "utf8");
			candidates.push({
				bytes: Buffer.byteLength(source),
				lines: countLines(source),
				path: repositoryPath,
			});
		}
	}

	for (const sourceRoot of sourceRoots) {
		const absoluteRoot = resolve(repositoryRoot, sourceRoot);
		const rootStat = lstatSync(absoluteRoot);
		if (rootStat.isSymbolicLink()) throw new Error(`production clone root is a symlink: ${sourceRoot}`);
		if (!rootStat.isDirectory()) throw new Error(`production clone root is not a directory: ${sourceRoot}`);
		visit(absoluteRoot);
	}

	return candidates.sort((left, right) => left.path.localeCompare(right.path));
}

export function validateCloneExclusions(repositoryRoot) {
	for (const [repositoryPath, exclusion] of CLONE_EXCLUSIONS) {
		const absolutePath = resolve(repositoryRoot, repositoryPath);
		const stat = lstatSync(absolutePath);
		if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`clone exclusion is not an owned regular file: ${repositoryPath}`);
		const header = readFileSync(absolutePath, "utf8").slice(0, 256);

		if (exclusion.kind === "generated") {
			if (!header.includes("auto-generated") || !lstatSync(resolve(repositoryRoot, exclusion.owner)).isFile()) {
				throw new Error(`clone exclusion lost generated-source proof: ${repositoryPath}`);
			}
			continue;
		}

		if (!repositoryPath.includes("/vendor/") || !header.includes(exclusion.marker)) {
			throw new Error(`clone exclusion lost vendored-source proof: ${repositoryPath}`);
		}
	}
}

export function validateCandidateLimits(candidates) {
	for (const candidate of candidates) {
		if (candidate.lines > CLONE_LIMITS.maxLines) {
			throw new Error(`${candidate.path}: ${candidate.lines} lines exceeds clone scanner maxLines ${CLONE_LIMITS.maxLines}`);
		}
		if (candidate.bytes > CLONE_LIMITS.maxBytes) {
			throw new Error(`${candidate.path}: ${candidate.bytes} bytes exceeds clone scanner maxSize ${CLONE_LIMITS.maxBytes}`);
		}
	}
}

export function validateCloneReport(report, expectedSources) {
	if (!report || typeof report !== "object" || !Array.isArray(report.duplicates)) {
		throw new Error("jscpd JSON report is missing its duplicates array");
	}
	const total = report.statistics?.total;
	if (!total || !Number.isInteger(total.sources) || !Number.isInteger(total.clones)) {
		throw new Error("jscpd JSON report is missing integer total source and clone counts");
	}
	if (expectedSources !== undefined && total.sources !== expectedSources) {
		throw new Error(`jscpd analyzed ${total.sources} of ${expectedSources} candidate files`);
	}
	if (report.duplicates.length !== total.clones) {
		throw new Error(`jscpd reported ${total.clones} clones but emitted ${report.duplicates.length} clone records`);
	}
	if (total.clones > 0) {
		throw new Error(`${total.clones} production textual clone candidate${total.clones === 1 ? "" : "s"} remain`);
	}
	return total;
}

export function validateCoverageSummary(output, expectedSources) {
	const normalizedOutput = output.replace(/\u001b\[[0-9;]*m/gu, "");
	const match = /\bin (\d+) \(\d+ formats?\) files\./u.exec(normalizedOutput);
	if (!match) throw new Error("jscpd coverage scan did not emit its analyzed-file summary");
	const analyzedSources = Number(match[1]);
	if (analyzedSources !== expectedSources) {
		throw new Error(`jscpd coverage scan analyzed ${analyzedSources} of ${expectedSources} eligible candidate files`);
	}
	return analyzedSources;
}
