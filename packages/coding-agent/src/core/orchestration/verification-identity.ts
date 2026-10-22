import { selectedTaskAttempt } from "./attempt-ordering.ts";
import type { OrchestrationTaskStatus, TaskContract } from "./contracts.ts";
import {
	type AttemptRuntimeState,
	type AttemptVerification,
	DurableTaskRuntimeError,
	type TaskRuntimeProjection,
	terminalAttemptStatus,
	type VerificationRecord,
} from "./task-runtime-state.ts";

type VerificationProjection = Pick<TaskRuntimeProjection, "tasks" | "attempts">;

/** A historical verifier without an attempt binding is usable only with one possible subject. */
export function verificationSubjectAttempt(
	state: VerificationProjection,
	verifier: TaskContract,
): AttemptRuntimeState | undefined {
	const taskId = verifier.verificationOfTaskId;
	const subject = taskId ? state.tasks[taskId] : undefined;
	if (!subject) return undefined;
	// A replayed verdict can pin a historical verifier before a later retry exists.
	// Retain that witnessed binding instead of making it ambiguous after the retry.
	if (!verifier.verificationOfAttemptId) {
		const settled = subject.attemptIds.flatMap((id) => {
			const attempt = state.attempts[id];
			return attempt?.verification?.verifierTaskId === verifier.taskId ? [attempt] : [];
		});
		if (settled.length > 0) return settled.length === 1 ? settled[0] : undefined;
	}
	let selected: AttemptRuntimeState | undefined;
	for (const attemptId of subject.attemptIds) {
		if (verifier.verificationOfAttemptId && attemptId !== verifier.verificationOfAttemptId) continue;
		const attempt = state.attempts[attemptId];
		if (attempt?.taskId !== taskId || attempt.result?.nextAction !== "independent_verification_required") continue;
		if (selected) return undefined;
		selected = attempt;
	}
	return selected;
}

/** Shared by replay validation, recovery, scheduling and every result projection. */
export function attemptVerification(
	state: VerificationProjection,
	attempt: AttemptRuntimeState,
): AttemptVerification | undefined {
	if (attempt.result?.nextAction !== "independent_verification_required") return undefined;
	if (attempt.verification) return attempt.verification;
	const historical = state.tasks[attempt.taskId]?.verification;
	const verifier = historical ? state.tasks[historical.verifierTaskId]?.task : undefined;
	return historical && verifier && verificationSubjectAttempt(state, verifier)?.attemptId === attempt.attemptId
		? { ...historical, subjectAttemptId: attempt.attemptId }
		: undefined;
}

export function taskAwaitsVerification(state: VerificationProjection, taskId: string): boolean {
	const attempt = selectedTaskAttempt(state, taskId);
	return attempt?.result?.nextAction === "independent_verification_required" && !attemptVerification(state, attempt);
}

/** A review settles evidence; it cannot reverse a different task workflow decision. */
export function taskStatusWithVerification(
	status: OrchestrationTaskStatus,
	verification: Pick<VerificationRecord, "verdict"> | undefined,
): OrchestrationTaskStatus {
	if (status !== "blocked" && status !== "completed") return status;
	return verification?.verdict === "accepted" ? "completed" : "blocked";
}

export function currentTaskTerminalOverride(
	state: VerificationProjection,
	attempt: AttemptRuntimeState,
): "failed" | "cancelled" | undefined {
	if (attempt.result?.nextAction !== "independent_verification_required") return undefined;
	if (selectedTaskAttempt(state, attempt.taskId)?.attemptId !== attempt.attemptId) return undefined;
	const status = state.tasks[attempt.taskId]?.task.status;
	return status === "failed" || status === "cancelled" ? status : undefined;
}

/** Capacity reserved for one generation must not be consumed by its predecessor's verifier. */
export function isCurrentVerificationSubject(
	state: VerificationProjection,
	taskId: string | undefined,
	attemptId: string | undefined,
): boolean {
	return (
		taskId !== undefined && attemptId !== undefined && selectedTaskAttempt(state, taskId)?.attemptId === attemptId
	);
}

/** New execution must not consume an unverified or ambiguously verified dependency. */
export function assertVerificationDependenciesReady(state: VerificationProjection, attempt: AttemptRuntimeState): void {
	for (const taskId of state.tasks[attempt.taskId]?.task.dependsOn ?? []) {
		if (taskAwaitsVerification(state, taskId)) {
			throw new DurableTaskRuntimeError(`Dependency '${taskId}' is awaiting verification of its current attempt.`);
		}
	}
}

/** Validate evidence without confusing a legacy record's readability with execution authority. */
export function assertVerificationRecord(
	state: VerificationProjection,
	taskId: string,
	verification: VerificationRecord,
	subjectAttemptId?: string,
): void {
	const verifier = state.tasks[verification.verifierTaskId]?.task;
	const reviewer = state.attempts[verification.verifierAttemptId];
	if (
		!verifier ||
		verifier.verificationOfTaskId !== taskId ||
		!reviewer ||
		reviewer.taskId !== verifier.taskId ||
		!terminalAttemptStatus(reviewer.status) ||
		(verification.verdict === "accepted" && reviewer.status !== "completed")
	)
		throw new DurableTaskRuntimeError(`Invalid verification record for task '${taskId}'.`);
	const subject = verificationSubjectAttempt(state, verifier);
	if (subjectAttemptId && subject?.attemptId !== subjectAttemptId) {
		throw new DurableTaskRuntimeError(`Verification does not identify subject attempt '${subjectAttemptId}'.`);
	}
	if (verification.verdict === "inconclusive") return;
	if (
		!reviewer.result?.evidence.some(
			(evidence) =>
				evidence.trusted &&
				evidence.kind === "review" &&
				evidence.metadata?.subjectTaskId === taskId &&
				evidence.metadata.verdict === verification.verdict &&
				(!verifier.verificationOfAttemptId ||
					evidence.metadata.subjectAttemptId === verifier.verificationOfAttemptId),
		)
	)
		throw new DurableTaskRuntimeError(`Verification for task '${taskId}' lacks matching trusted review evidence.`);
}
