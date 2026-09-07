import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createNativeTaskDirectoryBackend } from "../src/core/tasks/native-task-directory-backend.ts";

describe("native task directory backend", () => {
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
});
