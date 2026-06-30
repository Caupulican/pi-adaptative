import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
	FffFileFinder,
	FffGlobOptions,
	FffGrepOptions,
	FffGrepResult,
	FffSearchBackend,
	FffSearchOptions,
	FffSearchResult,
} from "../src/core/tools/fff-search-backend.ts";
import { hasGitignoreInTree, loadFffModule, relativePathInside } from "../src/core/tools/fff-search-backend.ts";
import { createFindToolDefinition } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";

interface TextToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

interface SearchCall {
	query: string;
	options?: FffSearchOptions;
}

interface GlobCall {
	pattern: string;
	options?: FffGlobOptions;
}

interface GrepCall {
	query: string;
	options?: FffGrepOptions;
}

class FakeFffFinder implements FffFileFinder {
	readonly isDestroyed = false;
	readonly searchCalls: SearchCall[] = [];
	readonly globCalls: GlobCall[] = [];
	readonly grepCalls: GrepCall[] = [];
	searchResult: FffSearchResult = { items: [], scores: [], totalMatched: 0, totalFiles: 0 };
	grepResult: FffGrepResult = {
		items: [],
		totalMatched: 0,
		totalFilesSearched: 0,
		totalFiles: 0,
		filteredFileCount: 0,
		nextCursor: null,
	};

	destroy(): void {}

	fileSearch(query: string, options?: FffSearchOptions) {
		this.searchCalls.push({ query, options });
		return { ok: true as const, value: this.searchResult };
	}

	glob(pattern: string, options?: FffGlobOptions) {
		this.globCalls.push({ pattern, options });
		return { ok: true as const, value: this.searchResult };
	}

	grep(query: string, options?: FffGrepOptions) {
		this.grepCalls.push({ query, options });
		return { ok: true as const, value: this.grepResult };
	}

	async waitForScan() {
		return { ok: true as const, value: true };
	}
}

class FakeFffBackend implements FffSearchBackend {
	readonly basePaths: string[] = [];
	readonly finder = new FakeFffFinder();

	async getFinder(basePath: string) {
		this.basePaths.push(basePath);
		return this.finder;
	}
}

function getText(result: TextToolResult): string {
	return result.content[0]?.text ?? "";
}

function schemaPropertyKeys(parameters: unknown): string[] {
	if (!parameters || typeof parameters !== "object") return [];
	const properties = (parameters as { properties?: Record<string, unknown> }).properties;
	return properties ? Object.keys(properties).sort() : [];
}

function fileItem(relativePath: string): FffSearchResult["items"][number] {
	return {
		relativePath,
		fileName: relativePath.split("/").pop() ?? relativePath,
		size: 10,
		modified: 0,
		gitStatus: "clean",
	};
}

function grepMatch(
	relativePath: string,
	overrides?: Partial<FffGrepResult["items"][number]>,
): FffGrepResult["items"][number] {
	const matchRanges: [number, number][] = [[0, 4]];
	return {
		relativePath,
		fileName: relativePath.split("/").pop() ?? relativePath,
		gitStatus: "clean",
		size: 10,
		modified: 0,
		isBinary: false,
		totalFrecencyScore: 0,
		accessFrecencyScore: 0,
		modificationFrecencyScore: 0,
		lineNumber: 1,
		col: 1,
		byteOffset: 0,
		lineContent: "TODO",
		matchRanges,
		...overrides,
	};
}

describe("FFF-backed built-in search tools", () => {
	it("accepts the real FFF export shape with FileFinder as a class function", () => {
		function FileFinder() {}
		FileFinder.create = () => ({ ok: false as const, error: "not used" });

		const loaded = loadFffModule([
			(id) => {
				expect(id).toBe("@ff-labs/fff-node");
				return { FileFinder };
			},
		]);

		expect(loaded).not.toBeNull();
		expect(typeof loaded?.FileFinder.create).toBe("function");
	});

	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-fff-tools-"));
		mkdirSync(join(tempRoot, "src"), { recursive: true });
		writeFileSync(join(tempRoot, "src", "placeholder.ts"), "export const placeholder = true;\n");
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	it("does not expose backend routing as agent-facing tool parameters", () => {
		const findDef = createFindToolDefinition(tempRoot);
		const grepDef = createGrepToolDefinition(tempRoot);

		expect(schemaPropertyKeys(findDef.parameters)).toEqual(["ignoreCase", "limit", "path", "pattern"]);
		expect(schemaPropertyKeys(grepDef.parameters)).toEqual([
			"context",
			"glob",
			"ignoreCase",
			"limit",
			"literal",
			"path",
			"pattern",
		]);
		for (const exposed of [...schemaPropertyKeys(findDef.parameters), ...schemaPropertyKeys(grepDef.parameters)]) {
			expect(["backend", "fff", "router", "searchRouter"]).not.toContain(exposed);
		}
	});

	it("uses FFF glob search for compatible find requests", async () => {
		const backend = new FakeFffBackend();
		backend.finder.searchResult = {
			items: [
				{
					relativePath: "src/foo.ts",
					fileName: "foo.ts",
					size: 10,
					modified: 0,
					gitStatus: "clean",
				},
				{
					relativePath: "src/nested/bar.ts",
					fileName: "bar.ts",
					size: 10,
					modified: 0,
					gitStatus: "clean",
				},
			],
			scores: [],
			totalMatched: 2,
			totalFiles: 3,
		};

		const def = createFindToolDefinition(tempRoot, { fff: backend });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "*.ts", path: "src", limit: 5 },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;

		expect(backend.basePaths).toEqual([tempRoot]);
		expect(backend.finder.globCalls).toEqual([{ pattern: "src/**/*.ts", options: { pageSize: 5 } }]);
		expect(getText(result)).toContain("foo.ts");
		expect(getText(result)).toContain("nested/");
		expect(getText(result)).toContain("bar.ts");
	});

	it("uses FFF grep for compatible content searches", async () => {
		const backend = new FakeFffBackend();
		backend.finder.grepResult = {
			items: [
				{
					relativePath: "src/foo.ts",
					fileName: "foo.ts",
					gitStatus: "clean",
					size: 10,
					modified: 0,
					isBinary: false,
					totalFrecencyScore: 0,
					accessFrecencyScore: 0,
					modificationFrecencyScore: 0,
					lineNumber: 7,
					col: 2,
					byteOffset: 20,
					lineContent: "  TODO fix",
					matchRanges: [[2, 6]],
					contextBefore: ["before"],
					contextAfter: ["after"],
				},
			],
			totalMatched: 1,
			totalFilesSearched: 1,
			totalFiles: 3,
			filteredFileCount: 1,
			nextCursor: null,
		};

		const def = createGrepToolDefinition(tempRoot, { fff: backend });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "TODO", path: "src", glob: "*.ts", literal: true, context: 1, limit: 3 },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;

		expect(backend.basePaths).toEqual([tempRoot]);
		expect(backend.finder.grepCalls).toEqual([
			{
				query: "src/ **/*.ts TODO",
				options: {
					mode: "plain",
					smartCase: false,
					maxMatchesPerFile: 3,
					beforeContext: 1,
					afterContext: 1,
					pageSize: 3,
				},
			},
		]);
		expect(getText(result)).toContain("foo.ts:");
		expect(getText(result)).toContain("  6- before");
		expect(getText(result)).toContain("  7:   TODO fix");
		expect(getText(result)).toContain("  8- after");
	});

	it("tries alternate FFF module resolution roots after malformed exports", () => {
		function FileFinder() {}
		FileFinder.create = () => ({ ok: false as const, error: "not used" });

		const loaded = loadFffModule([
			() => ({ FileFinder: { create: "not-a-function" } }),
			(id) => {
				expect(id).toBe("@ff-labs/fff-node");
				return { FileFinder };
			},
		]);

		expect(loaded).not.toBeNull();
		expect(typeof loaded?.FileFinder.create).toBe("function");
	});

	it("rejects sibling-prefix escapes when relativizing FFF paths", () => {
		const basePath = join(tempRoot, "project");
		mkdirSync(join(basePath, "src"), { recursive: true });

		expect(relativePathInside(basePath, basePath)).toBe("");
		expect(relativePathInside(basePath, join(basePath, "src", "file.ts"))).toBe("src/file.ts");
		expect(relativePathInside(basePath, join(`${basePath}-sibling`, "file.ts"))).toBeUndefined();
	});

	it("detects nested gitignore files while ignoring skipped cache directories", async () => {
		mkdirSync(join(tempRoot, ".git"), { recursive: true });
		mkdirSync(join(tempRoot, "node_modules", "pkg"), { recursive: true });
		writeFileSync(join(tempRoot, ".git", ".gitignore"), "ignored-from-git-dir\n");
		writeFileSync(join(tempRoot, "node_modules", "pkg", ".gitignore"), "ignored-from-node-modules\n");

		expect(await hasGitignoreInTree(tempRoot)).toBe(false);

		writeFileSync(join(tempRoot, "src", ".gitignore"), "ignored.txt\n");
		expect(await hasGitignoreInTree(tempRoot)).toBe(true);
	});

	it("uses FFF file search for non-glob find requests and scopes results to the requested path", async () => {
		const backend = new FakeFffBackend();
		backend.finder.searchResult = {
			items: [fileItem("src/foo.ts"), fileItem("other/foo.ts")],
			scores: [],
			totalMatched: 2,
			totalFiles: 2,
		};

		const def = createFindToolDefinition(tempRoot, { fff: backend });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "foo", path: "src", limit: 10 },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;

		expect(backend.finder.searchCalls).toEqual([{ query: "src/ foo", options: { pageSize: 10 } }]);
		expect(getText(result)).toContain("foo.ts");
		expect(getText(result)).not.toContain("other/");
	});

	it("returns no find matches when FFF returns only out-of-scope paths", async () => {
		const backend = new FakeFffBackend();
		backend.finder.searchResult = {
			items: [fileItem("other/foo.ts")],
			scores: [],
			totalMatched: 1,
			totalFiles: 1,
		};

		const def = createFindToolDefinition(tempRoot, { fff: backend });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "*.ts", path: "src", limit: 5 },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;

		expect(backend.finder.globCalls).toEqual([{ pattern: "src/**/*.ts", options: { pageSize: 5 } }]);
		expect(getText(result)).toBe("No files found matching pattern");
	});

	it("reports find limit metadata for FFF-backed results", async () => {
		const backend = new FakeFffBackend();
		backend.finder.searchResult = {
			items: [fileItem("src/foo.ts")],
			scores: [],
			totalMatched: 1,
			totalFiles: 2,
		};

		const def = createFindToolDefinition(tempRoot, { fff: backend });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "*.ts", path: "src", limit: 1 },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;

		expect(result.details).toEqual({ resultLimitReached: 1 });
		expect(getText(result)).toContain("1 results limit reached");
	});

	it("filters FFF grep matches to the requested file path", async () => {
		writeFileSync(join(tempRoot, "src", "foo.ts"), "TODO\n");
		writeFileSync(join(tempRoot, "src", "bar.ts"), "TODO\n");
		const backend = new FakeFffBackend();
		backend.finder.grepResult = {
			items: [grepMatch("src/foo.ts"), grepMatch("src/bar.ts")],
			totalMatched: 2,
			totalFilesSearched: 2,
			totalFiles: 2,
			filteredFileCount: 2,
			nextCursor: null,
		};

		const def = createGrepToolDefinition(tempRoot, { fff: backend });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "TODO", path: "src/foo.ts", limit: 10 },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;

		expect(backend.finder.grepCalls[0]?.query).toBe("src/foo.ts TODO");
		expect(getText(result)).toContain("foo.ts:");
		expect(getText(result)).not.toContain("bar.ts:");
	});

	it("returns no grep matches when FFF returns only out-of-scope paths", async () => {
		const backend = new FakeFffBackend();
		backend.finder.grepResult = {
			items: [grepMatch("other/foo.ts")],
			totalMatched: 1,
			totalFilesSearched: 1,
			totalFiles: 1,
			filteredFileCount: 1,
			nextCursor: null,
		};

		const def = createGrepToolDefinition(tempRoot, { fff: backend });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "TODO", path: "src", limit: 10 },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;

		expect(getText(result)).toBe("No matches found");
	});

	it("reports grep limit metadata when FFF has a next cursor", async () => {
		const backend = new FakeFffBackend();
		backend.finder.grepResult = {
			items: [grepMatch("src/foo.ts")],
			totalMatched: 1,
			totalFilesSearched: 1,
			totalFiles: 2,
			filteredFileCount: 1,
			nextCursor: "next-page",
		};

		const def = createGrepToolDefinition(tempRoot, { fff: backend });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "TODO", path: "src", limit: 1 },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;

		expect(result.details).toEqual({ matchLimitReached: 1 });
		expect(getText(result)).toContain("1 matches limit reached");
	});
});
