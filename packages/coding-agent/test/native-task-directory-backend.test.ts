import type * as fs from "node:fs";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExecutionContext } from "@caupulican/pi-agent-core/paths";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativeTaskDirectoryBackend } from "../src/core/tasks/native-task-directory-backend.ts";

vi.mock("node:fs", async (importOriginal) => {
	const original = await importOriginal<typeof fs>();
	return { ...original, statSync: vi.fn(original.statSync) };
});

describe("native task directory backend", () => {
	afterEach(() => vi.mocked(statSync).mockReset());
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
			vi.mocked(statSync).mockReturnValueOnce({ ...info, birthtimeNs: info.birthtimeNs + 1n });
			const attachmentId = backend.createAttachmentId(scratch, "fixture");
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

	it.each(["EACCES", "EIO", "ELOOP"])("preserves %s when capturing native identity", (code) => {
		const error = Object.assign(new Error("synthetic filesystem failure"), { code });
		vi.mocked(statSync).mockImplementationOnce(() => {
			throw error;
		});
		expect(() => createNativeTaskDirectoryBackend().createAttachmentId("synthetic-root")).toThrow(error);
	});
});
