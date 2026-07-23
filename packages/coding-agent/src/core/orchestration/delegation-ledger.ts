import type { HarnessCapability, OrchestrationProfile } from "./contracts.ts";
import { OrchestrationEventStore } from "./event-store.ts";
import { type AttemptRuntimeState, DurableTaskRuntime, DurableTaskRuntimeError } from "./task-runtime.ts";
import type { GoalObjectiveProjection } from "./work-state-projection.ts";

export interface DelegationLedgerOptions {
	agentDir: string;
	sessionId: string;
	now?: () => number;
}

export interface PrepareDelegationInput {
	laneId: string;
	instructions: string;
	profile: OrchestrationProfile;
	requiredCapabilities: readonly HarnessCapability[];
	goal?: GoalObjectiveProjection;
	verificationOfTaskId?: string;
}

export interface StartedDelegationAttempt {
	objectiveId: string;
	taskId: string;
	attemptId: string;
	leaseId: string;
	fencingToken: number;
	expiresAt: string;
}

function activeAttempt(attempt: AttemptRuntimeState): boolean {
	return attempt.status === "queued" || attempt.status === "leased" || attempt.status === "running";
}

/**
 * Durable adapter for in-process delegated completions. It records the dispatch before execution,
 * fences interrupted completions on restart, and returns queued work for event-driven re-dispatch.
 * It deliberately does not pretend an isolated completion has a resumable model transcript.
 */
export class DelegationOrchestrationLedger {
	readonly runtime: DurableTaskRuntime;
	private readonly sessionId: string;

	constructor(options: DelegationLedgerOptions) {
		this.sessionId = options.sessionId;
		this.runtime = new DurableTaskRuntime({
			store: new OrchestrationEventStore({ agentDir: options.agentDir, sessionId: options.sessionId }),
			now: options.now,
		});
	}

	prepare(input: PrepareDelegationInput): AttemptRuntimeState {
		let snapshot = this.runtime.getSnapshot();
		const existingVerificationSubject = input.verificationOfTaskId
			? snapshot.tasks[input.verificationOfTaskId]
			: undefined;
		if (input.verificationOfTaskId && !existingVerificationSubject) {
			throw new DurableTaskRuntimeError(`Unknown verification subject '${input.verificationOfTaskId}'.`);
		}
		const objectiveId =
			existingVerificationSubject?.task.objectiveId ?? input.goal?.objectiveId ?? `session:${this.sessionId}`;
		if (input.goal && objectiveId === input.goal.objectiveId) {
			this.runtime.ensureObjective(input.goal);
			snapshot = this.runtime.getSnapshot();
		} else if (!snapshot.objectives[objectiveId]) {
			this.runtime.createObjective({
				objectiveId,
				title: `Session ${this.sessionId}`,
				description: "Session-scoped delegated work",
			});
			snapshot = this.runtime.getSnapshot();
		}

		if (!snapshot.tasks[input.laneId]) {
			const verificationSubject = input.verificationOfTaskId
				? snapshot.tasks[input.verificationOfTaskId]
				: undefined;
			this.runtime.createTask({
				taskId: input.laneId,
				objectiveId,
				title: `Delegated ${input.profile.role} work`,
				description: input.instructions,
				role: input.profile.role,
				requiredCapabilities: input.requiredCapabilities,
				riskBudget: input.profile.budget,
				...(input.verificationOfTaskId
					? {
							verificationOfTaskId: input.verificationOfTaskId,
							acceptanceCriterionIds: verificationSubject?.task.acceptanceCriterionIds ?? [],
						}
					: {}),
			});
			snapshot = this.runtime.getSnapshot();
		}

		const task = snapshot.tasks[input.laneId];
		if (!task) throw new DurableTaskRuntimeError(`Failed to create task '${input.laneId}'.`);
		const existing = [...task.attemptIds]
			.reverse()
			.map((attemptId) => snapshot.attempts[attemptId])
			.find((attempt): attempt is AttemptRuntimeState => attempt !== undefined && activeAttempt(attempt));
		if (existing) return existing;

		return this.runtime.queueAttempt(input.laneId, {
			taskId: input.laneId,
			profileId: input.profile.profileId,
			instructions: input.instructions,
			resourcePointerIds: [],
		});
	}

	start(attemptId: string, leaseTtlMs: number): StartedDelegationAttempt {
		const snapshot = this.runtime.getSnapshot();
		const attempt = snapshot.attempts[attemptId];
		if (!attempt) throw new DurableTaskRuntimeError(`Unknown attempt '${attemptId}'.`);
		const task = snapshot.tasks[attempt.taskId];
		if (!task) throw new DurableTaskRuntimeError(`Unknown task '${attempt.taskId}'.`);
		const lease = this.runtime.leaseAttempt(attemptId, `in-process:${this.sessionId}`, leaseTtlMs);
		this.runtime.startAttempt(attemptId, lease.leaseId, lease.fencingToken);
		return {
			objectiveId: task.task.objectiveId,
			taskId: task.task.taskId,
			attemptId,
			leaseId: lease.leaseId,
			fencingToken: lease.fencingToken,
			expiresAt: lease.expiresAt,
		};
	}

	cancel(attemptId: string, reasonCode: string): void {
		this.runtime.cancelAttempt(attemptId, reasonCode);
	}

	/** Fence interrupted isolated completions and queue one replacement attempt per task. */
	recoverQueuedDispatches(): AttemptRuntimeState[] {
		this.runtime.recoverInterruptedUnboundAttempts();
		let snapshot = this.runtime.getSnapshot();
		for (const task of Object.values(snapshot.tasks)) {
			const attempts = task.attemptIds.map((attemptId) => snapshot.attempts[attemptId]).filter(Boolean);
			if (attempts.some((attempt) => attempt && activeAttempt(attempt))) continue;
			const interrupted = [...attempts].reverse().find((attempt) => attempt?.status === "expired");
			if (!interrupted || task.task.status !== "ready") continue;
			const maxAttempts = task.task.riskBudget.maxAttempts;
			if (maxAttempts !== undefined && task.attemptIds.length >= maxAttempts) {
				this.runtime.failTask(task.task.taskId, "attempt_budget_exhausted");
				snapshot = this.runtime.getSnapshot();
				continue;
			}
			this.runtime.queueAttempt(task.task.taskId, interrupted.dispatch);
			snapshot = this.runtime.getSnapshot();
		}
		return Object.values(snapshot.attempts).filter((attempt) => attempt.status === "queued");
	}
}
