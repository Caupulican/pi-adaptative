import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createInMemoryArtifactStore, isMissingArtifactMarker } from "../src/core/context/context-artifacts.ts";
import { createInMemoryBroadQueryTracker } from "../src/core/context/tool-output-packer.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createFindTool, createGrepTool } from "../src/index.ts";

interface TextContentLike {
	type: "text";
	text: string;
}

interface ToolDetailsLike {
	artifactId?: string;
	matchLimitReached?: number;
	resultLimitReached?: number;
	truncation?: unknown;
	invalidationCandidate?: boolean;
}

interface ToolResultLike {
	content: Array<TextContentLike | { type: string }>;
	details?: ToolDetailsLike;
}

function isTextContent(content: TextContentLike | { type: string }): content is TextContentLike {
	return content.type === "text";
}

/** Tool `execute()` return values are typed `unknown`/generic at the wrapper boundary; this
 * narrows to the concrete shape these tests assert against without resorting to `any`. */
function toToolResult(result: unknown): ToolResultLike {
	return result as ToolResultLike;
}

function getTextOutput(result: ToolResultLike): string {
	return result.content
		.filter(isTextContent)
		.map((content) => content.text)
		.join("\n");
}

describe("Slice B: artifact-backed tool output first capture (grep/find)", () => {
	let testDir: string;

	beforeEach(() => {
		testDir = join(tmpdir(), `pi-tool-output-packing-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	it("small output stays inline and readable, with or without an artifact store", async () => {
		const testFile = join(testDir, "small.txt");
		writeFileSync(testFile, "first line\nmatch line\nlast line");
		const store = createInMemoryArtifactStore();
		const grepTool = createGrepTool(process.cwd(), { artifactStore: store });

		const result = toToolResult(
			await grepTool.execute("tc-small", { pattern: "match", path: testFile }, undefined, undefined),
		);
		const output = getTextOutput(result);
		expect(output).toContain("match line");
		expect(output).not.toContain("artifact tool-output:");
		expect(result.details?.artifactId).toBeUndefined();
		// Nothing large enough to pack was ever written.
		expect(store.cleanup()).toEqual([]);
	});

	it("regression: grep does not impose a 2000-line cap when output is well under the byte cap", async () => {
		// Pre-Slice-B, grep/find called truncateHead with maxLines: Number.MAX_SAFE_INTEGER
		// specifically because the match/result limit already bounds rows -- only the byte
		// cap should apply. packToolOutput must preserve that override, not silently fall
		// back to truncateHead's own DEFAULT_MAX_LINES (2000).
		const testFile = join(testDir, "many-short-matches.txt");
		const matchCount = 2500;
		writeFileSync(testFile, Array.from({ length: matchCount }, (_, i) => `x${i}`).join("\n"));
		const grepTool = createGrepTool(process.cwd());

		const result = toToolResult(
			await grepTool.execute(
				"tc-line-cap-regression",
				{ pattern: "x", path: testFile, limit: matchCount + 100 },
				undefined,
				undefined,
			),
		);

		const output = getTextOutput(result);
		expect(output).toContain(`  ${matchCount}: x${matchCount - 1}`); // last match line survives
		expect(result.details?.matchLimitReached).toBeUndefined();
		expect(result.details?.truncation).toBeUndefined();
	});

	it("regression: find does not impose a 2000-line cap when output is well under the byte cap", async () => {
		const fileCount = 2500;
		for (let i = 0; i < fileCount; i++) writeFileSync(join(testDir, `f${i}.txt`), "x");
		const findTool = createFindTool(process.cwd());

		const result = toToolResult(
			await findTool.execute(
				"tc-find-line-cap-regression",
				{ pattern: "*.txt", path: testDir, limit: fileCount + 100 },
				undefined,
				undefined,
			),
		);

		const output = getTextOutput(result);
		expect(output).toContain(`f${fileCount - 1}.txt`); // every file survives, not just the first 2000
		expect(result.details?.resultLimitReached).toBeUndefined();
		expect(result.details?.truncation).toBeUndefined();
	});

	it("large grep output becomes a digest + artifact handle; the artifact holds the exact raw payload", async () => {
		const manyMatchesFile = join(testDir, "many.txt");
		const lines: string[] = [];
		for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
		writeFileSync(manyMatchesFile, lines.join("\n"));

		const store = createInMemoryArtifactStore();
		const grepTool = createGrepTool(process.cwd(), { artifactStore: store });

		const result = toToolResult(
			await grepTool.execute(
				"tc-large-grep",
				{ pattern: "needle", path: manyMatchesFile, limit: 3000, context: 0 },
				undefined,
				undefined,
			),
		);

		const artifactId = result.details?.artifactId;
		expect(artifactId).toBeDefined();
		const record = store.read(artifactId!);
		expect(isMissingArtifactMarker(record)).toBe(false);
		if (!isMissingArtifactMarker(record)) {
			// Exact raw payload, not the bounded preview: every one of the 3000 matches
			// must be present, each on its own line plus the file header line.
			expect(record.content.split("\n").length).toBe(3001);
			expect(record.content).toContain("needle occurrence number 2999");
			expect(record.ref.toolName).toBe("grep");
		}
		expect(getTextOutput(result)).toContain(`artifact tool-output:${artifactId}`);
	});

	it("large find output becomes a digest + artifact handle; the artifact holds the exact raw payload", async () => {
		// Only the byte cap (50KB) should be able to trigger packing here (the line cap was
		// deliberately disabled -- see the regression test above), so use enough
		// long-enough filenames to exceed 50KB, not just enough to exceed 2000 lines.
		const fileCount = 6000;
		for (let i = 0; i < fileCount; i++) {
			writeFileSync(join(testDir, `file-with-a-longer-name-${i}.txt`), "x");
		}

		const store = createInMemoryArtifactStore();
		const findTool = createFindTool(process.cwd(), { artifactStore: store });

		const result = toToolResult(
			await findTool.execute(
				"tc-large-find",
				{ pattern: "*.txt", path: testDir, limit: fileCount + 1000 },
				undefined,
				undefined,
			),
		);

		const artifactId = result.details?.artifactId;
		expect(artifactId).toBeDefined();
		const record = store.read(artifactId!);
		expect(isMissingArtifactMarker(record)).toBe(false);
		if (!isMissingArtifactMarker(record)) {
			expect(record.ref.toolName).toBe("find");
			// Exact raw payload, not the bounded preview: the last generated file must be
			// present, and the artifact must contain far more lines than any bounded
			// preview the model sees (proving it captured the untruncated list).
			expect(record.content).toContain(`file-with-a-longer-name-${fileCount - 1}.txt`);
			const previewLineCount = getTextOutput(result).split("\n").length;
			const artifactLineCount = record.content.split("\n").length;
			expect(artifactLineCount).toBeGreaterThan(previewLineCount);
			expect(artifactLineCount).toBeGreaterThanOrEqual(fileCount); // "./" header + fileCount entries
		}
		expect(getTextOutput(result)).toContain(`artifact tool-output:${artifactId}`);
	});

	it("find's broad-result notice includes an actionable narrowing hint, like grep's", async () => {
		for (let i = 0; i < 10; i++) writeFileSync(join(testDir, `capped-${i}.txt`), "x");
		const findTool = createFindTool(process.cwd());

		const result = toToolResult(
			await findTool.execute("tc-find-hint", { pattern: "*.txt", path: testDir, limit: 5 }, undefined, undefined),
		);

		const output = getTextOutput(result);
		expect(output).toContain("5 results limit reached");
		expect(output).toContain("Use limit=10 for more, or narrow path/pattern");
	});

	it("repeated identical broad grep query yields an invalidation-candidate note the second time", async () => {
		const testFile = join(testDir, "broad.txt");
		const lines: string[] = [];
		for (let i = 0; i < 20; i++) lines.push(`needle ${i}`);
		writeFileSync(testFile, lines.join("\n"));

		const broadQueryTracker = createInMemoryBroadQueryTracker();
		const grepTool = createGrepTool(process.cwd(), { broadQueryTracker });
		const args = { pattern: "needle", path: testFile, limit: 1 };

		const first = toToolResult(await grepTool.execute("tc-broad-1", args, undefined, undefined));
		expect(first.details?.invalidationCandidate).toBeUndefined();
		expect(getTextOutput(first)).not.toContain("Do not repeat");

		const second = toToolResult(await grepTool.execute("tc-broad-2", args, undefined, undefined));
		expect(second.details?.invalidationCandidate).toBe(true);
		expect(getTextOutput(second)).toContain("Do not repeat");
		expect(getTextOutput(second)).toContain("2 times");
	});

	it("repeated identical broad find query yields an invalidation-candidate note the second time", async () => {
		for (let i = 0; i < 10; i++) writeFileSync(join(testDir, `repeat-${i}.txt`), "x");
		const broadQueryTracker = createInMemoryBroadQueryTracker();
		const findTool = createFindTool(process.cwd(), { broadQueryTracker });
		const args = { pattern: "*.txt", path: testDir, limit: 2 };

		await findTool.execute("tc-find-broad-1", args, undefined, undefined);
		const second = toToolResult(await findTool.execute("tc-find-broad-2", args, undefined, undefined));

		expect(second.details?.invalidationCandidate).toBe(true);
		expect(getTextOutput(second)).toContain("Do not repeat");
	});

	it("a distinct query does not trigger the repeated-broad-query note", async () => {
		const testFile = join(testDir, "distinct.txt");
		writeFileSync(testFile, Array.from({ length: 20 }, (_, i) => `needle ${i}`).join("\n"));
		const broadQueryTracker = createInMemoryBroadQueryTracker();
		const grepTool = createGrepTool(process.cwd(), { broadQueryTracker });

		await grepTool.execute("tc-a", { pattern: "needle", path: testFile, limit: 1 }, undefined, undefined);
		const differentPattern = toToolResult(
			await grepTool.execute("tc-b", { pattern: "eedl", path: testFile, limit: 1 }, undefined, undefined),
		);

		expect(differentPattern.details?.invalidationCandidate).toBeUndefined();
	});

	it("a packed artifact survives cleanup (it is referenced) while unreferenced artifacts are collected", async () => {
		const testFile = join(testDir, "many2.txt");
		const lines: string[] = [];
		for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
		writeFileSync(testFile, lines.join("\n"));

		const store = createInMemoryArtifactStore();
		const grepTool = createGrepTool(process.cwd(), { artifactStore: store });
		const result = toToolResult(
			await grepTool.execute("tc-cleanup", { pattern: "needle", path: testFile, limit: 3000 }, undefined, undefined),
		);

		const artifactId = result.details?.artifactId;
		expect(artifactId).toBeDefined();
		const deleted = store.cleanup();
		expect(deleted).not.toContain(artifactId);
		expect(store.has(artifactId!)).toBe(true);
	});

	it("missing artifact on retrieval yields an explicit marker, never fabricated/empty content", async () => {
		const testFile = join(testDir, "many3.txt");
		const lines: string[] = [];
		for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
		writeFileSync(testFile, lines.join("\n"));

		const store = createInMemoryArtifactStore();
		const grepTool = createGrepTool(process.cwd(), { artifactStore: store });
		const result = toToolResult(
			await grepTool.execute("tc-missing", { pattern: "needle", path: testFile, limit: 3000 }, undefined, undefined),
		);
		const artifactId = result.details?.artifactId;
		expect(artifactId).toBeDefined();

		// Simulate the reference being released and cleanup running (e.g. goal closed).
		store.removeReference(artifactId!, "tc-missing");
		store.cleanup();

		const record = store.read(artifactId!);
		expect(isMissingArtifactMarker(record)).toBe(true);
		if (isMissingArtifactMarker(record)) expect(record.reason).toBe("cleaned_up");
		expect((record as { content?: unknown }).content).toBeUndefined();
	});
});

describe("Slice B: bash tool already preserves decision-bearing failure detail (unchanged this slice)", () => {
	it("preserves the exact first-line output and non-zero exit status for a failing command", async () => {
		const bashTool = createBashTool(process.cwd());

		await expect(
			bashTool.execute(
				"tc-bash-fail",
				{ command: "echo 'first error: something specific broke' && exit 7" },
				undefined,
				undefined,
			),
		).rejects.toThrow(/first error: something specific broke[\s\S]*exited with code 7/);
	});

	it("never hides a non-zero exit status behind a vague digest, even with large output", async () => {
		const bashTool = createBashTool(process.cwd());

		await expect(
			bashTool.execute(
				"tc-bash-fail-large",
				{
					command:
						"for i in $(seq 1 3000); do echo \"line $i\"; done; echo 'first error: exact failure detail'; exit 3",
				},
				undefined,
				undefined,
			),
		).rejects.toThrow(/exited with code 3/);
	});
});
