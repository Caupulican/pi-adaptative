import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isMissingFileError, withFileLockSync } from "./util/atomic-file.ts";

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
	return withFileLockSync(root, () => operation(canonicalFile), { retries: 0, realpath: true });
}
