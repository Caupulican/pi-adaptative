import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkerResult } from "../autonomy/contracts.ts";
import type { WorkerRunOutcome } from "../delegation/worker-runner.ts";
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

function evidenceForLegacyResult(result: WorkerResult, createdAt: string): EvidenceContract[] {
	const findings = result.evidence?.findings ?? [];
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

export function adaptWorkerRunOutcome(args: {
	handle: StartedDelegationAttempt;
	outcome: WorkerRunOutcome;
	cwd: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	wallClockMs: number;
	toolCalls: number;
	verificationRequired?: boolean;
	createdAt?: string;
}): WorkerResultContract {
	return adaptWorkerResult({
		...args,
		result: args.outcome.result,
		accepted: args.outcome.accepted,
		costUsd: args.outcome.costUsd,
	});
}

export function adaptWorkerResult(args: {
	handle: StartedDelegationAttempt;
	result: WorkerResult;
	accepted: boolean;
	costUsd: number;
	cwd: string;
	inputTokens?: number;
	outputTokens?: number;
	totalTokens?: number;
	wallClockMs: number;
	toolCalls: number;
	verificationRequired?: boolean;
	createdAt?: string;
}): WorkerResultContract {
	const createdAt = args.createdAt ?? new Date().toISOString();
	const legacy = args.result;
	const status: WorkerResultContract["status"] =
		legacy.status === "completed"
			? args.accepted && !args.verificationRequired
				? "completed"
				: "partial"
			: legacy.status;
	const artifacts = legacy.changedFiles.map((changedPath, index) =>
		artifactForChangedFile(args.cwd, changedPath, index, createdAt),
	);
	const blockers = legacy.blockers ?? [];
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${args.handle.attemptId}-${args.handle.fencingToken}`,
		objectiveId: args.handle.objectiveId,
		taskId: args.handle.taskId,
		attemptId: args.handle.attemptId,
		leaseId: args.handle.leaseId,
		fencingToken: args.handle.fencingToken,
		status,
		summary: legacy.summary,
		artifacts,
		evidence: evidenceForLegacyResult(legacy, createdAt),
		errors: blockers.map((message) => ({ code: "worker_blocker", message, retryable: false })),
		...(args.verificationRequired
			? { nextAction: "independent_verification_required" }
			: !args.accepted || legacy.parentReviewRequired
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
