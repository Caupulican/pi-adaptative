import type { AgentMessage } from "@caupulican/pi-agent-core/types";
import { describe, expect, it } from "vitest";
import {
	applyPathAliases,
	buildPathAliasTable,
	expandParams,
	expandText,
	extractPathCandidates,
	rewriteText,
} from "../src/core/context/path-alias-table.ts";

describe("path alias table", () => {
	it("aliases a long Windows screenshot path and expands P1 back", () => {
		const windows = String.raw`C:\Users\Caupulican\Downloads\Screenshot_2.jpg`;
		const table = buildPathAliasTable("/repo", [`read ${windows}`]);
		expect(table.entries).toEqual([{ id: "P1", path: "C:/Users/Caupulican/Downloads/Screenshot_2.jpg" }]);
		expect(rewriteText(table, `read ${windows}`)).toBe("read P1");
		expect(expandText(table, "read P1")).toBe("read C:/Users/Caupulican/Downloads/Screenshot_2.jpg");
	});

	it("aliases a long cwd-relative source path and leaves short names literal", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/core/tools/grep.ts:125", "ls.ts exists"]);
		expect(table.entries.map((entry) => entry.id)).toEqual(["P1"]);
		expect(table.entries[0]?.path).toBe("packages/coding-agent/src/core/tools/grep.ts");
		expect(rewriteText(table, "packages/coding-agent/src/core/tools/grep.ts:125")).toBe("P1:125");
		expect(rewriteText(table, "ls.ts exists")).toBe("ls.ts exists");
	});

	it("does not alias URLs or already-assigned tokens", () => {
		expect(extractPathCandidates("see https://github.com/org/repo/blob/main/a.ts")).toEqual([]);
		const table = buildPathAliasTable("/repo", ["P1 is not a path"]);
		expect(table.entries).toEqual([]);
	});

	it("expands nested tool params and leaves unknown P# unchanged", () => {
		const table = buildPathAliasTable("/repo", ["packages/coding-agent/src/core/tools/grep.ts"]);
		expect(expandParams(table, { path: "P1", nested: ["P1", "P99"] })).toEqual({
			path: "packages/coding-agent/src/core/tools/grep.ts",
			nested: ["packages/coding-agent/src/core/tools/grep.ts", "P99"],
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
		expect(aliased.legend).toBe("PATH ALIASES\nP1=packages/coding-agent/src/core/tools/grep.ts");
		const rewritten = aliased.messages[0];
		if (!rewritten || rewritten.role !== "toolResult") throw new Error("expected toolResult");
		const content = rewritten.content;
		expect(Array.isArray(content) && content[0] && "text" in content[0] ? content[0].text : "").toBe("P1:125:name");
	});
});
