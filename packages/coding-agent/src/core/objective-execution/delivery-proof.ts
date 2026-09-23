import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withoutInheritedGitLocation } from "../exec.ts";
import type { CommitReceipt, PublishReceipt, PushReceipt, SideEffectReceipt } from "./delivery-bundle.ts";

/**
 * Git delivery subprocesses.
 * Hooks run: commit uses `git commit -- <paths>`, never `--no-verify` and never `commit-tree`.
 * Signing follows the repo. This port does not set `gpg.program` and does not pass `--no-gpg-sign`.
 * Interactive signing or a credential prompt fails the bounded timeout instead of waiting.
 * `GIT_TERMINAL_PROMPT=0` and `GCM_INTERACTIVE=never` keep the subprocess noninteractive.
 * A hook that changes the committed tree fails the delivery and the branch ref is moved back to the
 * approved parent. The worktree is left as the hook left it.
 */

const LOCAL_GIT_TIMEOUT_MS = 30_000;
const NETWORK_GIT_TIMEOUT_MS = 120_000;
const GIT_OUTPUT_MAX_BYTES = 1_048_576;

/** Mechanical observation supplied by the git executor. Generic completion does not open a network connection. */
export interface DeliveryProofQuery {
	readonly candidateDigest: string;
	readonly candidateRevision: string;
	readonly candidateUntrackedPaths: readonly string[];
	readonly approvedTreeOid?: string;
	readonly approvedParent?: string;
	readonly remote?: string;
	readonly ref?: string;
}

export interface DeliveryProofObservation {
	readonly head: string;
	readonly parent: string;
	readonly tree: string;
	readonly remote: string;
	readonly ref: string;
	readonly observedSha: string;
	/** Residue still in the worktree that belongs to the approved candidate. */
	readonly attributableResidue: readonly string[];
}

export interface ApprovedCandidateTree {
	readonly parent: string;
	readonly tree: string;
	readonly digest: string;
}

export interface OwnedCommitRequest {
	readonly message?: string;
	readonly paths: readonly string[];
	readonly approvedParent: string;
	readonly approvedTreeOid: string;
	readonly signal?: AbortSignal;
}

export function candidateTreeDigest(treeOid: string): string {
	return createHash("sha256").update(treeOid).digest("hex");
}

export function proveCommitAndPush(input: {
	readonly commitRequired: boolean;
	readonly pushRequired: boolean;
	readonly reportedCommitSha?: string;
	readonly commitError?: string;
	readonly reportedPushRef?: string;
	readonly reportedPushRemote?: string;
	readonly pushError?: string;
	readonly candidateDigest?: string;
	readonly candidateRevision?: string;
	readonly approvedTreeOid?: string;
	readonly approvedParent?: string;
	readonly observation?: DeliveryProofObservation;
}): {
	readonly commit?: SideEffectReceipt<CommitReceipt>;
	readonly push?: SideEffectReceipt<PushReceipt>;
} {
	let commitError = input.commitError;
	let pushError = input.pushError;
	let provenCommit: CommitReceipt | undefined;
	let provenPush: PushReceipt | undefined;

	const commitNeedsProof = input.commitRequired && commitError === undefined && input.reportedCommitSha !== undefined;
	const pushNeedsProof = input.pushRequired && pushError === undefined && input.reportedPushRef !== undefined;
	if ((commitNeedsProof || pushNeedsProof) && input.observation === undefined) {
		if (commitNeedsProof) commitError = "delivery_proof_unavailable";
		if (pushNeedsProof) pushError = "delivery_proof_unavailable";
	}

	const observation = input.observation;
	if (observation && commitNeedsProof && commitError === undefined) {
		commitError = commitTreeError(input, observation);
		if (commitError === undefined && observation.head !== input.reportedCommitSha) {
			commitError = "commit_sha_not_head";
		} else if (commitError === undefined && observation.attributableResidue.length > 0) {
			commitError = "candidate_residue_remains";
		} else if (commitError === undefined && input.reportedCommitSha !== undefined) {
			provenCommit = { sha: input.reportedCommitSha };
		}
	}

	if (observation && pushNeedsProof && pushError === undefined) {
		const ref = input.reportedPushRef ?? "";
		const expectedSha = input.commitRequired ? (input.reportedCommitSha ?? observation.head) : observation.head;
		const commitRejected = input.commitRequired && provenCommit === undefined;
		const remoteDisagrees = input.reportedPushRemote !== undefined && input.reportedPushRemote !== observation.remote;
		const headDrifted =
			!input.commitRequired &&
			(input.candidateRevision === undefined || observation.head !== input.candidateRevision);
		const dirtyWithoutCommit = !input.commitRequired && observation.attributableResidue.length > 0;
		if (headDrifted && !dirtyWithoutCommit) {
			pushError = "stale_candidate";
		} else if (dirtyWithoutCommit) {
			pushError = "commit_required_for_dirty_candidate";
		} else if (
			!observation.remote ||
			remoteDisagrees ||
			observation.ref !== ref ||
			observation.observedSha !== expectedSha ||
			commitRejected
		) {
			pushError = remoteDisagrees ? "push_remote_mismatch" : "push_sha_mismatch";
		} else {
			provenPush = { remote: observation.remote, ref, observedSha: observation.observedSha };
		}
	}

	return {
		...(input.commitRequired
			? {
					commit: provenCommit
						? { state: "proven" as const, detail: provenCommit }
						: { state: "failed" as const, error: commitError ?? "commit_unproven" },
				}
			: {}),
		...(input.pushRequired
			? {
					push: provenPush
						? { state: "proven" as const, detail: provenPush }
						: { state: "failed" as const, error: pushError ?? "push_unproven" },
				}
			: {}),
	};
}

function commitTreeError(
	input: {
		readonly candidateDigest?: string;
		readonly candidateRevision?: string;
		readonly approvedTreeOid?: string;
		readonly approvedParent?: string;
	},
	observation: DeliveryProofObservation,
): string | undefined {
	if (!input.approvedTreeOid || !input.approvedParent || !input.candidateDigest || !input.candidateRevision) {
		return "candidate_tree_unavailable";
	}
	if (!observation.tree || observation.tree !== input.approvedTreeOid) return "candidate_tree_mismatch";
	if (!observation.parent || observation.parent !== input.approvedParent) return "commit_parent_mismatch";
	if (input.candidateRevision !== input.approvedParent) return "candidate_revision_mismatch";
	if (input.candidateDigest !== candidateTreeDigest(observation.tree)) return "candidate_digest_mismatch";
	return undefined;
}

export interface TagProofObservation {
	readonly tag: string;
	readonly commitSha: string;
}

export interface PublishProofObservation {
	readonly publicationId: string;
	readonly packageName?: string;
	readonly version?: string;
	readonly registry?: string;
	readonly integrity?: string;
	readonly shasum?: string;
}

export interface DeployProofObservation {
	readonly target: string;
	readonly deploymentId: string;
	readonly deployedRevision?: string;
	readonly artifactDigest?: string;
}

export function proveTagReceipt(input: {
	readonly reportedTag?: string;
	readonly tagError?: string;
	readonly expectedTargetSha?: string;
	readonly observation?: TagProofObservation;
}): SideEffectReceipt<{ tag: string; targetSha: string }> {
	if (input.tagError) return { state: "failed", error: input.tagError };
	if (!input.reportedTag) return { state: "failed", error: "Missing tag" };
	if (!input.expectedTargetSha) return { state: "failed", error: "tag_target_unspecified" };
	if (!input.observation) return { state: "failed", error: "tag_proof_unavailable" };
	if (input.observation.tag !== input.reportedTag) return { state: "failed", error: "tag_name_mismatch" };
	if (!input.observation.commitSha || input.observation.commitSha !== input.expectedTargetSha) {
		return { state: "failed", error: "tag_commit_mismatch" };
	}
	return { state: "proven", detail: { tag: input.observation.tag, targetSha: input.observation.commitSha } };
}

export function provePublishReceipt(input: {
	readonly reportedId?: string;
	readonly error?: string;
	readonly expectedIntegrity?: string;
	readonly observation?: PublishProofObservation;
}): SideEffectReceipt<PublishReceipt> {
	if (input.error) return { state: "failed", error: input.error };
	if (!input.reportedId) return { state: "failed", error: "Missing id" };
	if (!input.observation) return { state: "failed", error: "publish_proof_unavailable" };
	if (input.observation.publicationId !== input.reportedId) {
		return { state: "failed", error: "publish_id_mismatch" };
	}
	if (
		(input.expectedIntegrity && input.observation.integrity !== input.expectedIntegrity) ||
		(input.expectedIntegrity && !input.observation.integrity)
	) {
		return { state: "failed", error: "publish_integrity_mismatch" };
	}
	return {
		state: "proven",
		detail: {
			publicationId: input.observation.publicationId,
			...(input.observation.packageName ? { packageName: input.observation.packageName } : {}),
			...(input.observation.version ? { version: input.observation.version } : {}),
			...(input.observation.registry ? { registry: input.observation.registry } : {}),
			...(input.observation.integrity ? { integrity: input.observation.integrity } : {}),
		},
	};
}

export function proveDeployReceipt(input: {
	readonly target: string;
	readonly reportedId?: string;
	readonly error?: string;
	readonly expectedRevision?: string;
	readonly expectedArtifactDigest?: string;
	readonly observation?: DeployProofObservation;
}): SideEffectReceipt<{ target: string; deploymentId?: string }> {
	if (input.error) return { state: "failed", error: input.error, detail: { target: input.target } };
	if (!input.reportedId) return { state: "failed", error: "Missing id", detail: { target: input.target } };
	if (!input.observation)
		return { state: "failed", error: "deploy_proof_unavailable", detail: { target: input.target } };
	if (input.observation.target !== input.target || input.observation.deploymentId !== input.reportedId) {
		return { state: "failed", error: "deploy_id_mismatch", detail: { target: input.target } };
	}
	if (
		input.observation.deployedRevision !== undefined &&
		input.expectedRevision !== undefined &&
		input.observation.deployedRevision !== input.expectedRevision
	) {
		return { state: "failed", error: "deploy_revision_mismatch", detail: { target: input.target } };
	}
	if (
		input.observation.artifactDigest !== undefined &&
		input.expectedArtifactDigest !== undefined &&
		input.observation.artifactDigest !== input.expectedArtifactDigest
	) {
		return { state: "failed", error: "deploy_artifact_mismatch", detail: { target: input.target } };
	}
	return {
		state: "proven",
		detail: { target: input.observation.target, deploymentId: input.observation.deploymentId },
	};
}

interface GitRunOptions {
	readonly signal?: AbortSignal;
	readonly network?: boolean;
	readonly env?: NodeJS.ProcessEnv;
}

function gitOutput(repoRoot: string, args: readonly string[], options?: GitRunOptions): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[...args],
			{
				cwd: repoRoot,
				encoding: "utf8",
				maxBuffer: GIT_OUTPUT_MAX_BYTES,
				timeout: options?.network ? NETWORK_GIT_TIMEOUT_MS : LOCAL_GIT_TIMEOUT_MS,
				signal: options?.signal,
				env: {
					...withoutInheritedGitLocation(),
					GIT_TERMINAL_PROMPT: "0",
					GCM_INTERACTIVE: "never",
					...options?.env,
				},
			},
			(error, stdout, stderr) => {
				if (error) {
					const detail = String(stderr || error.message)
						.trim()
						.slice(0, 500);
					reject(new Error(detail || "git failed"));
					return;
				}
				resolve(String(stdout).replace(/\n$/, ""));
			},
		);
	});
}

function gitText(repoRoot: string, args: readonly string[], options?: GitRunOptions): Promise<string> {
	return gitOutput(repoRoot, args, options).then((text) => text.trim());
}

export function parsePorcelainZ(text: string): string[] {
	const parts = text.split("\0");
	const paths: string[] = [];
	for (let index = 0; index < parts.length; index++) {
		const entry = parts[index] ?? "";
		if (entry.length < 4) continue;
		const status = entry.slice(0, 2);
		const path = entry.slice(3);
		const renamed = status.includes("R") || status.includes("C");
		if (renamed) {
			if (path) paths.push(path);
			const destination = parts[index + 1];
			if (destination) {
				paths.push(destination);
				index++;
			}
		} else if (path) {
			paths.push(path);
		}
	}
	return paths;
}

function attributableResidue(porcelain: string, candidateUntrackedPaths: readonly string[]): string[] {
	const untracked = new Set(candidateUntrackedPaths);
	const residue: string[] = [];
	for (const line of porcelain.split("\n")) {
		if (!line) continue;
		const path = line.slice(3).trim();
		if (!path) continue;
		if (line.startsWith("??")) {
			if (untracked.has(path)) residue.push(path);
		} else {
			residue.push(path);
		}
	}
	return residue;
}

/** The branch's own upstream. No remote name or ref is assumed. */
async function trackedUpstream(repoRoot: string, signal?: AbortSignal): Promise<{ remote: string; ref: string }> {
	const branch = await gitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"], { signal });
	if (branch === "HEAD") throw new Error("Detached HEAD cannot be pushed");
	let remote = "";
	let ref = "";
	try {
		remote = await gitText(repoRoot, ["config", "--get", `branch.${branch}.remote`], { signal });
		ref = await gitText(repoRoot, ["config", "--get", `branch.${branch}.merge`], { signal });
	} catch {
		throw new Error(`Branch ${branch} has no upstream`);
	}
	if (!remote || !ref.startsWith("refs/")) throw new Error(`Branch ${branch} has no upstream`);
	return { remote, ref };
}

async function porcelainPaths(repoRoot: string, signal?: AbortSignal): Promise<string[]> {
	const text = await gitOutput(repoRoot, ["status", "--porcelain=v1", "-z"], { signal });
	return parsePorcelainZ(text);
}

async function treeForPaths(repoRoot: string, paths: readonly string[], signal?: AbortSignal): Promise<string> {
	const directory = mkdtempSync(join(tmpdir(), "pi-delivery-index-"));
	const index = join(directory, "index");
	try {
		const env = { GIT_INDEX_FILE: index };
		await gitText(repoRoot, ["read-tree", "HEAD"], { signal, env });
		if (paths.length > 0) await gitText(repoRoot, ["add", "--", ...paths], { signal, env });
		return await gitText(repoRoot, ["write-tree"], { signal, env });
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

interface AdmissionBaseline {
	/** False when the baseline could not be read. Nothing can be attributed without it. */
	readonly readable: boolean;
	readonly paths: readonly string[];
	readonly head: string;
}

function captureBaseline(repoRoot: string): AdmissionBaseline {
	try {
		const head = execFileText(repoRoot, ["rev-parse", "HEAD"]);
		const porcelain = execFileText(repoRoot, ["status", "--porcelain=v1", "-z"]);
		return { readable: true, paths: parsePorcelainZ(porcelain), head };
	} catch {
		return { readable: false, paths: [], head: "" };
	}
}

function execFileText(repoRoot: string, args: readonly string[]): string {
	return execFileSync("git", args, {
		cwd: repoRoot,
		encoding: "utf8",
		timeout: LOCAL_GIT_TIMEOUT_MS,
		maxBuffer: GIT_OUTPUT_MAX_BYTES,
		// A failure carries git's stderr in the thrown error instead of printing it to the host terminal.
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...withoutInheritedGitLocation(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
	}).replace(/\n$/, "");
}

function peeledTagSha(listed: string, name: string): string {
	const lines = listed
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const peeled = lines.find((line) => line.endsWith(`refs/tags/${name}^{}`));
	const exact = lines.find((line) => line.endsWith(`refs/tags/${name}`));
	return ((peeled ?? exact)?.split(/\s+/u)[0] ?? "").trim();
}

/** Local git commit, push, and proof. Network stays inside this executor, not in completion control flow. */
export function createRepoGitDelivery(repoRoot: string): {
	certifyOwnedCandidate(paths: readonly string[], signal?: AbortSignal): Promise<ApprovedCandidateTree>;
	commit(request: OwnedCommitRequest): Promise<{ sha: string; tree: string; parent: string }>;
	push(target: { remote: string; ref: string }, signal?: AbortSignal): Promise<{ ref: string; remote: string }>;
	tag(name: string, signal?: AbortSignal, targetSha?: string): Promise<{ tag: string; targetSha: string }>;
	pushTag(
		request: { readonly remote: string; readonly name: string; readonly expectedSha: string },
		signal?: AbortSignal,
	): Promise<{ remote: string; tag: string; observedSha: string }>;
	proveDelivery(query: DeliveryProofQuery, signal?: AbortSignal): Promise<DeliveryProofObservation>;
	proveTag(tag: string, signal?: AbortSignal): Promise<TagProofObservation>;
} {
	const baseline = captureBaseline(repoRoot);
	const baselinePaths = new Set(baseline.paths);

	async function certifyOwnedCandidate(
		paths: readonly string[],
		signal?: AbortSignal,
	): Promise<ApprovedCandidateTree> {
		if (paths.length === 0 || !baseline.readable) throw new Error("delivery_unsafe_unowned_changes");
		const current = await porcelainPaths(repoRoot, signal);
		const owned = new Set(paths);
		// The property is per path, not per tree: nothing this objective did not produce may enter the
		// commit. A path that was already dirty when delivery opened was produced by someone else --
		// another session, or the operator -- so it is excluded from the candidate tree and from the
		// pathspec commit, and it is not a reason to refuse. A path that appeared *during* the
		// objective and is not owned is unattributable, and that still stops delivery.
		for (const path of current) {
			if (owned.has(path) || baselinePaths.has(path)) continue;
			throw new Error("delivery_unsafe_unowned_changes");
		}
		for (const path of paths) {
			if (baselinePaths.has(path) || !current.includes(path)) throw new Error("delivery_unsafe_unowned_changes");
		}
		const parent = await gitText(repoRoot, ["rev-parse", "HEAD"], { signal });
		if (parent !== baseline.head && baseline.head) {
			// The approved parent is the admission HEAD. A moved HEAD is not this objective's commit.
			throw new Error("commit_parent_mismatch");
		}
		const tree = await treeForPaths(repoRoot, paths, signal);
		return { parent, tree, digest: candidateTreeDigest(tree) };
	}

	return {
		certifyOwnedCandidate,
		async commit(request) {
			const signal = request.signal;
			if (!request.approvedParent || !request.approvedTreeOid) throw new Error("candidate_tree_unavailable");
			const certified = await certifyOwnedCandidate(request.paths, signal);
			if (certified.parent !== request.approvedParent) throw new Error("commit_parent_mismatch");
			if (certified.tree !== request.approvedTreeOid) throw new Error("candidate_tree_mismatch");
			const message = request.message?.trim() || "Complete objective";
			await gitText(repoRoot, ["commit", "-m", message, "--", ...request.paths], { signal });
			const sha = await gitText(repoRoot, ["rev-parse", "HEAD"], { signal });
			const tree = await gitText(repoRoot, ["rev-parse", `${sha}^{tree}`], { signal });
			const parent = await gitText(repoRoot, ["rev-parse", `${sha}^`], { signal });
			if (tree !== request.approvedTreeOid || parent !== request.approvedParent) {
				await gitText(repoRoot, ["update-ref", "HEAD", request.approvedParent], { signal });
				throw new Error("candidate_tree_mismatch");
			}
			return { sha, tree, parent };
		},
		async push(target, signal) {
			if (!target?.remote || !target.ref?.startsWith("refs/")) throw new Error("push_upstream_unavailable");
			const live = await trackedUpstream(repoRoot, signal);
			if (live.remote !== target.remote || live.ref !== target.ref) throw new Error("push_upstream_drift");
			await gitText(repoRoot, ["push", target.remote, `HEAD:${target.ref}`], { signal, network: true });
			return { remote: target.remote, ref: target.ref };
		},
		async tag(name, signal, targetSha) {
			if (!name?.trim()) throw new Error("tag_name_required");
			if (targetSha) {
				const head = await gitText(repoRoot, ["rev-parse", "HEAD"], { signal });
				const porcelain = await gitOutput(repoRoot, ["status", "--porcelain"], { signal });
				if (porcelain.trim()) throw new Error("commit_required_for_dirty_candidate");
				if (head !== targetSha) throw new Error("stale_candidate");
			}
			// -m supplies the message git asks for when this repo signs or annotates tags.
			const args = targetSha ? ["tag", "-m", name, name, targetSha] : ["tag", "-m", name, name];
			await gitText(repoRoot, args, { signal });
			const commitSha = await gitText(repoRoot, ["rev-parse", `${name}^{}`], { signal });
			if (targetSha && commitSha !== targetSha) throw new Error("tag_commit_mismatch");
			return { tag: name, targetSha: commitSha };
		},
		async pushTag(request, signal) {
			const name = request.name.trim();
			if (!name) throw new Error("tag_name_required");
			if (!request.remote) throw new Error("tag_push_upstream_unavailable");
			const ref = `refs/tags/${name}`;
			await gitText(repoRoot, ["push", request.remote, `${ref}:${ref}`], { signal, network: true });
			const listed = await gitText(repoRoot, ["ls-remote", request.remote, ref], { signal, network: true });
			const observedSha = peeledTagSha(listed, name);
			if (!observedSha || observedSha !== request.expectedSha) throw new Error("tag_push_sha_mismatch");
			return { remote: request.remote, tag: name, observedSha };
		},
		async proveDelivery(query, signal) {
			const head = await gitText(repoRoot, ["rev-parse", "HEAD"], { signal });
			const tree = await gitText(repoRoot, ["rev-parse", `${head}^{tree}`], { signal });
			let parent = "";
			try {
				parent = await gitText(repoRoot, ["rev-parse", `${head}^`], { signal });
			} catch {
				parent = "";
			}
			const tracked =
				query.remote && query.ref
					? { remote: query.remote, ref: query.ref }
					: await trackedUpstream(repoRoot, signal);
			const remote = tracked.remote;
			const ref = tracked.ref;
			const listed = await gitText(repoRoot, ["ls-remote", remote, ref], { signal, network: true });
			const observedSha = listed.split(/\s+/)[0] ?? "";
			if (!observedSha) {
				throw new Error(`Remote ${remote} has no observed SHA for ${ref}`);
			}
			const porcelain = await gitOutput(repoRoot, ["status", "--porcelain"], { signal });
			return {
				head,
				parent,
				tree,
				remote,
				ref,
				observedSha,
				attributableResidue: attributableResidue(porcelain, query.candidateUntrackedPaths),
			};
		},
		async proveTag(tag, signal) {
			return { tag, commitSha: await gitText(repoRoot, ["rev-parse", `${tag}^{}`], { signal }) };
		},
	};
}
