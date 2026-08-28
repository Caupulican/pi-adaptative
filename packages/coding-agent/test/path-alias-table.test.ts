import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import {
	applyPathAliases,
	buildPathAliasTable,
	emptyPathAliasTable,
	expandParams,
	expandText,
	extendPathAliasTable,
	extractPathCandidates,
	rewriteText,
} from "../src/core/context/path-alias-table.ts";

describe("path alias table", () => {
	it("aliases a long Windows screenshot path to p/basename and expands it back", () => {
		const windows = String.raw`C:\Users\Caupulican\Downloads\Screenshot_2.jpg`;
		const table = buildPathAliasTable("/repo", [`read ${windows}`]);
		expect(table.entries).toEqual([
			{ id: "p/Screenshot_2.jpg", path: "C:/Users/Caupulican/Downloads/Screenshot_2.jpg" },
		]);
		expect(rewriteText(table, `read ${windows}`)).toBe("read p/Screenshot_2.jpg");
		expect(expandText(table, "read p/Screenshot_2.jpg")).toBe("read C:/Users/Caupulican/Downloads/Screenshot_2.jpg");
	});

	it("uses unique basenames and grows the suffix when two files share a name", () => {
		const table = buildPathAliasTable("/repo", [
			"packages/coding-agent/src/core/tools/grep.ts:125",
			"packages/coding-agent/src/core/tools/grep.tsx",
			"packages/coding-agent/src/foo.ts",
			"packages/coding-agent/test/foo.ts",
			"ls.ts exists",
		]);
		expect(table.entries.map((entry) => entry.id).sort()).toEqual(
			["p/grep.ts", "p/grep.tsx", "p/src/foo.ts", "p/test/foo.ts"].sort(),
		);
		expect(rewriteText(table, "packages/coding-agent/src/core/tools/grep.ts:125")).toBe("p/grep.ts:125");
		expect(rewriteText(table, "ls.ts exists")).toBe("ls.ts exists");
	});

	it("does not alias URLs or already-assigned tokens", () => {
		expect(extractPathCandidates("see https://github.com/org/repo/blob/main/a.ts")).toEqual([]);
		const table = buildPathAliasTable("/repo", ["p/grep.ts is not a path"]);
		expect(table.entries).toEqual([]);
	});

	it("does not expand percentile metrics p50 p90 P50 P90", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/core/tools/grep.ts"]);
		const metrics = "p50=1.2s p90=3.0s P50=100 P90=50 median=p50";
		expect(expandText(table, metrics)).toBe(metrics);
		expect(rewriteText(table, metrics)).toBe(metrics);
	});

	it("expands nested tool params and leaves unknown p/ tokens unchanged", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/core/tools/grep.ts"]);
		expect(expandParams(table, { path: "p/grep.ts", nested: ["p/grep.ts", "p/missing.ts"] })).toEqual({
			path: "packages/coding-agent/src/core/tools/grep.ts",
			nested: ["packages/coding-agent/src/core/tools/grep.ts", "p/missing.ts"],
		});
	});

	it("rewrites tool result text and builds a legend", () => {
		const messages = [
			{
				role: "toolResult",
				toolCallId: "t1",
				toolName: "bash",
				content: [
					{
						type: "text",
						text: "packages/coding-agent/src/core/tools/grep.ts:125:name",
					},
				],
				isError: false,
				timestamp: 0,
			},
		] as AgentMessage[];
		const aliased = applyPathAliases("/repo", messages);
		expect(aliased.legend).toBe("PATH ALIASES\np/grep.ts=packages/coding-agent/src/core/tools/grep.ts");
		const rewritten = aliased.messages[0];
		if (!rewritten || rewritten.role !== "toolResult") throw new Error("expected toolResult");
		const content = rewritten.content;
		expect(Array.isArray(content) && content[0] && "text" in content[0] ? content[0].text : "").toBe(
			"p/grep.ts:125:name",
		);
	});

	it("freezes alias ids when a colliding sibling later disappears", () => {
		let table = emptyPathAliasTable("/repo");
		const first = extendPathAliasTable(table, [
			"packages/coding-agent/src/foo.ts",
			"packages/coding-agent/test/foo.ts",
		]);
		expect(first.inserted.map((entry) => entry.id).sort()).toEqual(["p/src/foo.ts", "p/test/foo.ts"]);
		table = first.table;
		const second = extendPathAliasTable(table, ["packages/coding-agent/src/foo.ts"]);
		expect(second.inserted).toEqual([]);
		expect(table.entries.find((entry) => entry.path.endsWith("/src/foo.ts"))?.id).toBe("p/src/foo.ts");
	});
});
