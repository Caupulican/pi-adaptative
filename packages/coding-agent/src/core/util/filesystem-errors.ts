/** Classify filesystem errors for missing-path handling and speculative metadata lookups. */
function pathErrorCode(error: unknown): unknown {
	return typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
}

/** A missing leaf or non-directory ancestor permits an alternate path lookup. */
export function isMissingPathError(error: unknown): boolean {
	const code = pathErrorCode(error);
	return code === "ENOENT" || code === "ENOTDIR";
}

/** A speculative argument or config path cannot name a file when the OS rejects its length. */
export function isPathProbeMiss(error: unknown): boolean {
	return isMissingPathError(error) || pathErrorCode(error) === "ENAMETOOLONG";
}
