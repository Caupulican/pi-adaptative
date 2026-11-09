/**
 * Review runs: a verifier-role task that reconciles no subject, the verifier a plan verify step starts. Its verdict is its own
 * trusted review evidence, read here once for the outcome ledger, the goal rollup and the escalation ladder.
 */

import type { TaskContract } from "./contracts.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "./task-runtime-state.ts";
import type { VerifierVerdict } from "./verification-verdict.ts";

/** A review run: a verifier-role task with no subject it reconciles. */
export function isReviewRun(task: TaskContract): boolean {
	return task.role === "verifier" && task.verificationOfTaskId === undefined;
}

/**
 * A verifier attempt's verdict as its trusted review evidence records it: accepted or rejected, the reason codes a rejection named.
 * Undefined when no trusted review with a verdict names the subject (any subject when none is given).
 */
export function reviewEvidenceVerdict(
	attempt: AttemptRuntimeState,
	subject?: { readonly taskId: string; readonly attemptId?: string },
): VerifierVerdict | undefined {
	const review = attempt.result?.evidence.find(
		(evidence) =>
			evidence.trusted &&
			evidence.kind === "review" &&
			(evidence.metadata?.verdict === "accepted" || evidence.metadata?.verdict === "rejected") &&
			(subject === undefined ||
				(evidence.metadata?.subjectTaskId === subject.taskId &&
					(subject.attemptId === undefined || evidence.metadata?.subjectAttemptId === subject.attemptId))),
	);
	if (review?.metadata?.verdict === "accepted") return { kind: "accepted" };
	if (review?.metadata?.verdict === "rejected") {
		const codes = review.metadata.reasonCodes;
		return {
			kind: "rejected",
			reasonCodes: Array.isArray(codes) ? codes.filter((code): code is string => typeof code === "string") : [],
		};
	}
	return undefined;
}

/** The verdict of a review run's attempt (accepted or rejected); undefined for any other attempt or when no trusted review exists. */
export function reviewRunVerdict(
	state: Pick<TaskRuntimeProjection, "tasks">,
	attempt: AttemptRuntimeState,
): VerifierVerdict | undefined {
	const task = state.tasks[attempt.taskId]?.task;
	if (!task || !isReviewRun(task)) return undefined;
	return reviewEvidenceVerdict(attempt);
}
