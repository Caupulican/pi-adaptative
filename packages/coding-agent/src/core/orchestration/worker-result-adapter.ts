import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkerClaim } from "../autonomy/contracts.ts";
import { normalizeWorkerClaimForHost } from "../delegation/worker-claim.ts";
import { sameFileVersion } from "../util/bounded-file.ts";
import { utf8PrefixByBytes } from "../util/bounded-value.ts";
import {
	type ArtifactContract,
	type EvidenceContract,
	MAX_ORCHESTRATION_WORKER_RESULT_SUMMARY_BYTES,
	ORCHESTRATION_SCHEMA_VERSION,
	type WorkerResultContract,
} from "./contracts.ts";
import type { StartedDelegationAttempt } from "./delegation-ledger.ts";

/** Matches the default text-read ceiling while keeping synchronous result capture bounded. */
export const MAX_WORKER_ARTIFACT_HASH_BYTES = 16 * 1024 * 1024;
/** A terminal result may report many files; bound their cumulative synchronous reads too. */
export const MAX_WORKER_ARTIFACT_HASH_TOTAL_BYTES = 32 * 1024 * 1024;
const WORKER_ARTIFACT_HASH_CHUNK_BYTES = 64 * 1024;
const WORKER_RESULT_SUMMARY_TRUNCATION_NOTICE =
	"\n\n[Worker summary truncated; full output remains in the worker transcript.]";

type HostFileState = "regular" | "missing" | "non_regular" | "read_error";

interface ChangedFileArtifactObservation {
	artifact: ArtifactContract;
	fileState: HostFileState;
	digestBytesCaptured: number;
}

function metadataForFileState(fileState: HostFileState, digestStatus: string): ArtifactContract["metadata"] {
	return {
		hostObservation: "file_state_captured",
		fileState,
		digestStatus,
	};
}

function artifactForChangedFile(
	cwd: string,
	changedPath: string,
	index: number,
	createdAt: string,
	remainingDigestBytes: number,
): ChangedFileArtifactObservation {
	const absolutePath = path.isAbsolute(changedPath) ? path.resolve(changedPath) : path.resolve(cwd, changedPath);
	const artifactId = `changed-file-${index + 1}`;
	const base = {
		artifactId,
		kind: "file" as const,
		uri: pathToFileURL(absolutePath).href,
		createdAt,
	};
	let initialStats: ReturnType<typeof lstatSync>;
	try {
		initialStats = lstatSync(absolutePath);
	} catch (error: unknown) {
		if (isMissingFileError(error)) {
			return {
				artifact: { ...base, metadata: metadataForFileState("missing", "not_available") },
				fileState: "missing",
				digestBytesCaptured: 0,
			};
		}
		return {
			artifact: { ...base, metadata: metadataForFileState("read_error", "not_available") },
			fileState: "read_error",
			digestBytesCaptured: 0,
		};
	}

	if (!initialStats.isFile()) {
		return {
			artifact: {
				...base,
				sizeBytes: initialStats.size,
				metadata: metadataForFileState("non_regular", "not_applicable"),
			},
			fileState: "non_regular",
			digestBytesCaptured: 0,
		};
	}

	let fileDescriptor: number | undefined;
	try {
		fileDescriptor = openSync(absolutePath, "r");
		const stats = fstatSync(fileDescriptor);
		if (!stats.isFile()) {
			return {
				artifact: {
					...base,
					sizeBytes: stats.size,
					metadata: metadataForFileState("non_regular", "not_applicable"),
				},
				fileState: "non_regular",
				digestBytesCaptured: 0,
			};
		}
		if (!sameFileVersion(initialStats, stats)) throw new Error("File changed before hashing");
		if (stats.size > MAX_WORKER_ARTIFACT_HASH_BYTES) {
			return {
				artifact: {
					...base,
					sizeBytes: stats.size,
					metadata: {
						...metadataForFileState("regular", "omitted_size_limit"),
						digestMaxBytes: MAX_WORKER_ARTIFACT_HASH_BYTES,
					},
				},
				fileState: "regular",
				digestBytesCaptured: 0,
			};
		}
		if (stats.size > remainingDigestBytes) {
			return {
				artifact: {
					...base,
					sizeBytes: stats.size,
					metadata: {
						...metadataForFileState("regular", "omitted_aggregate_limit"),
						digestTotalMaxBytes: MAX_WORKER_ARTIFACT_HASH_TOTAL_BYTES,
					},
				},
				fileState: "regular",
				digestBytesCaptured: 0,
			};
		}

		const hash = createHash("sha256");
		const buffer = Buffer.allocUnsafe(Math.min(WORKER_ARTIFACT_HASH_CHUNK_BYTES, Math.max(stats.size, 1)));
		let bytesHashed = 0;
		while (bytesHashed < stats.size) {
			const bytesRead = readSync(
				fileDescriptor,
				buffer,
				0,
				Math.min(buffer.length, stats.size - bytesHashed),
				bytesHashed,
			);
			if (bytesRead === 0) throw new Error("File changed while hashing");
			hash.update(buffer.subarray(0, bytesRead));
			bytesHashed += bytesRead;
		}
		if (!sameFileVersion(stats, fstatSync(fileDescriptor))) throw new Error("File changed while hashing");
		return {
			artifact: {
				...base,
				digest: hash.digest("hex"),
				sizeBytes: stats.size,
				metadata: {
					...metadataForFileState("regular", "computed"),
					digestAlgorithm: "sha256",
					digestBytes: bytesHashed,
				},
			},
			fileState: "regular",
			digestBytesCaptured: bytesHashed,
		};
	} catch {
		return {
			artifact: {
				...base,
				sizeBytes: initialStats.size,
				metadata: metadataForFileState("read_error", "not_available"),
			},
			fileState: "read_error",
			digestBytesCaptured: 0,
		};
	} finally {
		if (fileDescriptor !== undefined) {
			try {
				closeSync(fileDescriptor);
			} catch {
				// The captured state remains valid even if the descriptor close reports an error.
			}
		}
	}
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function hostFileStateEvidence(
	observations: readonly ChangedFileArtifactObservation[],
	createdAt: string,
): EvidenceContract[] {
	return observations.map(({ artifact, fileState }, index) => ({
		evidenceId: `host-file-state-${index + 1}`,
		kind: "observation",
		summary: "Host captured file state.",
		artifactIds: [artifact.artifactId],
		trusted: true,
		createdAt,
		metadata: { observation: "file_state_captured", fileState },
	}));
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

function durableWorkerResultSummary(value: string, outputArtifact?: ArtifactContract): string {
	const summary = value.trim();
	if (outputArtifact) {
		const artifactNotice = `\n\n[Full worker output: ${outputArtifact.uri}]`;
		const noticeBytes = Buffer.byteLength(artifactNotice, "utf8");
		if (noticeBytes > MAX_ORCHESTRATION_WORKER_RESULT_SUMMARY_BYTES) {
			throw new Error("Worker terminal output artifact URI exceeds the durable summary limit.");
		}
		return `${utf8PrefixByBytes(
			summary,
			MAX_ORCHESTRATION_WORKER_RESULT_SUMMARY_BYTES - noticeBytes,
		)}${artifactNotice}`;
	}
	if (Buffer.byteLength(summary, "utf8") <= MAX_ORCHESTRATION_WORKER_RESULT_SUMMARY_BYTES) return summary;
	const noticeBytes = Buffer.byteLength(WORKER_RESULT_SUMMARY_TRUNCATION_NOTICE, "utf8");
	return `${utf8PrefixByBytes(
		summary,
		MAX_ORCHESTRATION_WORKER_RESULT_SUMMARY_BYTES - noticeBytes,
	)}${WORKER_RESULT_SUMMARY_TRUNCATION_NOTICE}`;
}

function verificationEvidence(
	claim: WorkerClaim,
	summary: string,
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
			summary,
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
				summary,
				artifactIds: [],
				trusted: trustedReview && claim.verification?.verdict === "accepted",
				createdAt,
				metadata: { subjectTaskId: claim.verification?.subjectTaskId ?? "" },
			}),
		),
	];
}

/** Inputs shared by every worker terminal path before the durable result is committed. */
export interface CreateWorkerResultContractInput {
	handle: StartedDelegationAttempt;
	claim: WorkerClaim;
	accepted: boolean;
	costUsd?: number;
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
	outputArtifact?: ArtifactContract;
}

/** Sole host-owned conversion from an untrusted claim to a fenced durable result. */
export function createWorkerResultContract(args: CreateWorkerResultContractInput): WorkerResultContract {
	const createdAt = args.createdAt ?? new Date().toISOString();
	// Result construction is reachable from recovery/error paths as well as the native runner.
	// Normalize first so no claim can expand file iteration, hashing, evidence, or durable results.
	const claim = normalizeWorkerClaimForHost(args.claim);
	const summary = durableWorkerResultSummary(claim.summary, args.outputArtifact);
	const status: WorkerResultContract["status"] =
		claim.status === "completed"
			? args.accepted && !args.verificationRequired
				? "completed"
				: "partial"
			: claim.status;
	const changedFileObservations: ChangedFileArtifactObservation[] = [];
	let remainingDigestBytes = MAX_WORKER_ARTIFACT_HASH_TOTAL_BYTES;
	for (const [index, changedPath] of claim.changedFiles.entries()) {
		const observation = artifactForChangedFile(args.cwd, changedPath, index, createdAt, remainingDigestBytes);
		changedFileObservations.push(observation);
		remainingDigestBytes -= observation.digestBytesCaptured;
	}
	const artifacts = [
		...changedFileObservations.map(({ artifact }) => artifact),
		...(args.outputArtifact ? [args.outputArtifact] : []),
	];
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
		summary,
		artifacts,
		evidence: [
			...evidenceForClaim(claim, createdAt),
			...hostFileStateEvidence(changedFileObservations, createdAt),
			...(args.outputArtifact
				? [
						{
							evidenceId: "host-worker-terminal-output",
							kind: "observation" as const,
							summary: "Host persisted the complete terminal worker output.",
							artifactIds: [args.outputArtifact.artifactId],
							trusted: true,
							createdAt,
							metadata: { observation: "worker_terminal_output_persisted" },
						},
					]
				: []),
			...verificationEvidence(claim, summary, args.accepted, args.verificationCriterionIds ?? [], createdAt),
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
			...(args.costUsd !== undefined ? { costUsd: args.costUsd } : {}),
			wallClockMs: args.wallClockMs,
			toolCalls: args.toolCalls,
		},
		createdAt,
	};
}
