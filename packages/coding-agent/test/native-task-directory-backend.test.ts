import type * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type * as fsPromises from "node:fs/promises";
import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { createExecutionContext } from "@caupulican/pi-agent-core/paths";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createNativeTaskDirectoryBackend,
	resolveNativeLinkTarget,
} from "../src/core/tasks/native-task-directory-backend.ts";

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, statSync: vi.fn(original.statSync) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
	const original = await importOriginal<typeof fsPromises>();
	return { ...original, stat: vi.fn(original.stat) };
});

describe("native task directory backend", () => {
	afterEach(() => {
		vi.mocked(statSync).mockReset();
		vi.mocked(stat).mockReset();
	});
	it("never uses synchronous metadata I/O and cancels a stalled identity read", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-directory-async-"));
		try {
			const info = statSync(scratch, { bigint: true });
			const completion = Promise.withResolvers<typeof info>();
			vi.mocked(stat).mockReturnValueOnce(completion.promise);
			vi.mocked(statSync).mockImplementationOnce(() => {
				throw new Error("synchronous identity I/O is forbidden");
			});
			const abort = new AbortController();
			const pending = createNativeTaskDirectoryBackend().createAttachmentId(scratch, "fixture", abort.signal);
			expect(pending).toBeInstanceOf(Promise);
			abort.abort(new Error("fixture cancellation"));
			await expect(pending).rejects.toThrow("fixture cancellation");
			completion.resolve(info);
			await completion.promise;
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});
	it("resolves directories and junctions without accepting files or missing roots", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-directory-backend-"));
		try {
			const directory = join(scratch, "project 資料");
			const link = join(scratch, "linked project");
			const file = join(scratch, "not-directory");
			mkdirSync(directory);
			symlinkSync(directory, link, process.platform === "win32" ? "junction" : "dir");
			writeFileSync(file, "synthetic fixture");
			const backend = createNativeTaskDirectoryBackend();
			expect(backend.flavor).toBe(process.platform === "win32" ? "win32" : "posix");
			expect(await backend.resolveDirectory(link)).toBe(await backend.resolveDirectory(directory));
			await expect(backend.resolveDirectory(file)).rejects.toMatchObject({ code: "ENOTDIR" });
			await expect(backend.createAttachmentId(file)).rejects.toMatchObject({ code: "ENOTDIR" });
			await expect(backend.resolveDirectory(join(scratch, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
			await expect(backend.resolveDirectory(directory, AbortSignal.abort())).rejects.toThrow();
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it("does not treat mutable or unavailable birthtime metadata as directory identity", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-directory-identity-"));
		try {
			const backend = createNativeTaskDirectoryBackend();
			const info = statSync(scratch, { bigint: true });
			// Node may project ctime into birthtime when creation time is unavailable.
			vi.mocked(stat).mockResolvedValueOnce({
				...info,
				birthtimeNs: info.birthtimeNs + 1n,
				isDirectory: info.isDirectory.bind(info),
			});
			const attachmentId = await backend.createAttachmentId(scratch, "fixture");
			const context = createExecutionContext({
				sessionId: "fixture-session",
				generation: 0,
				cwd: scratch,
				attachment: {
					workspaceId: "fixture",
					attachmentId,
					root: scratch,
					flavor: backend.flavor,
					caseSensitive: backend.flavor !== "win32",
				},
			});
			await expect(backend.validateAttachment(context, context)).resolves.toBeUndefined();
			await expect(backend.validateAttachment(context, context, AbortSignal.abort())).rejects.toThrow();
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it.each(["EACCES", "EIO", "ELOOP"])("preserves %s when capturing native identity", async (code) => {
		const error = Object.assign(new Error("synthetic filesystem failure"), { code });
		vi.mocked(stat).mockRejectedValueOnce(error);
		await expect(createNativeTaskDirectoryBackend().createAttachmentId("synthetic-root")).rejects.toThrow(error);
	});
});

describe("native directory canonical spelling", () => {
	it("keeps the filesystem root spelling and resolves symlink chains component by component", async () => {
		const scratch = mkdtempSync(join(tmpdir(), "pi-directory-root-"));
		try {
			const backend = createNativeTaskDirectoryBackend();
			const root = parse(scratch).root;
			// A session started at a drive/filesystem root must admit: the root is its own canonical name.
			expect(await backend.resolveDirectory(root)).toBe(root);
			expect(await backend.canonicalPath(root)).toBe(root);
			const target = join(scratch, "target");
			const first = join(scratch, "first");
			const second = join(scratch, "second");
			mkdirSync(target);
			symlinkSync(target, first, process.platform === "win32" ? "junction" : "dir");
			symlinkSync(first, second, process.platform === "win32" ? "junction" : "dir");
			const resolved = await backend.resolveDirectory(join(second, "."));
			expect(resolved).toBe(await backend.resolveDirectory(target));
			expect(parse(resolved).root).toBe(root);
			expect(await backend.canonicalPath(join(scratch, "missing", "leaf"))).toBeUndefined();
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
	});

	it.each([
		["\\\\?\\D:\\Projects\\app", "D:\\Projects\\app"],
		["\\\\?\\UNC\\server\\share\\app", "\\\\server\\share\\app"],
		["\\\\?\\Volume{4053d979-ece3-4e40-af81-1ebc2faade7b}\\", "D:\\mount"],
		["Volume{4053d979-ece3-4e40-af81-1ebc2faade7b}\\data", "D:\\mount"],
		["..\\sibling", "D:\\sibling"],
	])("spells a Windows link target %s as a DOS path or keeps the mount point itself", (target, expected) => {
		expect(resolveNativeLinkTarget("D:\\mount", target, "win32")).toBe(expected);
	});

	it("spells a POSIX link target relative to the link's directory", () => {
		expect(resolveNativeLinkTarget("/srv/link", "../data", "posix")).toBe("/data");
		expect(resolveNativeLinkTarget("/srv/link", "/abs/data", "posix")).toBe("/abs/data");
	});
});
