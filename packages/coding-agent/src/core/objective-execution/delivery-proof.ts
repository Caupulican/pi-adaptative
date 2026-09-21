import { execFile } from "node:child_process";
import type { CommitReceipt, PublishReceipt, PushReceipt, SideEffectReceipt } from "./delivery-bundle.ts";

/** Mechanical observation supplied by the git executor. Generic completion does not open a network connection. */
export interface DeliveryProofQuery {
	readonly candidateDigest: string;
	readonly candidateRevision: string;
	readonly candidateUntrackedPaths: readonly string[];
	readonly remote?: string;
	readonly ref?: string;
}

export interface DeliveryProofObservation {
	readonly head: string;
	readonly remote: string;
	readonly ref: string;
	readonly observedSha: string;
	/** Residue still in the worktree that belongs to the approved candidate. */
	readonly attributableResidue: readonly string[];
}

export function proveCommitAndPush(input: {
	readonly commitRequired: boolean;
	readonly pushRequired: boolean;
	readonly reportedCommitSha?: string;
	readonly commitError?: string;
	readonly reportedPushRef?: string;
	readonly reportedPushRemote?: string;
	readonly pushError?: string;
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
		if (observation.head !== input.reportedCommitSha) {
			commitError = "commit_sha_not_head";
		} else if (observation.attributableResidue.length > 0) {
			commitError = "candidate_residue_remains";
		} else if (input.reportedCommitSha !== undefined) {
			provenCommit = { sha: input.reportedCommitSha };
		}
	}

	if (observation && pushNeedsProof && pushError === undefined) {
		const ref = input.reportedPushRef ?? "";
		const expectedSha = input.reportedCommitSha ?? observation.head;
		const commitRejected = input.commitRequired && provenCommit === undefined;
		const remoteDisagrees = input.reportedPushRemote !== undefined && input.reportedPushRemote !== observation.remote;
		if (
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

export interface TagProofObservation {
	readonly tag: string;
	readonly commitSha: string;
}

export interface PublishProofObservation {
	readonly publicationId: string;
}

export interface DeployProofObservation {
	readonly target: string;
	readonly deploymentId: string;
}

export function proveTagReceipt(input: {
	readonly reportedTag?: string;
	readonly tagError?: string;
	readonly commitSha?: string;
	readonly observation?: TagProofObservation;
}): SideEffectReceipt<{ tag: string }> {
	if (input.tagError) return { state: "failed", error: input.tagError };
	if (!input.reportedTag) return { state: "failed", error: "Missing tag" };
	if (!input.observation) return { state: "failed", error: "tag_proof_unavailable" };
	if (input.observation.tag !== input.reportedTag) return { state: "failed", error: "tag_name_mismatch" };
	if (
		!input.observation.commitSha ||
		(input.commitSha !== undefined && input.observation.commitSha !== input.commitSha)
	) {
		return { state: "failed", error: "tag_commit_mismatch" };
	}
	return { state: "proven", detail: { tag: input.observation.tag } };
}

export function provePublishReceipt(input: {
	readonly reportedId?: string;
	readonly error?: string;
	readonly observation?: PublishProofObservation;
}): SideEffectReceipt<PublishReceipt> {
	if (input.error) return { state: "failed", error: input.error };
	if (!input.reportedId) return { state: "failed", error: "Missing id" };
	if (!input.observation) return { state: "failed", error: "publish_proof_unavailable" };
	if (input.observation.publicationId !== input.reportedId) {
		return { state: "failed", error: "publish_id_mismatch" };
	}
	return { state: "proven", detail: { publicationId: input.observation.publicationId } };
}

export function proveDeployReceipt(input: {
	readonly target: string;
	readonly reportedId?: string;
	readonly error?: string;
	readonly observation?: DeployProofObservation;
}): SideEffectReceipt<{ target: string; deploymentId?: string }> {
	if (input.error) return { state: "failed", error: input.error, detail: { target: input.target } };
	if (!input.reportedId) return { state: "failed", error: "Missing id", detail: { target: input.target } };
	if (!input.observation)
		return { state: "failed", error: "deploy_proof_unavailable", detail: { target: input.target } };
	if (input.observation.target !== input.target || input.observation.deploymentId !== input.reportedId) {
		return { state: "failed", error: "deploy_id_mismatch", detail: { target: input.target } };
	}
	return {
		state: "proven",
		detail: { target: input.observation.target, deploymentId: input.observation.deploymentId },
	};
}

function gitOutput(repoRoot: string, args: readonly string[]): Promise<string> {
	return new Promise((resolve, reject) => {
		execFile(
			"git",
			[...args],
			{
				cwd: repoRoot,
				encoding: "utf8",
				maxBuffer: 8 * 1024 * 1024,
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
			},
			(error, stdout) => {
				if (error) {
					reject(error);
					return;
				}
				resolve(String(stdout).replace(/\n$/, ""));
			},
		);
	});
}

function gitText(repoRoot: string, args: readonly string[]): Promise<string> {
	return gitOutput(repoRoot, args).then((text) => text.trim());
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
async function trackedUpstream(repoRoot: string): Promise<{ remote: string; ref: string }> {
	const branch = await gitText(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]);
	if (branch === "HEAD") throw new Error("Detached HEAD cannot be pushed");
	let remote = "";
	let ref = "";
	try {
		remote = await gitText(repoRoot, ["config", "--get", `branch.${branch}.remote`]);
		ref = await gitText(repoRoot, ["config", "--get", `branch.${branch}.merge`]);
	} catch {
		throw new Error(`Branch ${branch} has no upstream`);
	}
	if (!remote || !ref.startsWith("refs/")) throw new Error(`Branch ${branch} has no upstream`);
	return { remote, ref };
}

/** Local git commit, push, and proof. Network stays inside this executor, not in completion control flow. */
export function createRepoGitDelivery(repoRoot: string): {
	commit(message?: string): Promise<{ sha: string }>;
	push(): Promise<{ ref: string; remote: string }>;
	tag(name?: string): Promise<{ tag: string }>;
	proveDelivery(query: DeliveryProofQuery): Promise<DeliveryProofObservation>;
	proveTag(tag: string): Promise<TagProofObservation>;
} {
	return {
		async commit(message = "Complete objective") {
			const status = await gitText(repoRoot, ["status", "--porcelain"]);
			if (status) {
				await gitText(repoRoot, ["add", "-A"]);
				await gitText(repoRoot, ["commit", "-m", message]);
			}
			return { sha: await gitText(repoRoot, ["rev-parse", "HEAD"]) };
		},
		async push() {
			const tracked = await trackedUpstream(repoRoot);
			await gitText(repoRoot, ["push", tracked.remote, `HEAD:${tracked.ref}`]);
			return tracked;
		},
		async tag(name = "objective") {
			// -m supplies the message git asks for when this repo signs or annotates tags.
			await gitText(repoRoot, ["tag", "-m", name, name]);
			return { tag: name };
		},
		async proveDelivery(query) {
			const head = await gitText(repoRoot, ["rev-parse", "HEAD"]);
			const tracked =
				query.remote && query.ref ? { remote: query.remote, ref: query.ref } : await trackedUpstream(repoRoot);
			const remote = tracked.remote;
			const ref = tracked.ref;
			const listed = await gitText(repoRoot, ["ls-remote", remote, ref]);
			const observedSha = listed.split(/\s+/)[0] ?? "";
			if (!observedSha) {
				throw new Error(`Remote ${remote} has no observed SHA for ${ref}`);
			}
			const porcelain = await gitOutput(repoRoot, ["status", "--porcelain"]);
			return {
				head,
				remote,
				ref,
				observedSha,
				attributableResidue: attributableResidue(porcelain, query.candidateUntrackedPaths),
			};
		},
		async proveTag(tag) {
			return { tag, commitSha: await gitText(repoRoot, ["rev-parse", `${tag}^{}`]) };
		},
	};
}
