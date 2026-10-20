/** A green CI verdict authorizes only its exact main revision, never a later HEAD. */
export function assertReleaseSourceIdentity(expectedSha, current) {
	if (typeof expectedSha !== "string" || !/^[a-f0-9]{40}$/.test(expectedSha) ||
		current?.sha !== expectedSha || current.branch !== "main") {
		throw new Error(`Release source changed after CI validation: expected main at ${expectedSha ?? "missing"}, found ${current?.branch ?? "missing"} at ${current?.sha ?? "missing"}. No mutation admitted.`);
	}
}

/**
 * `origin/main` moved after the release read it, so the push that would have published the release commits
 * was refused and nothing remote changed. The release is a pure function of the tree it started from; the
 * caller discards the unpushed local commits and starts again from the new tip.
 */
export class ReleaseRaceError extends Error {
	constructor(message) {
		super(message);
		this.name = "ReleaseRaceError";
		this.retryable = true;
	}
}

/** Execute one synchronous, revision-fenced mutation phase without compensating over a shared worktree. */
export function executeReleaseMutation(checkpoint, readSource, mutate) {
	try {
		assertReleaseSourceIdentity(checkpoint.sha, readSource());
		return mutate();
	} catch (error) {
		if (error instanceof ReleaseRaceError) throw error;
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
