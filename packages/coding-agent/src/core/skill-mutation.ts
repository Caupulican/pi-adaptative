import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMissingFileError, withFileLockSync } from "./util/atomic-file.ts";

/** Serialize definition writes by physical resource root, including discovery through symlink aliases. */
export function withSkillDefinitionLock<T>(
	filePath: string,
	heldDirectory: string | undefined,
	operation: (canonicalFile: string) => T,
): T {
	let canonicalFile: string;
	try {
		canonicalFile = realpathSync(filePath);
	} catch (error) {
		if (!isMissingFileError(error)) throw error;
		canonicalFile = join(realpathSync(dirname(filePath)), basename(filePath));
	}
	const directory = dirname(canonicalFile);
	const root = basename(canonicalFile).toLowerCase() === "skill.md" ? dirname(directory) : directory;
	if (heldDirectory !== undefined && realpathSync(heldDirectory) === root) return operation(canonicalFile);
	// A caller may already own a catalog root. Never wait for a second root and create a lock cycle.
	return withFileLockSync(root, () => operation(canonicalFile), { retries: 0, realpath: true });
}
