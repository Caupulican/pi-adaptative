import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultFffSearchBackend } from "../src/core/tools/fff-search-backend.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";
import { createSearchRouter } from "../src/core/tools/search-router.ts";
import { getToolPath, loadAvailableFffNodePackage } from "../src/utils/tools-manager.ts";

/**
 * Parity tests: prove the FFF search backend returns the SAME results as the
 * fd/rg fallbacks for the inputs where Pi actually routes to FFF.
 *
 * This is the mandatory correctness half of "FFF is superior": a speed win is
 * meaningless unless FFF returns equivalent results to the fallback it replaces.
 * The companion benchmark suite (fff-search-benchmark.test.ts) only proves
 * latency, and it asserts these same result sets before timing anything.
 *
 * All cases run through the real built-in tools with the real FFF backend on one
 * side and the fd/rg subprocess fallback (`fff: false`) on the other. The suite
 * skips cleanly when FFF native search, fd, or rg is unavailable so it never
 * fails on a platform/CI box that lacks one of them.
 */

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

const RUN_PARITY = fffNativeAvailable() && Boolean(getToolPath("fd")) && Boolean(getToolPath("rg"));
const forceCompatibleFffRoute = createSearchRouter({ findMaxFffLimit: 20_000, grepMaxFffLimit: 20_000 });

interface TextToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

/** Parse the grouped `find` output back into a flat, sorted list of relative paths. */
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

/** Parse `grep` output into the sorted set of matched file paths (header lines only). */
function parseGrepFiles(text: string): string[] {
	if (text === "No matches found") return [];
	const files = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line || line.startsWith("[") || line.startsWith("  ")) continue;
		files.add(line.replace(/:$/, ""));
	}
	return [...files].sort();
}

async function runFind(root: string, args: Record<string, unknown>, useFff: boolean): Promise<string[]> {
	const def = createFindToolDefinition(
		root,
		useFff ? { fff: defaultFffSearchBackend, searchRouter: forceCompatibleFffRoute } : { fff: false },
	);
	const ctx = {} as Parameters<typeof def.execute>[4];
	const result = (await def.execute("parity", args as never, undefined, undefined, ctx)) as TextToolResult;
	return parseFindPaths(result.content[0]?.text ?? "");
}

async function runGrep(root: string, args: Record<string, unknown>, useFff: boolean): Promise<string[]> {
	const def = createGrepToolDefinition(
		root,
		useFff ? { fff: defaultFffSearchBackend, searchRouter: forceCompatibleFffRoute } : { fff: false },
	);
	const ctx = {} as Parameters<typeof def.execute>[4];
	const result = (await def.execute("parity", args as never, undefined, undefined, ctx)) as TextToolResult;
	return parseGrepFiles(result.content[0]?.text ?? "");
}

/**
 * Build a deterministic corpus with NO `.gitignore` anywhere. The find/dir-grep
 * tool paths intentionally fall back to fd/rg when a `.gitignore` exists in the
 * search tree, so parity must be measured in the regime where FFF is actually
 * used. The test injects a high-threshold internal router so large-result parity
 * still exercises FFF instead of comparing the fallback with itself.
 */
function buildParityFixture(): string {
	const root = mkdtempSync(join(tmpdir(), "pi-fff-parity-"));
	for (let d = 0; d < 6; d++) {
		const dir = join(root, "src", `module${d}`);
		mkdirSync(dir, { recursive: true });
		for (let f = 0; f < 8; f++) {
			const marker = (d + f) % 3 === 0 ? "NEEDLE_token marker line\n" : "";
			const variant = f % 2 === 0 ? "export const ALPHA = 1;\n" : "export const beta = 2;\n";
			writeFileSync(join(dir, `file${f}.ts`), `// header ${d}-${f}\n${variant}${marker}`);
		}
		writeFileSync(join(dir, `notes${d}.md`), `# notes ${d}\nNEEDLE_token in markdown\n`);
	}
	return root;
}

describe.skipIf(!RUN_PARITY)("FFF search backend parity with fd/rg fallbacks", () => {
	let root: string;

	beforeAll(async () => {
		root = buildParityFixture();
		// Warm the resident index once so the first parity assertion is not racing the scan.
		await defaultFffSearchBackend.getFinder(root);
	});

	afterAll(() => {
		if (root) rmSync(root, { recursive: true, force: true });
	});

	it("find glob over the whole tree matches fd exactly", async () => {
		const [fff, fd] = await Promise.all([
			runFind(root, { pattern: "**/*.ts", limit: 10000 }, true),
			runFind(root, { pattern: "**/*.ts", limit: 10000 }, false),
		]);
		expect(fd.length).toBeGreaterThan(0);
		expect(fff).toEqual(fd);
	});

	it("find glob scoped to a subdirectory matches fd exactly", async () => {
		const [fff, fd] = await Promise.all([
			runFind(root, { pattern: "*.ts", path: "src/module1", limit: 10000 }, true),
			runFind(root, { pattern: "*.ts", path: "src/module1", limit: 10000 }, false),
		]);
		expect(fd.length).toBe(8);
		expect(fff).toEqual(fd);
	});

	it("find glob with a markdown extension matches fd exactly", async () => {
		const [fff, fd] = await Promise.all([
			runFind(root, { pattern: "**/*.md", limit: 10000 }, true),
			runFind(root, { pattern: "**/*.md", limit: 10000 }, false),
		]);
		expect(fd.length).toBe(6);
		expect(fff).toEqual(fd);
	});

	it("grep literal over a directory matches rg's matched-file set", async () => {
		const [fff, rg] = await Promise.all([
			runGrep(root, { pattern: "NEEDLE_token", path: "src", glob: "*.ts", literal: true, limit: 10000 }, true),
			runGrep(root, { pattern: "NEEDLE_token", path: "src", glob: "*.ts", literal: true, limit: 10000 }, false),
		]);
		expect(rg.length).toBeGreaterThan(0);
		expect(fff).toEqual(rg);
	});

	it("grep regex over a directory matches rg's matched-file set", async () => {
		const [fff, rg] = await Promise.all([
			runGrep(root, { pattern: "export const \\w+", path: "src", glob: "*.ts", limit: 10000 }, true),
			runGrep(root, { pattern: "export const \\w+", path: "src", glob: "*.ts", limit: 10000 }, false),
		]);
		expect(rg.length).toBeGreaterThan(0);
		expect(fff).toEqual(rg);
	});

	it("grep without a glob filter matches rg across file types", async () => {
		const [fff, rg] = await Promise.all([
			runGrep(root, { pattern: "NEEDLE_token", path: "src", literal: true, limit: 10000 }, true),
			runGrep(root, { pattern: "NEEDLE_token", path: "src", literal: true, limit: 10000 }, false),
		]);
		expect(rg.some((file) => file.endsWith(".md"))).toBe(true);
		expect(fff).toEqual(rg);
	});

	it("fuzzy file search finds known files (a capability fd cannot provide)", async () => {
		// Non-glob find routes to FFF's ranked fuzzy fileSearch. This is intentionally
		// NOT fd-parity-comparable (fd has no fuzzy ranking); assert the known files surface.
		const results = await runFind(root, { pattern: "file1", path: "src/module2", limit: 1000 }, true);
		expect(results).toContain("file1.ts");
	});
});
