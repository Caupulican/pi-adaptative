import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
	CLONE_EXCLUSIONS,
	CLONE_CROSS_FORMATS,
	CLONE_FORMATS,
	CLONE_LIMITS,
	CLONE_SCANNER_IGNORES,
	CLONE_SOURCE_ROOTS,
	discoverCloneCandidates,
	validateCloneReport,
	validateCoverageSummary,
} from "./production-clone-gate.mjs";
import { JSCPD_REPORT_MAX_AGE_MS, pruneTemporaryJscpdReports } from "./jscpd-report-retention.mjs";

const repositoryRoot = resolve(import.meta.dirname, "..");
const productionCandidates = discoverCloneCandidates(repositoryRoot);

test("production clone scope covers every owned runtime language without broad exclusions", () => {
	const paths = new Set(productionCandidates.map((candidate) => candidate.path));

	assert.deepEqual(CLONE_SOURCE_ROOTS, [
		"packages/agent/src",
		"packages/ai/src",
		"packages/coding-agent/src",
		"packages/tui/src",
		"scripts",
	]);
	assert.ok(paths.has("packages/coding-agent/src/core/agent-session.ts"));
	assert.ok(paths.has("packages/coding-agent/src/bundled-resources/runtimes/pi-shell-engine/main.py"));
	assert.ok(paths.has("packages/coding-agent/src/core/export-html/template.css"));
	assert.ok(paths.has("packages/coding-agent/src/core/export-html/template.html"));
	assert.ok(paths.has("scripts/collect-pi-incident.ps1"));
	assert.ok(paths.has("scripts/build-binaries.sh"));
	assert.ok(
		productionCandidates.length > 600,
		`expected the production scope to contain more than 600 files, found ${productionCandidates.length}`,
	);

	for (const excludedPath of CLONE_EXCLUSIONS.keys()) {
		assert.equal(paths.has(excludedPath), false, `${excludedPath} must be excluded by exact path`);
	}
});

test("production clone limits retain at least 2x headroom above the largest candidate", () => {
	const largestBytes = Math.max(...productionCandidates.map((candidate) => candidate.bytes));
	const largestLines = Math.max(...productionCandidates.map((candidate) => candidate.lines));

	assert.ok(CLONE_LIMITS.maxBytes >= largestBytes * 2, `${CLONE_LIMITS.maxBytes} bytes does not cover ${largestBytes} with 2x headroom`);
	assert.ok(CLONE_LIMITS.maxLines >= largestLines * 2, `${CLONE_LIMITS.maxLines} lines does not cover ${largestLines} with 2x headroom`);
});

test("candidate discovery includes supported source files and excludes non-production files", (context) => {
	const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-clone-scope-"));
	context.after(() => rmSync(fixtureRoot, { recursive: true, force: true }));
	mkdirSync(join(fixtureRoot, "source"), { recursive: true });
	writeFileSync(join(fixtureRoot, "source", "owned.ts"), "export const owned = true;\n");
	writeFileSync(join(fixtureRoot, "source", "owned.d.mts"), "export declare const ownedModule: true;\n");
	writeFileSync(join(fixtureRoot, "source", "owned.cts"), "export const ownedCommonJs = true;\n");
	writeFileSync(join(fixtureRoot, "source", "runtime.py"), "owned = True\n");
	writeFileSync(join(fixtureRoot, "source", "owned.test.ts"), "test-only source\n");
	writeFileSync(join(fixtureRoot, "source", "notes.md"), "not executable source\n");

	const candidates = discoverCloneCandidates(fixtureRoot, {
		exclusions: new Map(),
		sourceRoots: ["source"],
	});

	assert.deepEqual(
		candidates.map((candidate) => candidate.path),
		["source/owned.cts", "source/owned.d.mts", "source/owned.ts", "source/runtime.py"],
	);
});

test("report validation has a positive control and rejects omissions or clones", () => {
	const cleanReport = {
		duplicates: [],
		statistics: { total: { clones: 0, sources: 3 } },
	};
	assert.doesNotThrow(() => validateCloneReport(cleanReport, 3));
	assert.throws(() => validateCloneReport(cleanReport, 4), /analyzed 3 of 4 candidate files/);
	assert.throws(
		() =>
			validateCloneReport(
				{
					duplicates: [
						{
							firstFile: { name: "a.ts", start: 1 },
							lines: 5,
							secondFile: { name: "b.ts", start: 1 },
						},
					],
					statistics: { total: { clones: 1, sources: 4 } },
				},
				4,
			),
		/1 production textual clone candidate/,
	);
	assert.equal(
		validateCoverageSummary(
			"Duplications detection: Found 2 exact clones with 10(1%) duplicated lines in 3 (2 formats) files.",
			3,
		),
		3,
	);
	assert.throws(() => validateCoverageSummary("in 2 (2 formats) files.", 3), /analyzed 2 of 3 eligible candidate files/);
	assert.throws(() => validateCoverageSummary("scanner stopped", 3), /did not emit its analyzed-file summary/);
});

test("jscpd configuration and root check keep the zero-clone gate enforceable", () => {
	const config = JSON.parse(readFileSync(join(repositoryRoot, ".jscpd.json"), "utf8"));
	const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "package.json"), "utf8"));
	const packageLock = JSON.parse(readFileSync(join(repositoryRoot, "package-lock.json"), "utf8"));

	assert.deepEqual(config, {
		absolute: true,
		format: CLONE_FORMATS,
		ignore: CLONE_SCANNER_IGNORES,
		maxLines: CLONE_LIMITS.maxLines,
		maxSize: "2mb",
		minLines: CLONE_LIMITS.minLines,
		minTokens: CLONE_LIMITS.minTokens,
		mode: "strict",
		reporters: ["json"],
		threshold: 0,
	});
	assert.equal(CLONE_CROSS_FORMATS, "js-ts");
	assert.equal(packageJson.scripts["check:clone-config"], "node --test scripts/check-production-clones.test.mjs");
	assert.equal(packageJson.scripts["check:clones"], "node scripts/check-production-clones.mjs");
	assert.equal(packageJson.devDependencies.jscpd, "5.0.14");
	assert.equal(packageLock.packages[""].devDependencies.jscpd, "5.0.14");
	assert.equal(packageLock.packages["node_modules/jscpd"].version, "5.0.14");
	assert.equal(packageLock.packages["node_modules/jscpd"].optionalDependencies["jscpd-windows-x64-msvc"], "5.0.14");
	assert.deepEqual(packageLock.packages["node_modules/jscpd-windows-x64-msvc"].os, ["win32"]);
	assert.deepEqual(packageLock.packages["node_modules/jscpd-windows-x64-msvc"].cpu, ["x64"]);
	assert.match(packageJson.scripts.check, /npm run check:clone-config/);
	assert.match(packageJson.scripts.check, /npm run check:clones/);
});

test("temporary jscpd evidence retention removes stale and excess reports without touching active or explicit paths", (context) => {
	assert.equal(JSCPD_REPORT_MAX_AGE_MS, 24 * 60 * 60 * 1000);
	const root = mkdtempSync(join(tmpdir(), "pi-jscpd-retention-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const nowMs = Date.parse("2026-08-20T12:00:00.000Z");
	const createReport = (name, ageMs) => {
		const directory = join(root, name);
		mkdirSync(directory);
		writeFileSync(join(directory, "jscpd-report.json"), "{}\n");
		const modified = new Date(nowMs - ageMs);
		utimesSync(join(directory, "jscpd-report.json"), modified, modified);
		utimesSync(directory, modified, modified);
		return directory;
	};
	const day = 24 * 60 * 60 * 1000;
	const hour = 60 * 60 * 1000;
	const expired = createReport("pi-jscpd-AAAAAA", 2 * day);
	const excess = createReport("pi-jscpd-BBBBBB", 20 * hour);
	const retained = [
		createReport("pi-jscpd-CCCCCC", 16 * hour),
		createReport("pi-jscpd-DDDDDD", 12 * hour),
		createReport("pi-jscpd-EEEEEE", 8 * hour),
	];
	const active = createReport("pi-jscpd-FFFFFF", 10 * 60 * 1000);
	const explicit = createReport("pi-jscpd-GGGGGG", 3 * day);
	const unrelated = createReport("pi-jscpd-not-owned", 30 * day);

	const result = pruneTemporaryJscpdReports({
		root,
		nowMs,
		maxRetained: 3,
		activeGraceMs: 60 * 60 * 1000,
		protectedDirectories: [explicit],
	});

	assert.deepEqual(result.removedDirectories.sort(), [excess, expired].sort());
	for (const directory of [...retained, active, explicit, unrelated]) assert.equal(existsSync(directory), true);
	assert.equal(existsSync(expired), false);
	assert.equal(existsSync(excess), false);
	const checkScript = readFileSync(join(repositoryRoot, "scripts/check-production-clones.mjs"), "utf8");
	assert.match(checkScript, /pruneTemporaryJscpdReports/);
});

test("temporary jscpd evidence retention enforces a total byte budget", (context) => {
	const root = mkdtempSync(join(tmpdir(), "pi-jscpd-retention-bytes-"));
	context.after(() => rmSync(root, { recursive: true, force: true }));
	const nowMs = Date.parse("2026-08-20T12:00:00.000Z");
	const createReport = (name, ageMs) => {
		const directory = join(root, name);
		mkdirSync(directory);
		writeFileSync(join(directory, "jscpd-report.json"), "12345678");
		const modified = new Date(nowMs - ageMs);
		utimesSync(join(directory, "jscpd-report.json"), modified, modified);
		utimesSync(directory, modified, modified);
		return directory;
	};
	const newest = createReport("pi-jscpd-HHHHHH", 2 * 60 * 60 * 1000);
	const older = createReport("pi-jscpd-IIIIII", 3 * 60 * 60 * 1000);

	const result = pruneTemporaryJscpdReports({
		root,
		nowMs,
		maxAgeMs: 7 * 24 * 60 * 60 * 1000,
		maxRetained: 10,
		maxRetainedBytes: 10,
		activeGraceMs: 60 * 60 * 1000,
	});

	assert.equal(existsSync(newest), true);
	assert.equal(existsSync(older), false);
	assert.deepEqual(result.removedDirectories, [older]);
});

test("incremental line decoding has one package-level implementation owner", () => {
	const canonicalPath = join(repositoryRoot, "packages/ai/src/utils/streaming-lines.ts");
	assert.equal(existsSync(canonicalPath), true);
	assert.equal(existsSync(join(repositoryRoot, "packages/agent/src/utils/streaming-lines.ts")), false);
	assert.equal(existsSync(join(repositoryRoot, "packages/coding-agent/src/utils/streaming-lines.ts")), false);

	const publicApi = readFileSync(join(repositoryRoot, "packages/ai/src/index.ts"), "utf8");
	assert.match(publicApi, /export \* from "\.\/utils\/streaming-lines\.ts"/);
	for (const consumer of [
		"packages/agent/src/session/session-manager.ts",
		"packages/coding-agent/src/core/tools/read.ts",
		"packages/coding-agent/src/core/models/local-runtime.ts",
		"packages/coding-agent/src/modes/rpc/jsonl.ts",
	]) {
		assert.match(
			readFileSync(join(repositoryRoot, consumer), "utf8"),
			/from "@caupulican\/pi-ai(?:\/streaming-lines)?"/,
			consumer,
		);
	}
	assert.match(
		readFileSync(join(repositoryRoot, "packages/agent/src/proxy.ts"), "utf8"),
		/from "@caupulican\/pi-ai\/streaming-lines"/,
	);
});

test("Google providers share one streaming and payload implementation owner", () => {
	const sharedPath = join(repositoryRoot, "packages/ai/src/providers/google-streaming.ts");
	assert.equal(existsSync(sharedPath), true);

	const shared = readFileSync(sharedPath, "utf8");
	assert.match(shared, /export function streamGoogleGenAi/);
	assert.match(shared, /export function buildGoogleGenerateContentParameters/);
	assert.match(shared, /for await \(const chunk of googleStream\)/);

	const google = readFileSync(join(repositoryRoot, "packages/ai/src/providers/google.ts"), "utf8");
	const vertex = readFileSync(join(repositoryRoot, "packages/ai/src/providers/google-vertex.ts"), "utf8");
	for (const provider of [google, vertex]) {
		assert.match(provider, /from "\.\/google-streaming\.ts"/);
		assert.match(provider, /streamGoogleGenAi\(/);
		assert.doesNotMatch(provider, /for await \(const chunk of googleStream\)/);
		assert.doesNotMatch(provider, /function buildParams\(/);
	}

	assert.match(google, /function createClient\(/);
	assert.match(vertex, /function createClientWithApiKey\(/);
	assert.match(vertex, /function resolveProject\(/);
	assert.match(vertex, /function resolveLocation\(/);
});
