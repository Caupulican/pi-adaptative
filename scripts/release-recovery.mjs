/** A green CI verdict authorizes only its exact main revision, never a later HEAD. */
export function assertReleaseSourceIdentity(expectedSha, current) {
	if (typeof expectedSha !== "string" || !/^[a-f0-9]{40}$/.test(expectedSha) ||
		current?.sha !== expectedSha || current.branch !== "main") {
		throw new Error(`Release source changed after CI validation: expected main at ${expectedSha ?? "missing"}, found ${current?.branch ?? "missing"} at ${current?.sha ?? "missing"}. No mutation admitted.`);
	}
}

/** Execute one synchronous, revision-fenced mutation phase without compensating over a shared worktree. */
export function executeReleaseMutation(checkpoint, readSource, mutate) {
	try {
		assertReleaseSourceIdentity(checkpoint.sha, readSource());
		return mutate();
	} catch (error) {
		try {
			console.error(`Release ${checkpoint.phase} failed after preflight ${checkpoint.sha}.`);
			console.error("Files, index and commits are retained; no rollback was attempted.");
			console.error(`Inspect git status and git log ${checkpoint.sha}..HEAD, then check origin/main and the version tag.`);
			console.error("A failed push has an unknown remote outcome. Do not repeat the version bump.");
			console.error("If no candidate was pushed, repair and commit consistent version/lock/changelog metadata before considering release:adopt and its preconditions.");
			console.error("If a canonical candidate is on origin/main, finish any missing next-cycle markers and use release:promote or release:repair as appropriate.");
			console.error("If the version tag exists, inspect its exact candidate and publishing workflow; tag promotion does not prove artifact publication.");
		} catch {
			// Diagnostic failures must not replace the failed mutation's actual error.
		}
		throw error;
	}
}
