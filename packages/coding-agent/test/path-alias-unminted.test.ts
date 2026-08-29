/**
 * Unminted alias ids must fail with a diagnostic that names the mistake.
 *
 * The model extrapolates ids from the legend's pattern — `p/module01.ts` is listed, so it reaches
 * for `p/module02.ts` — and an unminted token survives expansion untouched, then fails as a literal
 * relative path with `ENOENT ... /p/module02.ts`. That error describes a `p/` directory the project
 * does not have, so the model misdiagnoses it and burns a turn (and, before the ledger moved to the
 * tail, each such failure also churned the cached system prompt).
 *
 * The fences matter as much as the rejection: a repo with a REAL `p/` tree must keep working.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTool } from "@caupulican/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectUnknownAliasTokens, type PathAliasTable } from "../src/core/context/path-alias-table.ts";
import { wrapToolWithPathAliasExpansion } from "../src/core/context/path-alias-tool-wrap.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "pi-unminted-alias-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function table(): PathAliasTable {
	return {
		cwd: dir,
		entries: [{ id: "p/module01.ts", path: "src/core/module01.ts" }],
		reservedIds: ["p/reserved.ts"],
	};
}

function runTool(params: unknown): { seen: unknown } {
	const seen: { seen: unknown } = { seen: undefined };
	const tool = {
		name: "read",
		label: "Read",
		description: "Read a file",
		parameters: {} as never,
		execute: async (_id: string, received: unknown) => {
			seen.seen = received;
			return { content: [{ type: "text" as const, text: "ok" }], details: {} };
		},
	} as unknown as AgentTool;
	const wrapped = wrapToolWithPathAliasExpansion(
		tool,
		() => table(),
		new WeakSet(),
		() => dir,
	);
	// Errors surface synchronously from the wrapper, before the tool body runs.
	void (wrapped.execute as (id: string, params: unknown) => unknown)("call-1", params);
	return seen;
}

describe("collectUnknownAliasTokens", () => {
	it("reports only alias-shaped tokens that name nothing", () => {
		expect(collectUnknownAliasTokens(table(), { path: "p/module02.ts" })).toEqual(["p/module02.ts"]);
		expect(collectUnknownAliasTokens(table(), { path: "p/module01.ts" })).toEqual([]);
		expect(collectUnknownAliasTokens(table(), { path: "p/reserved.ts" })).toEqual([]);
	});

	it("ignores an alias-shaped substring embedded in a real path", () => {
		expect(collectUnknownAliasTokens(table(), { path: "src/p/util-helpers.ts" })).toEqual([]);
	});

	it("walks arrays and nested objects, deduplicated in first-seen order", () => {
		const params = { paths: ["p/beta.ts", "p/alpha.ts"], nested: { also: "p/beta.ts" } };
		expect(collectUnknownAliasTokens(table(), params)).toEqual(["p/beta.ts", "p/alpha.ts"]);
	});

	it("is a no-op for params carrying no strings", () => {
		expect(collectUnknownAliasTokens(table(), { count: 3, deep: { flag: true } })).toEqual([]);
	});
});

describe("wrapToolWithPathAliasExpansion unminted-alias guard", () => {
	it("rejects an invented alias id with a diagnostic naming the mistake", () => {
		expect(() => runTool({ path: "p/module02.ts" })).toThrow(/Unminted path alias "p\/module02\.ts"/);
		expect(() => runTool({ path: "p/module02.ts" })).toThrow(/Never invent p\/ tokens/);
	});

	it("names additional unminted tokens, capped", () => {
		expect(() => runTool({ paths: ["p/a.ts", "p/b.ts", "p/c.ts"] })).toThrow(/Also unminted: p\/b\.ts, p\/c\.ts\./);
	});

	it("expands a minted id and runs the tool", () => {
		expect(runTool({ path: "p/module01.ts" }).seen).toEqual({ path: "src/core/module01.ts" });
	});

	it("passes a reserved token through untouched", () => {
		expect(runTool({ path: "p/reserved.ts" }).seen).toEqual({ path: "p/reserved.ts" });
	});

	it("passes an unminted token through when a real p/ tree holds that file", () => {
		mkdirSync(join(dir, "p"), { recursive: true });
		writeFileSync(join(dir, "p", "real.ts"), "export const real = 1;\n");
		expect(runTool({ path: "p/real.ts" }).seen).toEqual({ path: "p/real.ts" });
	});
});
