import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultFffSearchBackend, type FffFileFinder } from "../src/core/tools/fff-search-backend.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { getToolPath, loadAvailableFffNodePackage } from "../src/utils/tools-manager.ts";

/**
 * Opt-in FFF benchmark harness.
 *
 * Run manually:
 *
 *   cd packages/coding-agent
 *   PI_RUN_BENCH=1 node ../../node_modules/vitest/dist/cli.js --run test/fff-search-benchmark.test.ts
 *
 * Strict speed assertions are intentionally separate from the default benchmark:
 *
 *   PI_RUN_BENCH=1 PI_BENCH_STRICT=1 node ../../node_modules/vitest/dist/cli.js --run test/fff-search-benchmark.test.ts
 *
 * The non-strict benchmark is still useful: it asserts result parity before timing
 * and prints cold/warm metrics that explain when FFF is superior. Strict timing is
 * gated because wall-clock comparisons are machine-sensitive.
 */

const RUN_BENCH = process.env.PI_RUN_BENCH === "1";
const STRICT_BENCH = process.env.PI_BENCH_STRICT === "1";
const BENCH_ITERATIONS = Math.max(5, Number.parseInt(process.env.PI_BENCH_ITERATIONS ?? "30", 10));
const BENCH_DIRS = Math.max(20, Number.parseInt(process.env.PI_BENCH_DIRS ?? "120", 10));
const BENCH_FILES_PER_DIR = Math.max(10, Number.parseInt(process.env.PI_BENCH_FILES_PER_DIR ?? "40", 10));
const BENCH_LIMIT = 20;
const RARE_MARKER = "RARE_MARKER_BENCHMARK";
const RARE_GLOB = "**/*target-special*.ts";

function fffNativeAvailable(): boolean {
	const mod = loadAvailableFffNodePackage();
	if (!mod || typeof mod !== "object") return false;
	const fileFinder = (mod as { FileFinder?: { create?: unknown; isAvailable?: () => boolean } }).FileFinder;
	if (!fileFinder || typeof fileFinder.create !== "function") return false;
	if (typeof fileFinder.isAvailable === "function") {
		try {
			return fileFinder.isAvailable();
		} catch {
			return false;
		}
	}
	return true;
}

const HAVE_BACKENDS = RUN_BENCH && fffNativeAvailable() && Boolean(getToolPath("fd")) && Boolean(getToolPath("rg"));

interface TextToolResult {
	content: Array<{ type: string; text?: string }>;
}

interface BenchStats {
	medianMs: number;
	p90Ms: number;
	minMs: number;
	maxMs: number;
}

function median(values: readonly number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

function percentile(values: readonly number[], p: number): number {
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

function summarize(values: readonly number[]): BenchStats {
	return {
		medianMs: median(values),
		p90Ms: percentile(values, 0.9),
		minMs: Math.min(...values),
		maxMs: Math.max(...values),
	};
}

async function measure(fn: () => Promise<void> | void): Promise<BenchStats> {
	await fn();
	const samples: number[] = [];
	for (let i = 0; i < BENCH_ITERATIONS; i++) {
		const start = performance.now();
		await fn();
		samples.push(performance.now() - start);
	}
	return summarize(samples);
}

function parseFindPaths(text: string): string[] {
	if (text === "No files found matching pattern") return [];
	const paths: string[] = [];
	let currentDir = "";
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("[")) continue;
		if (line.startsWith("  ")) {
			const file = line.trim();
			paths.push(currentDir === "./" ? file : currentDir + file);
		} else {
			currentDir = line.trim();
		}
	}
	return paths.sort();
}

function parseGrepFiles(text: string): string[] {
	if (text === "No matches found") return [];
	const files = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("[") || line.startsWith("  ")) continue;
		files.add(line.replace(/:$/, ""));
	}
	return [...files].sort();
}

function buildBenchmarkFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-fff-bench-"));
	const specialStep = Math.max(1, Math.floor(BENCH_DIRS / 10));
	for (let d = 0; d < BENCH_DIRS; d++) {
		const dir = join(root, "pkg", `module${d}`);
		mkdirSync(dir, { recursive: true });
		for (let f = 0; f < BENCH_FILES_PER_DIR; f++) {
			const isSpecial = f === 3 && d % specialStep === 0;
			const fileName = isSpecial ? `target-special-${d}.ts` : `file${f}.ts`;
			const marker = isSpecial ? `${RARE_MARKER}\n` : "";
			writeFileSync(
				join(dir, fileName),
				`export const value_${d}_${f} = ${d * BENCH_FILES_PER_DIR + f};\n${marker}`,
			);
		}
	}
	return root;
}

function rawFffGlobPaths(finder: FffFileFinder): string[] {
	const result = finder.glob(`pkg/${RARE_GLOB}`, { pageSize: BENCH_LIMIT });
	if (!result.ok) throw new Error(result.error);
	return result.value.items.map((item) => item.relativePath).sort();
}

function rawFffGrepFiles(finder: FffFileFinder): string[] {
	const result = finder.grep(`pkg/ **/*.ts ${RARE_MARKER}`, {
		mode: "plain",
		smartCase: false,
		maxMatchesPerFile: BENCH_LIMIT,
		pageSize: BENCH_LIMIT,
	});
	if (!result.ok) throw new Error(result.error);
	return [...new Set(result.value.items.map((item) => item.relativePath))].sort();
}

async function fdFindPaths(root: string): Promise<string[]> {
	const def = createFindToolDefinition(root, { fff: false });
	const ctx = {} as Parameters<typeof def.execute>[4];
	const result = (await def.execute(
		"bench-find",
		{ pattern: RARE_GLOB, limit: BENCH_LIMIT },
		undefined,
		undefined,
		ctx,
	)) as TextToolResult;
	return parseFindPaths(result.content[0]?.text ?? "");
}

async function rgGrepFiles(root: string): Promise<string[]> {
	const def = createGrepToolDefinition(root, { fff: false });
	const ctx = {} as Parameters<typeof def.execute>[4];
	const result = (await def.execute(
		"bench-grep",
		{ pattern: RARE_MARKER, path: ".", glob: "**/*.ts", literal: true, limit: BENCH_LIMIT },
		undefined,
		undefined,
		ctx,
	)) as TextToolResult;
	return parseGrepFiles(result.content[0]?.text ?? "");
}

function formatStats(stats: BenchStats): string {
	return `median=${stats.medianMs.toFixed(2)}ms p90=${stats.p90Ms.toFixed(2)}ms min=${stats.minMs.toFixed(2)}ms max=${stats.maxMs.toFixed(2)}ms`;
}

describe.skipIf(!HAVE_BACKENDS)("FFF warm-search benchmark", () => {
	let root: string;
	let finder: FffFileFinder;
	let coldScanMs = 0;

	beforeAll(async () => {
		root = buildBenchmarkFixture();
		const start = performance.now();
		const created = await defaultFffSearchBackend.getFinder(root);
		coldScanMs = performance.now() - start;
		if (!created) throw new Error("FFF finder unavailable");
		finder = created;
	});

	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("reports warm FFF top-N performance against fd/rg after proving parity", async () => {
		const [fffGlobPaths, fdGlobPaths] = await Promise.all([
			Promise.resolve(rawFffGlobPaths(finder)),
			fdFindPaths(root),
		]);
		expect(fffGlobPaths).toEqual(fdGlobPaths);

		const [fffGrepFiles, rgFiles] = await Promise.all([Promise.resolve(rawFffGrepFiles(finder)), rgGrepFiles(root)]);
		expect(fffGrepFiles).toEqual(rgFiles);

		const rawFffGlob = await measure(() => {
			rawFffGlobPaths(finder);
		});
		const fdGlob = await measure(async () => {
			await fdFindPaths(root);
		});
		const rawFffGrep = await measure(() => {
			rawFffGrepFiles(finder);
		});
		const rgGrep = await measure(async () => {
			await rgGrepFiles(root);
		});

		const summary = {
			corpusFiles: BENCH_DIRS * BENCH_FILES_PER_DIR,
			iterations: BENCH_ITERATIONS,
			limit: BENCH_LIMIT,
			coldFffScanMs: Number(coldScanMs.toFixed(2)),
			rawFffGlob: formatStats(rawFffGlob),
			fdGlob: formatStats(fdGlob),
			rawFffGrep: formatStats(rawFffGrep),
			rgGrep: formatStats(rgGrep),
			globSpeedup: Number((fdGlob.medianMs / rawFffGlob.medianMs).toFixed(2)),
			grepSpeedup: Number((rgGrep.medianMs / rawFffGrep.medianMs).toFixed(2)),
		};
		console.info(`FFF benchmark: ${JSON.stringify(summary)}`);

		expect(rawFffGlob.medianMs).toBeGreaterThan(0);
		expect(rawFffGrep.medianMs).toBeGreaterThan(0);
		if (STRICT_BENCH) {
			expect(rawFffGlob.medianMs).toBeLessThan(fdGlob.medianMs);
			expect(rawFffGrep.medianMs).toBeLessThan(rgGrep.medianMs);
		}
	});
});
