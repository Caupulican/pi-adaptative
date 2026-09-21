/**
 * One worktree-rooted candidate identity shared by CompletionProof, JEV-024..027, and DeliveryBundle.
 * Never uses process.cwd() as the repo identity.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface UntrackedFileBytes {
	readonly path: string;
	readonly bytes: Buffer;
}

export interface CandidateSnapshot {
	readonly repoRoot: string;
	readonly baseRevision: string;
	readonly candidateRevision: string;
	readonly trackedDiffBytes: Buffer;
	readonly untracked: readonly UntrackedFileBytes[];
	readonly digest: string;
}

function gitBytes(repoRoot: string, args: readonly string[]): Buffer {
	return execFileSync("git", args, {
		cwd: repoRoot,
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 32 * 1024 * 1024,
	});
}

function gitText(repoRoot: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: 8 * 1024 * 1024,
	}).trim();
}

export function captureCandidateSnapshot(repoRoot: string): CandidateSnapshot {
	if (!repoRoot) {
		throw new Error("Candidate snapshot requires an explicit repo root");
	}
	const candidateRevision = gitText(repoRoot, ["rev-parse", "HEAD"]);
	let baseRevision = candidateRevision;
	try {
		baseRevision = gitText(repoRoot, ["rev-parse", "HEAD^"]);
	} catch {
		// First commit: base equals candidate.
	}
	const trackedDiffBytes = gitBytes(repoRoot, ["diff", "HEAD"]);
	const untrackedNames = gitText(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"])
		.split("\0")
		.filter(Boolean);
	const untracked = untrackedNames.map((path) => ({
		path,
		bytes: readFileSync(join(repoRoot, path)),
	}));
	const hash = createHash("sha256");
	hash.update(repoRoot);
	hash.update("\0");
	hash.update(baseRevision);
	hash.update("\0");
	hash.update(candidateRevision);
	hash.update("\0");
	hash.update(trackedDiffBytes);
	hash.update("\0");
	for (const file of untracked) {
		hash.update(file.path);
		hash.update("\0");
		hash.update(file.bytes);
		hash.update("\0");
	}
	return {
		repoRoot,
		baseRevision,
		candidateRevision,
		trackedDiffBytes,
		untracked,
		digest: hash.digest("hex"),
	};
}

export function candidateSnapshotIdentity(snapshot: CandidateSnapshot): {
	readonly repoRoot: string;
	readonly baseRevision: string;
	readonly candidateRevision: string;
	readonly digest: string;
	readonly untrackedPaths: readonly string[];
} {
	return {
		repoRoot: snapshot.repoRoot,
		baseRevision: snapshot.baseRevision,
		candidateRevision: snapshot.candidateRevision,
		digest: snapshot.digest,
		untrackedPaths: snapshot.untracked.map((file) => file.path),
	};
}
