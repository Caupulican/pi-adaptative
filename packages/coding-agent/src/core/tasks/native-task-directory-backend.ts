import { realpath, stat } from "node:fs/promises";
import type { TaskDirectoryBackend } from "./task-directory-validation.ts";

/** Native adapter only. Remote/virtual backends must provide their own directory resolver. */
export function createNativeTaskDirectoryBackend(): TaskDirectoryBackend {
	return {
		flavor: process.platform === "win32" ? "win32" : "posix",
		async resolveDirectory(path, signal) {
			signal?.throwIfAborted();
			const resolved = await realpath(path);
			signal?.throwIfAborted();
			const info = await stat(resolved);
			signal?.throwIfAborted();
			if (!info.isDirectory())
				throw Object.assign(new Error("Task working directory is not a directory"), { code: "ENOTDIR" });
			return resolved;
		},
	};
}
