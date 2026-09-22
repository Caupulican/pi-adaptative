import { rmSync } from "node:fs";
import { retryTransientWin32Sync } from "./win32-transient-fs.ts";

/**
 * Remove a directory tree. On win32 a freshly written file can stay open for a scan without
 * FILE_SHARE_DELETE, so the first rm fails EPERM/EACCES/EBUSY. The retry is the shared Windows
 * transient backoff. POSIX removes once.
 */
export function removeTreeSync(targetPath: string): void {
	retryTransientWin32Sync(() => {
		rmSync(targetPath, { recursive: true, force: true });
	});
}
