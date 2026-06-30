import path from "node:path";
import type { GateOutcome, WorkerRequest, WorkerResult } from "../autonomy/contracts.ts";
import { checkPathScope } from "../autonomy/path-scope.ts";
import { cloneEvidenceBundleForStorage, isEvidenceBundle } from "../research/evidence-bundle.ts";

export function cloneWorkerResultForStorage(result: WorkerResult): WorkerResult {
	return {
		...result,
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

export function validateWorkerResult(args: { request: WorkerRequest; result: WorkerResult }): GateOutcome {
	const { request, result } = args;

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

		for (const changedFile of result.changedFiles) {
			let isInsideAny = false;
			let isDenied = false;

			for (const root of request.envelope.allowedPaths) {
				const scopedChangedFile = path.isAbsolute(changedFile) ? changedFile : path.resolve(root, changedFile);
				const decision = checkPathScope(
					{
						root,
						allowedPaths: request.envelope.allowedPaths,
						deniedPaths: request.envelope.deniedPaths,
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
