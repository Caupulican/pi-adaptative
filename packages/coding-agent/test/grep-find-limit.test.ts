import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFindToolDefinition, type FindOperations } from "../src/core/tools/find.ts";
import { createGrepToolDefinition } from "../src/core/tools/grep.ts";

interface TextToolResult {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
}

function getText(result: TextToolResult): string {
	return result.content[0]?.text ?? "";
}

describe("grep/find result-limit notices", () => {
	let tempRoot: string;

	beforeEach(() => {
		tempRoot = mkdtempSync(join(tmpdir(), "pi-grep-find-limit-"));
	});

	afterEach(() => {
		rmSync(tempRoot, { recursive: true, force: true });
	});

	async function runGrep(limit: number): Promise<TextToolResult> {
		const def = createGrepToolDefinition(tempRoot, { fff: false });
		const ctx = {} as Parameters<typeof def.execute>[4];
		return (await def.execute("call-1", { pattern: "needle", limit }, undefined, undefined, ctx)) as TextToolResult;
	}

	it("does not report a grep limit when matches exactly equal the requested limit", async () => {
		writeFileSync(join(tempRoot, "a.txt"), "needle one\nneedle two\n");

		const result = await runGrep(2);

		expect(getText(result)).not.toContain("matches limit reached");
		expect(result.details).toBeUndefined();
	});

	it("reports a grep limit only when one more match exists", async () => {
		writeFileSync(join(tempRoot, "a.txt"), "needle one\nneedle two\nneedle three\n");

		const result = await runGrep(2);
		const text = getText(result);

		expect(text).toContain("2 matches limit reached");
		expect(text).toContain("needle one");
		expect(text).toContain("needle two");
		expect(text).not.toContain("needle three");
		expect(result.details).toEqual({ matchLimitReached: 2 });
	});

	async function runFind(paths: string[], limit: number): Promise<{ result: TextToolResult; observedLimit: number }> {
		let observedLimit = 0;
		const operations: FindOperations = {
			exists: () => true,
			glob: (_pattern, _cwd, options) => {
				observedLimit = options.limit;
				return paths.slice(0, options.limit);
			},
		};
		const def = createFindToolDefinition(tempRoot, { operations });
		const ctx = {} as Parameters<typeof def.execute>[4];
		const result = (await def.execute(
			"call-1",
			{ pattern: "*.txt", limit },
			undefined,
			undefined,
			ctx,
		)) as TextToolResult;
		return { result, observedLimit };
	}

	it("does not report a find limit when results exactly equal the requested limit", async () => {
		const { result, observedLimit } = await runFind(["a.txt", "b.txt"], 2);

		expect(observedLimit).toBe(3);
		expect(getText(result)).not.toContain("results limit reached");
		expect(result.details).toBeUndefined();
	});

	it("reports a find limit only when one more result exists", async () => {
		const { result, observedLimit } = await runFind(["a.txt", "b.txt", "c.txt"], 2);
		const text = getText(result);

		expect(observedLimit).toBe(3);
		expect(text).toContain("2 results limit reached");
		expect(text).toContain("a.txt");
		expect(text).toContain("b.txt");
		expect(text).not.toContain("c.txt");
		expect(result.details).toEqual({ resultLimitReached: 2 });
	});
});
