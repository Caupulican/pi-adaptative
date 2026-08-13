import path from "node:path";
import type { CapabilityEnvelope, GateOutcome, WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import { checkPathScope } from "../autonomy/path-scope.ts";
import { normalizeEvidenceBundleForStorage } from "../research/evidence-bundle.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export const MAX_WORKER_CLAIM_SUMMARY_CHARS = 8_000;
export const MAX_WORKER_CLAIM_BLOCKERS = 32;
export const MAX_WORKER_CLAIM_BLOCKER_CHARS = 1_000;
export const MAX_WORKER_CLAIM_CHANGED_FILES = 128;
export const MAX_WORKER_CLAIM_CHANGED_FILE_CHARS = 2_048;
export const MAX_WORKER_CLAIM_REQUEST_ID_CHARS = 256;
export const MAX_WORKER_CLAIM_TERMINAL_ATTEMPT_ID_CHARS = 256;
export const MAX_WORKER_CLAIM_USAGE_REPORT_ID_CHARS = 256;
export const MAX_WORKER_CLAIM_TIMESTAMP_CHARS = 128;
export const MAX_WORKER_CLAIM_VERIFICATION_SUBJECT_ID_CHARS = 256;
export const MAX_WORKER_CLAIM_REASON_CODES = 32;
export const MAX_WORKER_CLAIM_REASON_CODE_CHARS = 128;

export interface BoundedWorkerClaimStrings {
	values: string[];
	overflowed: boolean;
}

function collectBoundedWorkerClaimStrings(
	values: readonly string[],
	maximumCount: number,
	maximumChars: number,
	trim: boolean,
): BoundedWorkerClaimStrings {
	const bounded: string[] = [];
	const seen = new Set<string>();
	let overflowed = values.length > maximumCount;
	for (let index = 0; index < Math.min(values.length, maximumCount); index++) {
		const raw = values[index];
		if (typeof raw !== "string" || raw.length > maximumChars) {
			overflowed = true;
			continue;
		}
		const normalized = trim ? raw.trim() : raw;
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		bounded.push(normalized);
	}
	return { values: bounded, overflowed };
}

/** Native host observations may be reduced for terminal storage, but callers must surface overflow. */
export function collectBoundedWorkerClaimBlockers(values: readonly string[]): BoundedWorkerClaimStrings {
	return collectBoundedWorkerClaimStrings(values, MAX_WORKER_CLAIM_BLOCKERS, MAX_WORKER_CLAIM_BLOCKER_CHARS, true);
}

/** Changed paths preserve their exact spelling; trimming a real path could change its meaning. */
export function collectBoundedWorkerClaimChangedFiles(values: readonly string[]): BoundedWorkerClaimStrings {
	return collectBoundedWorkerClaimStrings(
		values,
		MAX_WORKER_CLAIM_CHANGED_FILES,
		MAX_WORKER_CLAIM_CHANGED_FILE_CHARS,
		false,
	);
}

function invalidWorkerClaim(message: string): never {
	throw new Error(`Invalid worker claim: ${message}`);
}

/**
 * The worker boundary must not evaluate accessors from managed/external reports. Copy only own
 * data descriptors, then validate and construct a fresh contract object from the bounded values.
 */
function ownWorkerClaimDataRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isPlainRecord(value)) invalidWorkerClaim(`${label} must be a plain object.`);
	const descriptors = Object.getOwnPropertyDescriptors(value);
	const record: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
	for (const [key, descriptor] of Object.entries(descriptors)) {
		if (!("value" in descriptor)) invalidWorkerClaim(`${label}.${key} must not be an accessor.`);
		record[key] = descriptor.value;
	}
	return record;
}

function requiredWorkerClaimString(value: unknown, label: string, maximumChars: number): string {
	if (typeof value !== "string" || value.length === 0) invalidWorkerClaim(`${label} must be a non-empty string.`);
	if (value.length > maximumChars) invalidWorkerClaim(`${label} exceeds ${maximumChars} characters.`);
	return value;
}

function optionalWorkerClaimString(value: unknown, label: string, maximumChars: number): string | undefined {
	if (value === undefined) return undefined;
	return requiredWorkerClaimString(value, label, maximumChars);
}

function workerClaimStringArray(value: unknown, label: string, maximumCount: number, maximumChars: number): string[] {
	if (!Array.isArray(value)) invalidWorkerClaim(`${label} must be an array.`);
	if (value.length > maximumCount) invalidWorkerClaim(`${label} exceeds ${maximumCount} entries.`);
	const copied: string[] = [];
	const seen = new Set<string>();
	for (let index = 0; index < value.length; index++) {
		const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
		if (!descriptor || !("value" in descriptor)) invalidWorkerClaim(`${label}[${index}] must be a data value.`);
		const item = requiredWorkerClaimString(descriptor.value, `${label}[${index}]`, maximumChars);
		if (seen.has(item)) continue;
		seen.add(item);
		copied.push(item);
	}
	return copied;
}

export function boundedWorkerClaimStrings(
	values: readonly string[],
	maximumCount: number,
	maximumChars: number,
): string[] {
	const bounded: string[] = [];
	const seen = new Set<string>();
	for (const value of values) {
		const normalized = value.trim().slice(0, maximumChars);
		if (!normalized || seen.has(normalized)) continue;
		seen.add(normalized);
		bounded.push(normalized);
		if (bounded.length >= maximumCount) break;
	}
	return bounded;
}

export function boundedWorkerClaimBlockers(values: readonly string[]): string[] {
	return collectBoundedWorkerClaimBlockers(values).values;
}

export function boundedWorkerClaimChangedFiles(values: readonly string[]): string[] {
	return collectBoundedWorkerClaimChangedFiles(values).values;
}

/**
 * Applies the one mandatory bounded claim contract before persistence, review, finalization, or
 * artifact inspection. Host-built/native reports have already bounded their model output; foreign
 * reports must fit the exact same envelope and are rejected before cloning or getter invocation.
 */
export function normalizeWorkerClaimForHost(value: unknown): WorkerClaim {
	const claim = ownWorkerClaimDataRecord(value, "claim");
	const status = claim.status;
	if (
		status !== "completed" &&
		status !== "partial" &&
		status !== "blocked" &&
		status !== "failed" &&
		status !== "cancelled"
	) {
		invalidWorkerClaim("claim.status is invalid.");
	}
	if (claim.outputFormat !== undefined && claim.outputFormat !== "structured" && claim.outputFormat !== "plain_text") {
		invalidWorkerClaim("claim.outputFormat is invalid.");
	}
	if (claim.parentReviewRequired !== undefined && typeof claim.parentReviewRequired !== "boolean") {
		invalidWorkerClaim("claim.parentReviewRequired must be boolean.");
	}
	const verification =
		claim.verification === undefined ? undefined : ownWorkerClaimDataRecord(claim.verification, "claim.verification");
	if (verification && verification.verdict !== "accepted" && verification.verdict !== "rejected") {
		invalidWorkerClaim("claim.verification.verdict is invalid.");
	}
	const normalizedVerification: WorkerClaim["verification"] = verification
		? {
				subjectTaskId: requiredWorkerClaimString(
					verification.subjectTaskId,
					"claim.verification.subjectTaskId",
					MAX_WORKER_CLAIM_VERIFICATION_SUBJECT_ID_CHARS,
				),
				verdict: verification.verdict === "accepted" ? "accepted" : "rejected",
				reasonCodes: workerClaimStringArray(
					verification.reasonCodes,
					"claim.verification.reasonCodes",
					MAX_WORKER_CLAIM_REASON_CODES,
					MAX_WORKER_CLAIM_REASON_CODE_CHARS,
				),
			}
		: undefined;
	if (normalizedVerification && normalizedVerification.reasonCodes.length === 0) {
		invalidWorkerClaim("claim.verification.reasonCodes must not be empty.");
	}
	return {
		requestId: requiredWorkerClaimString(claim.requestId, "claim.requestId", MAX_WORKER_CLAIM_REQUEST_ID_CHARS),
		...(claim.terminalAttemptId !== undefined
			? {
					terminalAttemptId: requiredWorkerClaimString(
						claim.terminalAttemptId,
						"claim.terminalAttemptId",
						MAX_WORKER_CLAIM_TERMINAL_ATTEMPT_ID_CHARS,
					),
				}
			: {}),
		status,
		summary: requiredWorkerClaimString(claim.summary, "claim.summary", MAX_WORKER_CLAIM_SUMMARY_CHARS),
		...(claim.outputFormat !== undefined ? { outputFormat: claim.outputFormat } : {}),
		...(claim.evidence !== undefined ? { evidence: normalizeEvidenceBundleForStorage(claim.evidence) } : {}),
		changedFiles: workerClaimStringArray(
			claim.changedFiles,
			"claim.changedFiles",
			MAX_WORKER_CLAIM_CHANGED_FILES,
			MAX_WORKER_CLAIM_CHANGED_FILE_CHARS,
		),
		...(claim.blockers !== undefined
			? {
					blockers: workerClaimStringArray(
						claim.blockers,
						"claim.blockers",
						MAX_WORKER_CLAIM_BLOCKERS,
						MAX_WORKER_CLAIM_BLOCKER_CHARS,
					),
				}
			: {}),
		...(claim.usageReportId !== undefined
			? {
					usageReportId: requiredWorkerClaimString(
						claim.usageReportId,
						"claim.usageReportId",
						MAX_WORKER_CLAIM_USAGE_REPORT_ID_CHARS,
					),
				}
			: {}),
		...(claim.createdAt !== undefined
			? {
					createdAt: optionalWorkerClaimString(
						claim.createdAt,
						"claim.createdAt",
						MAX_WORKER_CLAIM_TIMESTAMP_CHARS,
					),
				}
			: {}),
		...(claim.parentReviewRequired !== undefined ? { parentReviewRequired: claim.parentReviewRequired } : {}),
		...(claim.parentReviewedAt !== undefined
			? {
					parentReviewedAt: optionalWorkerClaimString(
						claim.parentReviewedAt,
						"claim.parentReviewedAt",
						MAX_WORKER_CLAIM_TIMESTAMP_CHARS,
					),
				}
			: {}),
		...(normalizedVerification ? { verification: normalizedVerification } : {}),
	};
}

export function normalizeWorkerClaimReasonCode(value: unknown, fallback: string): string {
	return (typeof value === "string" && value.trim() ? value.trim() : fallback).slice(
		0,
		MAX_WORKER_CLAIM_REASON_CODE_CHARS,
	);
}

export function cloneWorkerClaimForStorage(claim: WorkerClaim): WorkerClaim {
	return normalizeWorkerClaimForHost(claim);
}

export function isWorkerClaim(value: unknown): value is WorkerClaim {
	try {
		normalizeWorkerClaimForHost(value);
		return true;
	} catch {
		return false;
	}
}

export function requiresParentReview(claim: WorkerClaim): boolean {
	if (claim.status !== "completed") {
		return true;
	}
	if (claim.blockers && claim.blockers.length > 0) {
		return true;
	}
	if (claim.changedFiles.length > 0) {
		return true;
	}
	return false;
}

/**
 * True iff {@link validateWorkerClaim}'s gate would flag this claim "ask-user" /
 * "parent_review_required" (the two branches at :110 and :178 below) — an otherwise-completed
 * claim the parent must explicitly look at because it reports blockers, or reports file mutations
 * that passed path-scope validation. Reuses `validateWorkerClaim` itself rather than a
 * separately-maintained heuristic, so a persisted review marker can never drift from the
 * gate's actual verdict.
 */
export function isParentReviewRequired(args: { request: WorkerRequest; claim: WorkerClaim; cwd?: string }): boolean {
	const acceptance = validateWorkerClaim(args);
	return acceptance.outcome === "ask-user" && acceptance.reasonCode === "parent_review_required";
}

export function validateWorkerClaim(args: {
	request: WorkerRequest;
	claim: WorkerClaim;
	/**
	 * Baseline for relative paths — BOTH the runner's cwd-relative `changedFiles` and the
	 * envelope's possibly-relative path scopes resolve against this. Defaults to process.cwd()
	 * for callers whose session cwd is the process cwd.
	 */
	cwd?: string;
}): GateOutcome {
	const { request } = args;
	let claim: WorkerClaim;
	try {
		claim = normalizeWorkerClaimForHost(args.claim);
	} catch (error) {
		return {
			outcome: "block",
			gate: "worker_claim",
			reasonCode: "invalid_worker_claim",
			message: error instanceof Error ? error.message : "Worker claim failed host validation.",
		};
	}
	const baseDir = args.cwd ?? process.cwd();

	if (claim.requestId !== request.id) {
		return {
			outcome: "block",
			gate: "worker_claim",
			reasonCode: "request_id_mismatch",
			message: `Claim requestId '${claim.requestId}' does not match request id '${request.id}'.`,
		};
	}

	if (claim.status === "partial") {
		return {
			outcome: "ask-user",
			gate: "worker_claim",
			reasonCode: "parent_review_required",
			message: `Worker finished with partial claim status '${claim.status}'.`,
			details: claim.blockers && claim.blockers.length > 0 ? { blockers: [...claim.blockers] } : undefined,
		};
	}

	if (claim.status !== "completed") {
		return {
			outcome: "block",
			gate: "worker_claim",
			reasonCode: "worker_not_completed",
			message: `Worker finished with status '${claim.status}'.`,
			details: claim.blockers && claim.blockers.length > 0 ? { blockers: [...claim.blockers] } : undefined,
		};
	}

	if (!claim.usageReportId) {
		return {
			outcome: "block",
			gate: "worker_claim",
			reasonCode: "missing_usage_report",
			message: "Completed worker claim is missing usageReportId.",
		};
	}

	if (claim.blockers && claim.blockers.length > 0) {
		return {
			outcome: "ask-user",
			gate: "worker_claim",
			reasonCode: "parent_review_required",
			message: "Completed worker claim includes blockers and requires parent review.",
			details: { blockers: [...claim.blockers] },
		};
	}

	if (claim.changedFiles.length > 0) {
		if (!request.envelope.allowedPaths || request.envelope.allowedPaths.length === 0) {
			return {
				outcome: "block",
				gate: "worker_claim",
				reasonCode: "missing_path_scope",
				message: "Worker changed files but no allowedPaths are configured in the envelope.",
			};
		}

		// The runner reports changed files relative to the session cwd — resolve file and scope
		// roots against the SAME baseline. Resolving per-root double-prefixed nested names and
		// let a denied subtree slip past the deny rule.
		const resolvedAllowed = request.envelope.allowedPaths.map((p) => path.resolve(baseDir, p));
		const resolvedDenied = request.envelope.deniedPaths?.map((p) => path.resolve(baseDir, p));
		for (const changedFile of claim.changedFiles) {
			let isInsideAny = false;
			let isDenied = false;

			const scopedChangedFile = path.resolve(baseDir, changedFile);
			for (const root of resolvedAllowed) {
				const decision = checkPathScope(
					{
						root,
						allowedPaths: resolvedAllowed,
						deniedPaths: resolvedDenied,
					},
					scopedChangedFile,
				);

				if (decision.kind === "denied") {
					isDenied = true;
					break;
				}
				if (decision.kind === "inside") {
					isInsideAny = true;
				}
			}

			if (isDenied) {
				return {
					outcome: "block",
					gate: "worker_claim",
					reasonCode: "changed_file_denied",
					message: `Worker changed file '${changedFile}' which matches a denied path.`,
				};
			}

			if (!isInsideAny) {
				return {
					outcome: "block",
					gate: "worker_claim",
					reasonCode: "changed_file_outside_scope",
					message: `Worker changed file '${changedFile}' outside allowed scope.`,
				};
			}
		}

		// Files are inside scope, but worker output is untrusted
		return {
			outcome: "ask-user",
			gate: "worker_claim",
			reasonCode: "parent_review_required",
			message: "Worker changed files require parent review.",
		};
	}

	return {
		outcome: "allow",
		gate: "worker_claim",
		reasonCode: "allowed",
		message: "Worker claim is read-only and allowed.",
	};
}

/**
 * Path-scope-only re-review for a SELF-REPORTED (out-of-process) worker's claimed `changedFiles`
 * -- e.g. a tmux worker's own completion report, which (unlike an in-process worker's) never
 * passed through this process's `applyWorkerActions` envelope enforcement before the write
 * happened; the tmux worker's tool loop runs in a separate process this session does not gate.
 * Reuses {@link validateWorkerClaim}'s exact symlink-safe scope check verbatim -- never
 * reimplement path resolution: synthesizes a minimal, always-"completed" request/claim pair
 * carrying only the reported `changedFiles` and the scope's `allowedPaths`/`deniedPaths`, so the
 * ONLY thing that can vary the verdict is the path-scope branch.
 *
 * Deliberately broader than {@link isParentReviewRequired}: that helper only flags the gate's
 * "ask-user" branch, which is correct for an in-process worker (a write that would have been
 * "block"-worthy was already refused before it could happen, by the SAME envelope, via
 * `applyWorkerActions`). A self-reported claim has no such backstop -- an out-of-scope or denied
 * path already happened on the real filesystem whether or not this gate would allow it, so here
 * ANY non-"allow" verdict (in scope, out of scope, or no scope configured at all) means a human
 * must look, not "the write didn't happen".
 */
export function reviewManagedLaneChangedFiles(args: {
	changedFiles: readonly string[];
	/** The scope to validate against -- e.g. the session's active `CapabilityEnvelope`, until a
	 * per-launch tmux standing grant envelope lands in a later wave (documented follow-up). */
	envelope: Pick<CapabilityEnvelope, "allowedPaths" | "deniedPaths">;
	cwd?: string;
}): { reviewRequired: boolean; reasonCode: string } {
	const boundedChangedFiles = normalizeWorkerClaimForHost({
		requestId: "managed-lane-review",
		status: "completed",
		summary: "Managed lane changed-file review.",
		changedFiles: args.changedFiles,
		usageReportId: "managed-lane-review",
	}).changedFiles;
	if (boundedChangedFiles.length === 0) {
		return { reviewRequired: false, reasonCode: "no_changed_files" };
	}
	const syntheticId = "managed-lane-review";
	const acceptance = validateWorkerClaim({
		request: {
			id: syntheticId,
			instructions: "",
			route: {
				tier: "cheap",
				risk: "scoped-write",
				confidence: 1,
				reasonCode: "managed_lane_review",
				reasons: [],
			},
			envelope: {
				id: syntheticId,
				capabilities: ["filesystem.write"],
				allowedPaths: args.envelope.allowedPaths,
				deniedPaths: args.envelope.deniedPaths,
			},
		},
		claim: {
			requestId: syntheticId,
			status: "completed",
			summary: "Managed lane changed-file review.",
			changedFiles: boundedChangedFiles,
			usageReportId: syntheticId,
		},
		cwd: args.cwd,
	});
	return { reviewRequired: acceptance.outcome !== "allow", reasonCode: acceptance.reasonCode };
}
