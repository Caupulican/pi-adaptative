import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WINDOWS_FILE_SYMLINK_PRIVILEGE_ERRORS = new Set(["EACCES", "EPERM"]);

/**
 * Create a directory link without requiring Windows developer mode or an elevated process.
 * Junctions and POSIX directory symlinks both exercise realpath-based directory aliasing.
 */
export function createDirectoryLink(target: string, linkPath: string): void {
	symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function probeFileSymlinkSupport(): boolean {
	if (process.platform !== "win32") return true;

	const probeDir = mkdtempSync(join(tmpdir(), "pi-file-symlink-probe-"));
	try {
		const targetPath = join(probeDir, "target.txt");
		writeFileSync(targetPath, "probe", "utf-8");
		try {
			symlinkSync(targetPath, join(probeDir, "link.txt"), "file");
			return true;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code && WINDOWS_FILE_SYMLINK_PRIVILEGE_ERRORS.has(code)) return false;
			throw error;
		}
	} finally {
		rmSync(probeDir, { recursive: true, force: true });
	}
}

/** Native file symlinks are not equivalent to hardlinks, so unsupported Windows hosts skip explicitly. */
export const FILE_SYMLINK_TESTS_SUPPORTED = probeFileSymlinkSupport();
