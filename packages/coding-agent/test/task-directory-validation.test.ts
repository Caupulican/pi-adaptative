import { createExecutionContext, type ExecutionContext } from "@caupulican/pi-agent-core/paths";
import { describe, expect, it, vi } from "vitest";
import { createTaskDirectoryValidator } from "../src/core/tasks/task-directory-validation.ts";

function context(root = "/fixture/project", cwd = `${root}/src`, flavor: "posix" | "win32" = "posix") {
	return createExecutionContext({
		attachment: { workspaceId: "project", attachmentId: "attached", root, flavor, caseSensitive: flavor === "posix" },
		cwd,
		sessionId: "session",
		generation: 1,
	});
}

describe("task directory backend validation", () => {
	it.each([
		context(),
		context("D:\\Project One", "D:\\Project One\\資料", "win32"),
		context("\\\\server\\share\\project", "\\\\server\\share\\project\\src", "win32"),
	])("uses declared backend syntax and authorizes the same immutable context %#", async (input) => {
		const resolveDirectory = vi.fn(async (path: string) => path);
		const authorize = vi.fn(async (_context: ExecutionContext, _resolved: ExecutionContext) => {});
		const validate = createTaskDirectoryValidator({ flavor: input.attachment.flavor, resolveDirectory }, authorize);
		await validate(input);
		expect(authorize).toHaveBeenCalledWith(input, input, undefined);
		expect(Object.isFrozen(authorize.mock.calls[0]?.[1])).toBe(true);
	});

	it("rejects foreign attachments before accessing a native backend", async () => {
		const resolveDirectory = vi.fn(async (path: string) => path);
		const authorize = vi.fn(async () => {});
		const validate = createTaskDirectoryValidator({ flavor: "posix", resolveDirectory }, authorize);
		await expect(validate(context("D:\\project", "D:\\project", "win32"))).rejects.toThrow("reattach");
		expect(resolveDirectory).not.toHaveBeenCalled();
		expect(authorize).not.toHaveBeenCalled();
	});

	it("rejects a directory symlink escaping the attachment but permits an internal link", async () => {
		const input = context();
		const authorize = vi.fn(async () => {});
		const resolveDirectory = vi.fn(async (path: string) => (path === input.cwd ? "/fixture/other" : path));
		const validate = createTaskDirectoryValidator({ flavor: "posix", resolveDirectory }, authorize);
		await expect(validate(input)).rejects.toThrow("escaped");
		expect(authorize).not.toHaveBeenCalled();
		resolveDirectory.mockImplementation(async (path) => (path === input.cwd ? "/fixture/project/lib" : path));
		await validate(input);
		expect(authorize).toHaveBeenCalledOnce();
	});

	it("authorizes a relocated root and its resolved child without changing admitted identity", async () => {
		const input = context();
		const authorize = vi.fn(async (_context: ExecutionContext, _resolved: ExecutionContext) => {});
		const validate = createTaskDirectoryValidator(
			{
				flavor: "posix",
				resolveDirectory: async (path) => path.replace("/fixture/project", "/volume/project"),
			},
			authorize,
		);
		await validate(input);
		expect(authorize.mock.calls[0]?.[0]).toBe(input);
		expect(authorize.mock.calls[0]?.[1].cwd).toBe("/volume/project/src");
		expect(authorize.mock.calls[0]?.[1].attachment.attachmentId).toBe("attached");
	});

	it("preserves backend errors and never substitutes the process directory", async () => {
		const failure = Object.assign(new Error("fixture unavailable"), { code: "EACCES" });
		const authorize = vi.fn(async () => {});
		const validate = createTaskDirectoryValidator(
			{
				flavor: "posix",
				resolveDirectory: async () => {
					throw failure;
				},
			},
			authorize,
		);
		await expect(validate(context())).rejects.toBe(failure);
		expect(authorize).not.toHaveBeenCalled();
	});

	it("does not turn directory existence into an authority grant", async () => {
		const validate = createTaskDirectoryValidator(
			{ flavor: "posix", resolveDirectory: async (path) => path },
			async () => {
				throw new Error("capability denied");
			},
		);
		await expect(validate(context())).rejects.toThrow("capability denied");
	});

	it("honors cancellation before backend access", async () => {
		const resolveDirectory = vi.fn(async (path: string) => path);
		const validate = createTaskDirectoryValidator({ flavor: "posix", resolveDirectory }, async () => {});
		await expect(validate(context(), AbortSignal.abort())).rejects.toThrow();
		expect(resolveDirectory).not.toHaveBeenCalled();
	});
});
