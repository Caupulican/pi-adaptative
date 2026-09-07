import { join, resolve } from "node:path";
import { createExecutionContext } from "@caupulican/pi-agent-core/paths";
import { Type } from "typebox";
import { describe, expect, it, vi } from "vitest";
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
	it("expands aliases before admission even without an existing argument preparer", () => {
		const { tool } = recordingTool();
		const wrapped = wrapToolWithPathAliasExpansion(
			tool,
			() => table,
			new WeakSet(),
			() => "/repo",
		);
		expect(wrapped.prepareArguments?.({ path: "p/grep.ts" })).toEqual({
			path: "packages/coding-agent/src/core/tools/grep.ts",
		});
	});

	it("anchors expansions to the legend root when the admitted directory differs from it", async () => {
		// Live defect (Windows probe): after `task_directory select packages/coding-agent`, `p/…` expanded
		// to a repo-relative path that the bound executor resolved against the pinned directory.
		// The legend is host-owned, so the fixture uses host-absolute paths on every platform.
		const root = resolve("/repo");
		const hostTable = extendPathAliasTable(emptyPathAliasTable(root), [
			"packages/coding-agent/src/core/tools/grep.ts",
		]).table;
		const pinned = join(root, "packages", "coding-agent");
		const expected = join(pinned, "src", "core", "tools", "grep.ts");
		const { tool, calls } = recordingTool();
		const executionContext = createExecutionContext({
			attachment: {
				workspaceId: "coding-agent",
				attachmentId: "coding-agent-v1",
				root: pinned,
				flavor: process.platform === "win32" ? "win32" : "posix",
				caseSensitive: process.platform !== "win32",
			},
			cwd: pinned,
			sessionId: "alias-test",
			generation: 2,
		});
		const wrapped = wrapToolWithPathAliasExpansion(
			{ ...tool, bindInvocation: async () => ({ executionContext, execute: tool.execute, release: () => {} }) },
			() => hostTable,
			new WeakSet(),
			() => root,
		);
		const invocation = await wrapped.bindInvocation!("bound", { path: "p/grep.ts", code: "open('p/grep.ts')" });
		await invocation.execute("bound", { path: "p/grep.ts", code: "open('p/grep.ts')" });
		invocation.release();
		expect(calls).toEqual([{ path: expected, code: `open('${expected}')` }]);
	});

	it.each(["p/grep.ts", "p/ghost.ts"])(
		"decorates the admitted executor for %s and retains its release owner",
		async (path) => {
			const { tool, calls } = recordingTool();
			const boundExecute = vi.fn(tool.execute);
			const release = vi.fn();
			const executionContext = createExecutionContext({
				attachment: {
					workspaceId: "repo",
					attachmentId: "repo-v1",
					root: "/repo",
					flavor: "posix",
					caseSensitive: true,
				},
				cwd: "/repo",
				sessionId: "alias-test",
				generation: 0,
			});
			const bindInvocation = vi.fn(async () => ({ executionContext, execute: boundExecute, release }));
			const wrapped = wrapToolWithPathAliasExpansion(
				{ ...tool, bindInvocation },
				() => table,
				new WeakSet(),
				() => "/repo",
			);
			const invocation = await wrapped.bindInvocation!("bound", { path });
			try {
				if (path === "p/ghost.ts") {
					expect(() => invocation.execute("bound", { path })).toThrow("Unminted path alias");
					expect(boundExecute).not.toHaveBeenCalled();
				} else {
					await invocation.execute("bound", { path });
					expect(calls).toEqual([{ path: "packages/coding-agent/src/core/tools/grep.ts" }]);
				}
			} finally {
				invocation.release();
			}
			expect(bindInvocation).toHaveBeenCalledTimes(1);
			expect(release).toHaveBeenCalledTimes(1);
		},
	);

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
