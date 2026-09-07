import { describe, expect, it } from "vitest";
import {
	createExecutionContext,
	type ExecutionContext,
	resolveExecutionPath,
	resolveExecutionResource,
} from "../src/execution-paths.ts";
import { getToolExecutionKey } from "../src/tool-failure-memory.ts";

function context(root = "/fixture/repository", attachmentId = "fixture-attachment"): ExecutionContext {
	return createExecutionContext({
		attachment: { workspaceId: "fixture-workspace", attachmentId, root, flavor: "posix", caseSensitive: true },
		sessionId: "fixture-session",
		generation: 0,
		cwd: `${root}/package`,
	});
}

describe("host-owned execution context", () => {
	it("retains task identity and separates replay scopes for tasks sharing a directory", () => {
		const first = createExecutionContext({ ...context(), taskId: "first" });
		const second = createExecutionContext({ ...first, taskId: "second" });
		expect(first.taskId).toBe("first");
		expect(getToolExecutionKey("context", first)).not.toBe(getToolExecutionKey("context", second));
		expect(getToolExecutionKey("context", first)).toBe(getToolExecutionKey("context", createExecutionContext(first)));
		for (const taskId of ["", "x".repeat(257), "bad\nidentity"]) {
			expect(() => createExecutionContext({ ...context(), taskId })).toThrow("identity");
		}
	});
	it("freezes an independent attachment snapshot", () => {
		const source = { ...context(), attachment: { ...context().attachment } };
		const snapshot = createExecutionContext(source);
		source.attachment.root = "/different";
		expect(snapshot.attachment.root).toBe("/fixture/repository");
		expect(Object.isFrozen(snapshot)).toBe(true);
		expect(Object.isFrozen(snapshot.attachment)).toBe(true);
	});
	it("keeps logical resource identity across an explicit attachment change without reusing the old attachment", () => {
		const resource = { base: "workspace", path: "src/example.ts" } as const;
		const initial = resolveExecutionResource(context(), resource);
		const moved = resolveExecutionResource(context("/mounted/new location", "fixture-moved"), resource);
		expect(initial.workspacePath).toBe(moved.workspacePath);
		expect(initial.path).not.toBe(moved.path);
		expect(initial.context.attachment.attachmentId).not.toBe(moved.context.attachment.attachmentId);
	});
	it.each(["../outside", "/fixture/repository-other/file", "/outside"])("rejects workspace escape %s", (path) => {
		expect(() => resolveExecutionResource(context(), { base: "workspace", path })).toThrow();
	});
	it("does not accept machine-absolute spelling as a portable workspace reference", () => {
		expect(() =>
			resolveExecutionResource(context(), { base: "workspace", path: "/fixture/repository/file" }),
		).toThrow();
	});
	it("does not label an external absolute resource as workspace-owned", () => {
		const resource = resolveExecutionResource(context(), { base: "absolute", path: "/external/file" });
		expect(resource.workspacePath).toBeUndefined();
	});
	it.each(["relative", "", "\0"])("rejects invalid context root %j", (root) => {
		expect(() => context(root)).toThrow();
	});
	it.each([-1, 0.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])("rejects generation %s", (generation) => {
		expect(() => createExecutionContext({ ...context(), generation })).toThrow();
	});
	it("does not confuse a case-sensitive Windows directory with its differently cased sibling", () => {
		const winContext = createExecutionContext({
			...context(),
			attachment: { ...context().attachment, root: "Q:\\Project", flavor: "win32", caseSensitive: true },
			cwd: "Q:\\Project",
		});
		expect(
			resolveExecutionResource(winContext, { base: "absolute", path: "Q:\\project\\file" }).workspacePath,
		).toBeUndefined();
		const insensitive = createExecutionContext({
			...winContext,
			attachment: { ...winContext.attachment, caseSensitive: false },
		});
		expect(resolveExecutionResource(insensitive, { base: "absolute", path: "Q:\\project\\file" }).workspacePath).toBe(
			"file",
		);
	});
	it("runs the same relocation property across deterministic synthetic roots", () => {
		for (let index = 0; index < 64; index++) {
			const root = `/fixture/space ${index}/\u65e5\u672c\u8a9e`;
			expect(resolveExecutionResource(context(root), { base: "workspace", path: "a/../b" }).path).toBe(`${root}/b`);
			expect(resolveExecutionPath("b", `Q:\\fixture space ${index}\\\u65e5\u672c\u8a9e`, "win32")).toBe(
				`Q:\\fixture space ${index}\\\u65e5\u672c\u8a9e\\b`,
			);
		}
	});
});
