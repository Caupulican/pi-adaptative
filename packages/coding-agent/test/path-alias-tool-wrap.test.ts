import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { emptyPathAliasTable, extendPathAliasTable } from "../src/core/context/path-alias-table.ts";
import { wrapToolWithPathAliasExpansion } from "../src/core/context/path-alias-tool-wrap.ts";

const table = extendPathAliasTable(emptyPathAliasTable("/repo"), [
	"packages/coding-agent/src/core/tools/grep.ts",
]).table;

function recordingTool() {
	const calls: unknown[] = [];
	const tool = {
		name: "python",
		label: "Python",
		description: "runs code",
		parameters: Type.Object({ code: Type.Optional(Type.String()), path: Type.Optional(Type.String()) }),
		async execute(_id: string, params: unknown) {
			calls.push(params);
			return { content: [{ type: "text" as const, text: "ok" }], details: undefined };
		},
	};
	return { tool, calls };
}

describe("path alias tool wrapper", () => {
	it("never refuses an alias-shaped token inside code or command text", async () => {
		const { tool, calls } = recordingTool();
		const wrapped = wrapToolWithPathAliasExpansion(
			tool as never,
			() => table,
			new WeakSet(),
			() => "/repo",
		);
		await wrapped.execute(
			"t1",
			{ code: "from pathlib import Path\np = Path('x')\nf = p/name" },
			undefined as never,
			undefined,
		);
		expect(calls).toHaveLength(1);
	});

	it("still refuses an unminted alias in a path parameter and expands a minted one", async () => {
		const { tool, calls } = recordingTool();
		const wrapped = wrapToolWithPathAliasExpansion(
			tool as never,
			() => table,
			new WeakSet(),
			() => "/repo",
		);
		expect(() => wrapped.execute("t2", { path: "p/ghost.ts" }, undefined as never, undefined)).toThrow(
			/Unminted path alias "p\/ghost.ts"/,
		);
		await wrapped.execute("t3", { path: "p/grep.ts" }, undefined as never, undefined);
		expect(calls).toEqual([{ path: "packages/coding-agent/src/core/tools/grep.ts" }]);
	});
});
