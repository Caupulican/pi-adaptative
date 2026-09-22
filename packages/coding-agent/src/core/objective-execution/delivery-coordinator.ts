import type { ExecutionCharter } from "../autonomy/execution-charter.ts";
import type { DeliverySideEffects } from "./delivery-bundle.ts";
import { unresolvedError } from "./delivery-intent.ts";
import {
	type ApprovedCandidateTree,
	candidateTreeDigest,
	type DeliveryProofObservation,
	type DeliveryProofQuery,
	type DeployProofObservation,
	type OwnedCommitRequest,
	type PublishProofObservation,
	proveCommitAndPush,
	proveDeployReceipt,
	provePublishReceipt,
	proveTagReceipt,
	type TagProofObservation,
} from "./delivery-proof.ts";

export interface DeliveryGitExecutor {
	commit?(request?: OwnedCommitRequest): Promise<{ sha: string; tree?: string; parent?: string } | undefined>;
	push?(
		target?: { readonly remote: string; readonly ref: string },
		signal?: AbortSignal,
	): Promise<{ ref: string; remote?: string } | undefined>;
	tag?(
		name?: string,
		signal?: AbortSignal,
		targetSha?: string,
	): Promise<{ tag: string; targetSha?: string } | undefined>;
	pushTag?(
		request: { readonly remote: string; readonly name: string; readonly expectedSha: string },
		signal?: AbortSignal,
	): Promise<{ remote: string; tag: string; observedSha: string } | undefined>;
	proveDelivery?(query: DeliveryProofQuery, signal?: AbortSignal): Promise<DeliveryProofObservation>;
	proveTag?(tag: string, signal?: AbortSignal): Promise<TagProofObservation>;
	inspectCandidate?(): Promise<ApprovedCandidateTree>;
	certifyOwnedCandidate?(paths: readonly string[], signal?: AbortSignal): Promise<ApprovedCandidateTree>;
}

export interface PreparedPackageArtifact {
	readonly id: string;
	readonly packageName: string;
	readonly version: string;
	readonly registry?: string;
	readonly integrity: string;
	readonly shasum: string;
}

export interface DeliveryReleaseExecutor {
	preparePublish?(): Promise<PreparedPackageArtifact>;
	publish?(): Promise<
		{ id: string; integrity?: string; packageName?: string; version?: string; registry?: string } | undefined
	>;
	deploy?(target: string): Promise<{ id: string } | undefined>;
	provePublish?(publicationId: string): Promise<PublishProofObservation>;
	proveDeploy?(target: string): Promise<DeployProofObservation>;
}

export interface DeliveryExecutionInput {
	readonly charter?: ExecutionCharter;
	readonly git?: DeliveryGitExecutor;
	readonly release?: DeliveryReleaseExecutor;
	readonly signal?: AbortSignal;
	readonly candidateUntrackedPaths: readonly string[];
	readonly attributedPaths: readonly string[];
	/** Semantic candidate HEAD. Push-only compares the live HEAD to this revision. */
	readonly candidateRevision?: string;
	readonly approvedTreeOid?: string;
	readonly approvedParent?: string;
	/** False when the frozen candidate still has worktree edits and no commit will absorb them. */
	readonly worktreeClean?: boolean;
	readonly expectedDeployRevision?: string;
	readonly expectedArtifactDigest?: string;
}

function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Exact side effects for one frozen DeliveryIntent.
 * Completion does not run these. Finalization does not run these.
 */
export async function executeDelivery(input: DeliveryExecutionInput): Promise<DeliverySideEffects> {
	const charter = input.charter;
	if (!charter) return {};
	const intent = charter.delivery;
	const gitBlocked = intent.baselineDirty && (charter.git.commit || charter.git.push);
	const sideEffects: {
		commit?: DeliverySideEffects["commit"];
		tag?: DeliverySideEffects["tag"];
		push?: DeliverySideEffects["push"];
		publish?: DeliverySideEffects["publish"];
		deploy?: DeliverySideEffects["deploy"];
		github_release?: DeliverySideEffects["github_release"];
	} = {};

	let approved: ApprovedCandidateTree | undefined;
	let reportedCommitSha: string | undefined;
	let commitError: string | undefined;
	let reportedPushRef: string | undefined;
	let reportedPushRemote: string | undefined;
	let pushError: string | undefined;
	let reportedTag: string | undefined;
	let tagError: string | undefined;
	let reportedPublicationId: string | undefined;
	let reportedIntegrity: string | undefined;
	let publishError: string | undefined;
	const reportedDeploys: { target: string; id?: string; error?: string }[] = [];
	let tagTargetSha: string | undefined;

	if (charter.git.commit) {
		if (gitBlocked) commitError = "delivery_unsafe_unowned_changes";
		else if (!input.git?.commit) commitError = "Git commit unavailable";
		else {
			try {
				if (input.approvedParent && input.approvedTreeOid) {
					approved = {
						parent: input.approvedParent,
						tree: input.approvedTreeOid,
						digest: candidateTreeDigest(input.approvedTreeOid),
					};
				} else if (input.git.inspectCandidate) approved = await input.git.inspectCandidate();
				else if (input.git.certifyOwnedCandidate) {
					approved = await input.git.certifyOwnedCandidate(input.attributedPaths, input.signal);
				} else commitError = "candidate_tree_unavailable";
				if (commitError === undefined && approved) {
					const request: OwnedCommitRequest | undefined = input.git.certifyOwnedCandidate
						? {
								paths: input.attributedPaths,
								approvedParent: approved.parent,
								approvedTreeOid: approved.tree,
								message: intent.git.commit ? intent.git.commit.message : undefined,
								signal: input.signal,
							}
						: undefined;
					const commitRes = await input.git.commit(request);
					if (commitRes && typeof commitRes === "object" && "sha" in commitRes && commitRes.sha) {
						reportedCommitSha = String(commitRes.sha);
					} else commitError = "Missing sha";
				}
			} catch (error) {
				commitError = messageOf(error);
			}
		}
	}

	if (charter.git.create_tag) {
		const blocked = unresolvedError(intent, "tag_push") ?? unresolvedError(intent, "tag");
		if (blocked) tagError = blocked;
		else if (!intent.git.tag) tagError = "tag_name_required";
		else if (!input.git?.tag) tagError = "Git tag unavailable";
		else if (charter.git.commit && (commitError !== undefined || !reportedCommitSha)) {
			tagError = commitError ?? "commit_required_for_dirty_candidate";
		} else if (!charter.git.commit && input.worktreeClean === false) {
			tagError = "commit_required_for_dirty_candidate";
		} else if (!charter.git.commit && !input.candidateRevision) {
			tagError = "tag_target_unspecified";
		} else {
			tagTargetSha = charter.git.commit ? reportedCommitSha : input.candidateRevision;
			if (!tagTargetSha) tagError = "tag_target_unspecified";
			else {
				try {
					const tagRes = await input.git.tag(intent.git.tag.name, input.signal, tagTargetSha);
					if (tagRes && typeof tagRes === "object" && "tag" in tagRes && tagRes.tag)
						reportedTag = String(tagRes.tag);
					else tagError = "Missing tag";
					if (tagError === undefined && intent.git.tag.push) {
						if (!intent.git.tag.remote) tagError = "tag_push_upstream_unavailable";
						else if (!input.git.pushTag) tagError = "tag_push_unavailable";
						else {
							const pushed = await input.git.pushTag(
								{ remote: intent.git.tag.remote, name: intent.git.tag.name, expectedSha: tagTargetSha },
								input.signal,
							);
							if (!pushed || pushed.observedSha !== tagTargetSha || pushed.remote !== intent.git.tag.remote) {
								tagError = "tag_push_sha_mismatch";
							}
						}
					}
				} catch (error) {
					tagError = messageOf(error);
				}
			}
		}
	}

	if (charter.git.push) {
		const frozen = intent.git.push;
		if (gitBlocked) pushError = "delivery_unsafe_unowned_changes";
		else if (!frozen) pushError = unresolvedError(intent, "push") ?? "push_upstream_unavailable";
		else if (!input.git?.push) pushError = "Git push unavailable";
		else {
			try {
				const pushRes = await input.git.push(frozen, input.signal);
				if (pushRes && typeof pushRes === "object" && "ref" in pushRes && pushRes.ref) {
					reportedPushRef = String(pushRes.ref);
					reportedPushRemote = "remote" in pushRes && pushRes.remote ? String(pushRes.remote) : frozen.remote;
					if (reportedPushRemote !== frozen.remote || reportedPushRef !== frozen.ref) {
						pushError = "push_upstream_drift";
					}
				} else pushError = "Missing ref";
			} catch (error) {
				pushError = messageOf(error);
			}
		}
	}

	if (charter.release.package_publish) {
		const blocked = unresolvedError(intent, "package_publish");
		if (blocked) publishError = blocked;
		else if (!input.release?.publish) publishError = "Package publish unavailable";
		else {
			try {
				const pubRes = await input.release.publish();
				if (pubRes && typeof pubRes === "object" && "id" in pubRes && pubRes.id) {
					reportedPublicationId = String(pubRes.id);
					if ("integrity" in pubRes && typeof pubRes.integrity === "string") reportedIntegrity = pubRes.integrity;
				} else publishError = "Missing id";
			} catch (error) {
				publishError = messageOf(error);
			}
		}
	}

	if (charter.release.deploy_targets.length > 0) {
		if (!input.release?.deploy) {
			for (const target of charter.release.deploy_targets)
				reportedDeploys.push({ target, error: "deploy_adapter_unavailable" });
		} else {
			for (const target of charter.release.deploy_targets) {
				try {
					const depRes = await input.release.deploy(target);
					if (depRes && typeof depRes === "object" && "id" in depRes && depRes.id) {
						reportedDeploys.push({ target, id: String(depRes.id) });
					} else reportedDeploys.push({ target, error: "Missing id" });
				} catch (error) {
					reportedDeploys.push({ target, error: messageOf(error) });
				}
			}
		}
	}

	if (charter.release.github_release) {
		sideEffects.github_release = {
			state: "failed",
			error: "github_release_unsupported",
			...(intent.githubRelease ? { detail: intent.githubRelease } : {}),
		};
	}

	const commitRequired = charter.git.commit;
	const pushRequired = charter.git.push;
	const needsDeliveryProof =
		(commitRequired && commitError === undefined && reportedCommitSha !== undefined) ||
		(pushRequired && pushError === undefined && reportedPushRef !== undefined);
	let observation: DeliveryProofObservation | undefined;
	if (needsDeliveryProof && input.git?.proveDelivery) {
		try {
			observation = await input.git.proveDelivery(
				{
					candidateDigest: approved ? candidateTreeDigest(approved.tree) : "",
					candidateRevision: approved?.parent ?? "",
					candidateUntrackedPaths: input.candidateUntrackedPaths,
					approvedTreeOid: approved?.tree,
					approvedParent: approved?.parent,
					remote: intent.git.push ? intent.git.push.remote : reportedPushRemote,
					ref: intent.git.push ? intent.git.push.ref : reportedPushRef,
				},
				input.signal,
			);
		} catch (error) {
			const message = messageOf(error);
			if (commitRequired && commitError === undefined) commitError = message;
			if (pushRequired && pushError === undefined) pushError = message;
		}
	}
	const provenReceipts = proveCommitAndPush({
		commitRequired,
		pushRequired,
		reportedCommitSha,
		commitError,
		reportedPushRef,
		reportedPushRemote,
		pushError,
		candidateDigest: approved ? candidateTreeDigest(approved.tree) : undefined,
		candidateRevision: commitRequired ? approved?.parent : input.candidateRevision,
		approvedTreeOid: approved?.tree,
		approvedParent: approved?.parent,
		observation,
	});
	if (provenReceipts.commit) sideEffects.commit = provenReceipts.commit;
	if (provenReceipts.push) sideEffects.push = provenReceipts.push;

	if (charter.git.create_tag) {
		let tagObservation: TagProofObservation | undefined;
		if (reportedTag && tagError === undefined && input.git?.proveTag) {
			try {
				tagObservation = await input.git.proveTag(reportedTag, input.signal);
			} catch (error) {
				tagError = messageOf(error);
			}
		}
		const provenCommitSha = sideEffects.commit?.state === "proven" ? sideEffects.commit.detail.sha : undefined;
		const expectedTargetSha = charter.git.commit ? provenCommitSha : input.candidateRevision;
		sideEffects.tag = proveTagReceipt({
			reportedTag,
			tagError,
			expectedTargetSha,
			observation: tagObservation,
		});
	}

	if (charter.release.package_publish) {
		let publishObservation: PublishProofObservation | undefined;
		if (reportedPublicationId && publishError === undefined && input.release?.provePublish) {
			try {
				publishObservation = await input.release.provePublish(reportedPublicationId);
			} catch (error) {
				publishError = messageOf(error);
			}
		}
		sideEffects.publish = provePublishReceipt({
			reportedId: reportedPublicationId,
			error: publishError,
			expectedIntegrity: reportedIntegrity,
			observation: publishObservation,
		});
	}

	if (reportedDeploys.length > 0) {
		const deployReceipts: NonNullable<DeliverySideEffects["deploy"]>[number][] = [];
		for (const deployment of reportedDeploys) {
			let deployObservation: DeployProofObservation | undefined;
			let error = deployment.error;
			if (deployment.id && error === undefined && input.release?.proveDeploy) {
				try {
					deployObservation = await input.release.proveDeploy(deployment.target);
				} catch (caught) {
					error = messageOf(caught);
				}
			}
			deployReceipts.push(
				proveDeployReceipt({
					target: deployment.target,
					reportedId: deployment.id,
					error,
					expectedRevision: input.expectedDeployRevision ?? input.candidateRevision,
					expectedArtifactDigest: input.expectedArtifactDigest,
					observation: deployObservation,
				}),
			);
		}
		sideEffects.deploy = deployReceipts;
	}

	return sideEffects;
}

export function deliveryReceiptFailed(sideEffects: DeliverySideEffects): boolean {
	return (
		sideEffects.commit?.state === "failed" ||
		sideEffects.tag?.state === "failed" ||
		sideEffects.push?.state === "failed" ||
		sideEffects.publish?.state === "failed" ||
		sideEffects.github_release?.state === "failed" ||
		(sideEffects.deploy ?? []).some((receipt) => receipt.state === "failed")
	);
}

const CANDIDATE_IDENTITY_LOSS = new Set([
	"candidate_tree_mismatch",
	"stale_candidate",
	"candidate_revision_mismatch",
	"candidate_digest_mismatch",
	"commit_parent_mismatch",
	"commit_required_for_dirty_candidate",
	"candidate_residue_remains",
	"commit_sha_not_head",
]);

function failedReceiptError(
	receipt: { readonly state: string; readonly error?: string } | undefined,
): string | undefined {
	if (receipt?.state !== "failed") return undefined;
	return receipt.error;
}

/** True when every failed receipt says the frozen candidate is not the live tree. */
export function deliveryCandidateIdentityLost(sideEffects: DeliverySideEffects): boolean {
	const errors: string[] = [];
	const collect = (error: string | undefined): void => {
		if (error !== undefined) errors.push(error);
	};
	collect(failedReceiptError(sideEffects.commit));
	collect(failedReceiptError(sideEffects.tag));
	collect(failedReceiptError(sideEffects.push));
	collect(failedReceiptError(sideEffects.publish));
	collect(failedReceiptError(sideEffects.github_release));
	for (const receipt of sideEffects.deploy ?? []) collect(failedReceiptError(receipt));
	return errors.length > 0 && errors.every((error) => CANDIDATE_IDENTITY_LOSS.has(error));
}
