import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import {
	type ArtifactContract,
	type EvidenceContract,
	ORCHESTRATION_SCHEMA_VERSION,
	type WorkerResultContract,
} from "./contracts.ts";
import type { StartedDelegationAttempt } from "./delegation-ledger.ts";

function artifactForChangedFile(cwd: string, changedPath: string, index: number, createdAt: string): ArtifactContract {
	const absolutePath = path.isAbsolute(changedPath) ? path.resolve(changedPath) : path.resolve(cwd, changedPath);
	let sizeBytes: number | undefined;
	try {
		if (existsSync(absolutePath)) sizeBytes = statSync(absolutePath).size;
	} catch {
		// The path remains useful evidence even if it disappeared before metadata collection.
	}
	return {
		artifactId: `changed-file-${index + 1}`,
		kind: "file",
		uri: pathToFileURL(absolutePath).href,
		...(sizeBytes !== undefined ? { sizeBytes } : {}),
		createdAt,
	};
}

function evidenceForClaim(claim: WorkerClaim, createdAt: string): EvidenceContract[] {
	const findings = claim.evidence?.findings ?? [];
	return findings.map((finding, index) => ({
		evidenceId: `worker-finding-${index + 1}`,
		kind: "observation",
		summary: finding.summary,
		artifactIds: [],
		trusted: false,
		createdAt,
		...(finding.confidence !== undefined ? { metadata: { confidence: finding.confidence } } : {}),
	}));
}

function verificationEvidence(
	claim: WorkerClaim,
	accepted: boolean,
	criterionIds: readonly string[],
	createdAt: string,
): EvidenceContract[] {
	if (!claim.verification) return [];
	const trustedReview = accepted;
	return [
		{
			evidenceId: "independent-review",
			kind: "review",
			summary: claim.summary,
			artifactIds: [],
			trusted: trustedReview,
			createdAt,
			metadata: {
				subjectTaskId: claim.verification.subjectTaskId,
				verdict: claim.verification.verdict,
				reasonCodes: [...claim.verification.reasonCodes],
			},
		},
		...criterionIds.map(
			(criterionId, index): EvidenceContract => ({
				evidenceId: `independent-review-criterion-${index + 1}`,
				criterionId,
				kind: "review",
				summary: claim.summary,
				artifactIds: [],
				trusted: trustedReview && claim.verification?.verdict === "accepted",
				createdAt,
				metadata: { subjectTaskId: claim.verification?.subjectTaskId ?? "" },
			}),
		),
	];
}

/** Sole host-owned conversion from an untrusted claim to a fenced durable result. */
export function createWorkerResultContract(args: {
	handle: StartedDelegationAttempt;
	claim: WorkerClaim;
	accepted: boolean;
	costUsd: number;
	cwd: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	wallClockMs: number;
	toolCalls: number;
	verificationRequired?: boolean;
	verificationCriterionIds?: readonly string[];
	reasonCode?: string;
	createdAt?: string;
}): WorkerResultContract {
	const createdAt = args.createdAt ?? new Date().toISOString();
	const claim = args.claim;
	const status: WorkerResultContract["status"] =
		claim.status === "completed"
			? args.accepted && !args.verificationRequired
				? "completed"
				: "partial"
			: claim.status;
	const artifacts = claim.changedFiles.map((changedPath, index) =>
		artifactForChangedFile(args.cwd, changedPath, index, createdAt),
	);
	const blockers = claim.blockers ?? [];
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${args.handle.attemptId}-${args.handle.fencingToken}`,
		objectiveId: args.handle.objectiveId,
		taskId: args.handle.taskId,
		attemptId: args.handle.attemptId,
		leaseId: args.handle.leaseId,
		fencingToken: args.handle.fencingToken,
		status,
		reasonCode: args.reasonCode ?? `worker_${claim.status}`,
		summary: claim.summary,
		artifacts,
		evidence: [
			...evidenceForClaim(claim, createdAt),
			...verificationEvidence(claim, args.accepted, args.verificationCriterionIds ?? [], createdAt),
		],
		errors: blockers.map((message) => ({ code: "worker_blocker", message, retryable: false })),
		...(args.verificationRequired
			? { nextAction: "independent_verification_required" }
			: !args.accepted || claim.parentReviewRequired
				? { nextAction: "parent_review" }
				: {}),
		usage: {
			...(args.inputTokens !== undefined ? { inputTokens: args.inputTokens } : {}),
			...(args.outputTokens !== undefined ? { outputTokens: args.outputTokens } : {}),
			...(args.totalTokens !== undefined ? { totalTokens: args.totalTokens } : {}),
			costUsd: args.costUsd,
			wallClockMs: args.wallClockMs,
			toolCalls: args.toolCalls,
		},
		createdAt,
	};
}
