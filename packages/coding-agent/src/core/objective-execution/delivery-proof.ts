import type { CommitReceipt, PushReceipt, SideEffectReceipt } from "./delivery-bundle.ts";

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
		const remote = input.reportedPushRemote || observation.remote;
		const ref = input.reportedPushRef ?? "";
		const expectedSha = input.reportedCommitSha ?? observation.head;
		const commitRejected = input.commitRequired && provenCommit === undefined;
		if (!remote || observation.ref !== ref || observation.observedSha !== expectedSha || commitRejected) {
			pushError = "push_sha_mismatch";
		} else {
			provenPush = { remote, ref, observedSha: observation.observedSha };
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
