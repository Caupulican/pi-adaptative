import path from "node:path";
import type { CapabilityEnvelope, GateOutcome, WorkerRequest, WorkerResult } from "../autonomy/contracts.ts";
import { checkPathScope } from "../autonomy/path-scope.ts";
import { cloneEvidenceBundleForStorage, isEvidenceBundle } from "../research/evidence-bundle.ts";

export function cloneWorkerResultForStorage(result: WorkerResult): WorkerResult {
	return {
		...result,
		...(result.outputFormat ? { outputFormat: result.outputFormat } : {}),
		changedFiles: [...result.changedFiles],
		blockers: result.blockers ? [...result.blockers] : undefined,
		evidence: result.evidence ? cloneEvidenceBundleForStorage(result.evidence) : undefined,
	};
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

export function isWorkerResult(value: unknown): value is WorkerResult {
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

	if (obj.evidence !== undefined && !isEvidenceBundle(obj.evidence)) return false;

	return true;
}

export function requiresParentReview(result: WorkerResult): boolean {
	if (result.status !== "completed") {
		return true;
	}
	if (result.blockers && result.blockers.length > 0) {
		return true;
	}
	if (result.changedFiles.length > 0) {
		return true;
	}
	return false;
}

/**
 * True iff {@link validateWorkerResult}'s gate would flag this result "ask-user" /
 * "parent_review_required" (the two branches at :110 and :178 below) — an otherwise-completed
 * result the parent must explicitly look at because it reports blockers, or reports file mutations
 * that passed path-scope validation. Reuses `validateWorkerResult` itself rather than a
 * separately-maintained heuristic, so a persisted review marker can never drift from the
 * gate's actual verdict.
 */
export function isParentReviewRequired(args: { request: WorkerRequest; result: WorkerResult; cwd?: string }): boolean {
	const acceptance = validateWorkerResult(args);
	return acceptance.outcome === "ask-user" && acceptance.reasonCode === "parent_review_required";
}

export function validateWorkerResult(args: {
	request: WorkerRequest;
	result: WorkerResult;
	/**
	 * Baseline for relative paths — BOTH the runner's cwd-relative `changedFiles` and the
	 * envelope's possibly-relative path scopes resolve against this. Defaults to process.cwd()
	 * for callers whose session cwd is the process cwd.
	 */
	cwd?: string;
}): GateOutcome {
	const { request, result } = args;
	const baseDir = args.cwd ?? process.cwd();

	if (result.requestId !== request.id) {
		return {
			outcome: "block",
			gate: "worker_result",
			reasonCode: "request_id_mismatch",
			message: `Result requestId '${result.requestId}' does not match request id '${request.id}'.`,
		};
	}

	if (result.status !== "completed") {
		return {
			outcome: "block",
			gate: "worker_result",
			reasonCode: "worker_not_completed",
			message: `Worker finished with status '${result.status}'.`,
			details: result.blockers && result.blockers.length > 0 ? { blockers: [...result.blockers] } : undefined,
		};
	}

	if (!result.usageReportId) {
		return {
			outcome: "block",
			gate: "worker_result",
			reasonCode: "missing_usage_report",
			message: "Completed worker result is missing usageReportId.",
		};
	}

	if (result.blockers && result.blockers.length > 0) {
		return {
			outcome: "ask-user",
			gate: "worker_result",
			reasonCode: "parent_review_required",
			message: "Completed worker result includes blockers and requires parent review.",
			details: { blockers: [...result.blockers] },
		};
	}

	if (result.changedFiles.length > 0) {
		if (!request.envelope.allowedPaths || request.envelope.allowedPaths.length === 0) {
			return {
				outcome: "block",
				gate: "worker_result",
				reasonCode: "missing_path_scope",
				message: "Worker changed files but no allowedPaths are configured in the envelope.",
			};
		}

		// The runner reports changed files relative to the session cwd — resolve file and scope
		// roots against the SAME baseline. Resolving per-root double-prefixed nested names and
		// let a denied subtree slip past the deny rule.
		const resolvedAllowed = request.envelope.allowedPaths.map((p) => path.resolve(baseDir, p));
		const resolvedDenied = request.envelope.deniedPaths?.map((p) => path.resolve(baseDir, p));
		for (const changedFile of result.changedFiles) {
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
					gate: "worker_result",
					reasonCode: "changed_file_denied",
					message: `Worker changed file '${changedFile}' which matches a denied path.`,
				};
			}

			if (!isInsideAny) {
				return {
					outcome: "block",
					gate: "worker_result",
					reasonCode: "changed_file_outside_scope",
					message: `Worker changed file '${changedFile}' outside allowed scope.`,
				};
			}
		}

		// Files are inside scope, but worker output is untrusted
		return {
			outcome: "ask-user",
			gate: "worker_result",
			reasonCode: "parent_review_required",
			message: "Worker changed files require parent review.",
		};
	}

	return {
		outcome: "allow",
		gate: "worker_result",
		reasonCode: "allowed",
		message: "Worker result is read-only and allowed.",
	};
}

/**
 * Path-scope-only re-review for a SELF-REPORTED (out-of-process) worker's claimed `changedFiles`
 * -- e.g. a tmux worker's own completion report, which (unlike an in-process worker's) never
 * passed through this process's `applyWorkerActions` envelope enforcement before the write
 * happened; the tmux worker's tool loop runs in a separate process this session does not gate.
 * Reuses {@link validateWorkerResult}'s exact symlink-safe scope check verbatim -- never
 * reimplement path resolution: synthesizes a minimal, always-"completed" request/result pair
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
	const acceptance = validateWorkerResult({
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
				capabilities: ["write_files"],
				allowedPaths: args.envelope.allowedPaths,
				deniedPaths: args.envelope.deniedPaths,
			},
		},
		result: {
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
