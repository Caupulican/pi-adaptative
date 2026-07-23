import path from "node:path";
import type { CapabilityEnvelope, GateOutcome, WorkerClaim, WorkerRequest } from "../autonomy/contracts.ts";
import { checkPathScope } from "../autonomy/path-scope.ts";
import { cloneEvidenceBundleForStorage, isEvidenceBundle } from "../research/evidence-bundle.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export function cloneWorkerClaimForStorage(claim: WorkerClaim): WorkerClaim {
	return {
		...claim,
		...(claim.outputFormat ? { outputFormat: claim.outputFormat } : {}),
		changedFiles: [...claim.changedFiles],
		blockers: claim.blockers ? [...claim.blockers] : undefined,
		evidence: claim.evidence ? cloneEvidenceBundleForStorage(claim.evidence) : undefined,
		verification: claim.verification
			? { ...claim.verification, reasonCodes: [...claim.verification.reasonCodes] }
			: undefined,
	};
}

export function isWorkerClaim(value: unknown): value is WorkerClaim {
	if (!isPlainRecord(value)) return false;
	const obj = value as Record<string, unknown>;

	if (typeof obj.requestId !== "string") return false;
	if (typeof obj.status !== "string" || !["completed", "blocked", "failed", "cancelled"].includes(obj.status)) {
		return false;
	}
	if (typeof obj.summary !== "string") return false;
	if (obj.outputFormat !== undefined && obj.outputFormat !== "structured" && obj.outputFormat !== "plain_text")
		return false;

	if (!Array.isArray(obj.changedFiles) || !obj.changedFiles.every((f) => typeof f === "string")) {
		return false;
	}

	if (obj.blockers !== undefined) {
		if (!Array.isArray(obj.blockers) || !obj.blockers.every((b) => typeof b === "string")) {
			return false;
		}
	}

	if (obj.usageReportId !== undefined && typeof obj.usageReportId !== "string") return false;
	if (obj.createdAt !== undefined && typeof obj.createdAt !== "string") return false;
	if (obj.parentReviewRequired !== undefined && typeof obj.parentReviewRequired !== "boolean") return false;
	if (obj.parentReviewedAt !== undefined && typeof obj.parentReviewedAt !== "string") return false;
	if (obj.verification !== undefined) {
		if (!isPlainRecord(obj.verification)) return false;
		if (typeof obj.verification.subjectTaskId !== "string" || !obj.verification.subjectTaskId) return false;
		if (obj.verification.verdict !== "accepted" && obj.verification.verdict !== "rejected") return false;
		if (
			!Array.isArray(obj.verification.reasonCodes) ||
			!obj.verification.reasonCodes.every((reasonCode) => typeof reasonCode === "string" && reasonCode.length > 0)
		) {
			return false;
		}
	}

	if (obj.evidence !== undefined && !isEvidenceBundle(obj.evidence)) return false;

	return true;
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
	const { request, claim } = args;
	const baseDir = args.cwd ?? process.cwd();

	if (claim.requestId !== request.id) {
		return {
			outcome: "block",
			gate: "worker_claim",
			reasonCode: "request_id_mismatch",
			message: `Claim requestId '${claim.requestId}' does not match request id '${request.id}'.`,
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
	if (args.changedFiles.length === 0) {
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
			summary: "",
			changedFiles: [...args.changedFiles],
			usageReportId: syntheticId,
		},
		cwd: args.cwd,
	});
	return { reviewRequired: acceptance.outcome !== "allow", reasonCode: acceptance.reasonCode };
}
