import type { WorkerReceiptFacts, WorkerResultReceipts } from "../orchestration/worker-result-receipts.ts";
import type { WorkerRunOutcome } from "./worker-runner.ts";

/** Called after host findings, before independent verification replaces the public outcome. */
export function recordWorkerReceiptAcceptance(
	facts: WorkerReceiptFacts,
	outcome: WorkerRunOutcome,
	verificationRequired: boolean,
): WorkerResultReceipts {
	if (facts.status === "unavailable") return { version: 1, ...facts };
	const { claim, acceptance } = outcome;
	const clean =
		claim.status === "completed" &&
		(claim.blockers?.length ?? 0) === 0 &&
		(claim.inconclusive?.length ?? 0) === 0 &&
		!claim.ownerFollowUp &&
		(!claim.hostVerdict || claim.hostVerdict.verdict === "accepted");
	// The gate has already validated scope in this branch. Acknowledgement can settle only
	// clean mutations, never a partial claim, a failed host verdict, or a reported blocker.
	const reviewOnly =
		clean &&
		claim.changedFiles.length > 0 &&
		acceptance.outcome === "ask-user" &&
		acceptance.gate === "worker_claim" &&
		acceptance.reasonCode === "parent_review_required";
	const disposition = clean && outcome.accepted ? "accepted" : reviewOnly ? "parent_review" : "rejected";
	return {
		version: 1,
		...facts,
		acceptance: {
			disposition,
			verificationRequired,
			reasonCode:
				disposition === "accepted"
					? "worker_receipts_accepted"
					: !clean
						? "worker_receipts_unsettled"
						: acceptance.reasonCode,
		},
	};
}
