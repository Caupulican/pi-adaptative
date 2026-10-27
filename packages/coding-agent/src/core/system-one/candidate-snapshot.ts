/**
 * One worktree-rooted candidate identity shared by CompletionProof, JEV-024..027, and DeliveryBundle.
 * Never uses process.cwd() as the repo identity.
 */
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { waitForChildProcessWithTermination } from "../../utils/child-process.ts";

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

const GIT_BYTES_LIMIT = 32 * 1024 * 1024;
const GIT_TEXT_LIMIT = 8 * 1024 * 1024;
const GIT_ASYNC_TIMEOUT_MS = 30_000;

function gitBytes(repoRoot: string, args: readonly string[]): Buffer {
	return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], maxBuffer: GIT_BYTES_LIMIT });
}

function gitText(repoRoot: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		maxBuffer: GIT_TEXT_LIMIT,
	}).trim();
}

async function gitBytesAsync(repoRoot: string, args: readonly string[]): Promise<Buffer> {
	const child = spawn("git", [...args], { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let stdoutBytes = 0;
	child.stdout?.on("data", (chunk: Buffer) => {
		stdoutBytes += chunk.length;
		if (stdoutBytes <= GIT_BYTES_LIMIT) stdout.push(chunk);
	});
	child.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk));
	const terminal = await waitForChildProcessWithTermination(child, {
		timeoutMs: GIT_ASYNC_TIMEOUT_MS,
		killGraceMs: 1_000,
	});
	if (terminal.reason === "timeout") throw new Error(`git ${args[0] ?? ""} exceeded ${GIT_ASYNC_TIMEOUT_MS}ms`);
	if (stdoutBytes > GIT_BYTES_LIMIT) throw new Error(`git ${args[0] ?? ""} output exceeded ${GIT_BYTES_LIMIT} bytes`);
	if (terminal.code !== 0) {
		throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `git ${args[0] ?? ""} exited ${terminal.code}`);
	}
	return Buffer.concat(stdout);
}

async function gitTextAsync(repoRoot: string, args: readonly string[]): Promise<string> {
	return (await gitBytesAsync(repoRoot, args)).toString("utf8").trim();
}

function requireRepoRoot(repoRoot: string): void {
	if (!repoRoot) throw new Error("Candidate snapshot requires an explicit repo root");
}

/** The identity of a worktree: its revisions, tracked diff and untracked bytes, hashed in a fixed order. */
function buildCandidateSnapshot(parts: {
	repoRoot: string;
	baseRevision: string;
	candidateRevision: string;
	trackedDiffBytes: Buffer;
	untracked: readonly UntrackedFileBytes[];
}): CandidateSnapshot {
	const hash = createHash("sha256");
	hash.update(parts.repoRoot);
	hash.update("\0");
	hash.update(parts.baseRevision);
	hash.update("\0");
	hash.update(parts.candidateRevision);
	hash.update("\0");
	hash.update(parts.trackedDiffBytes);
	hash.update("\0");
	for (const file of parts.untracked) {
		hash.update(file.path);
		hash.update("\0");
		hash.update(file.bytes);
		hash.update("\0");
	}
	return { ...parts, digest: hash.digest("hex") };
}

function untrackedNamesOf(listing: string): string[] {
	return listing.split("\0").filter(Boolean);
}

export function captureCandidateSnapshot(repoRoot: string): CandidateSnapshot {
	requireRepoRoot(repoRoot);
	const candidateRevision = gitText(repoRoot, ["rev-parse", "HEAD"]);
	let baseRevision = candidateRevision;
	try {
		baseRevision = gitText(repoRoot, ["rev-parse", "HEAD^"]);
	} catch {
		// First commit: base equals candidate.
	}
	const trackedDiffBytes = gitBytes(repoRoot, ["diff", "HEAD"]);
	const untracked = untrackedNamesOf(gitText(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"])).map(
		(path) => ({ path, bytes: readFileSync(join(repoRoot, path)) }),
	);
	return buildCandidateSnapshot({ repoRoot, baseRevision, candidateRevision, trackedDiffBytes, untracked });
}

/**
 * The same snapshot without blocking the event loop: the git processes and the untracked-file reads are asynchronous.
 * The tool-call path uses this one; a synchronous capture on a render thread froze the terminal.
 */
export async function captureCandidateSnapshotAsync(repoRoot: string): Promise<CandidateSnapshot> {
	requireRepoRoot(repoRoot);
	const candidateRevision = await gitTextAsync(repoRoot, ["rev-parse", "HEAD"]);
	const [baseRevision, trackedDiffBytes, listing] = await Promise.all([
		gitTextAsync(repoRoot, ["rev-parse", "HEAD^"]).catch(() => candidateRevision),
		gitBytesAsync(repoRoot, ["diff", "HEAD"]),
		gitTextAsync(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]),
	]);
	const untracked = await Promise.all(
		untrackedNamesOf(listing).map(async (path) => ({ path, bytes: await readFile(join(repoRoot, path)) })),
	);
	return buildCandidateSnapshot({ repoRoot, baseRevision, candidateRevision, trackedDiffBytes, untracked });
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
