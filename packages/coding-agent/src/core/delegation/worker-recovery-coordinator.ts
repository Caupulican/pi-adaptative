import type { Message, Usage } from "@caupulican/pi-ai";
import type { LaneRecord } from "../autonomy/lane-tracker.ts";
import { isPathWithinScope } from "../autonomy/path-scope.ts";
import { reconcileAttemptUsage } from "../orchestration/attempt-usage.ts";
import type { AttemptUsageSnapshot, ExecutionGrant, ResourcePointer, RiskBudget } from "../orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../orchestration/task-runtime.ts";
import type { WorkerConversation } from "./worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "./worker-delegation-request.ts";
import type { WorkerDispatchScheduler } from "./worker-dispatch-scheduler.ts";
import type { WorkerExecutionPlan } from "./worker-execution-policy.ts";
import type { PendingVerificationRecovery, WorkerLifecycle } from "./worker-lifecycle.ts";

export type WorkerRecoveryDispatchResult = { started: true } | { started: false; skipReason: string };

export interface WorkerRecoveryCoordinatorOptions {
	lifecycle: WorkerLifecycle;
	scheduler: Pick<WorkerDispatchScheduler, "enqueue">;
	recoverWriteReservations(): void;
	publishTerminalRecord(record: LaneRecord): void;
	dispatchVerification(
		recovery: Extract<PendingVerificationRecovery, { action: "dispatch" }>,
	): WorkerRecoveryDispatchResult;
	warn(message: string): void;
}

/**
 * Owns restart-only worker state repair. It has no provider or tool execution authority: it
 * reconstructs bounded durable requests, requeues them through the owner scheduler, and supplies
 * the execution layer with narrow transcript/usage/grant recovery decisions.
 */
export class WorkerRecoveryCoordinator {
	private readonly options: WorkerRecoveryCoordinatorOptions;
	private queueRecovered = false;
	private recoveringDurableState = false;
	private readonly verificationRecoveryFailures = new Map<string, string>();

	constructor(options: WorkerRecoveryCoordinatorOptions) {
		this.options = options;
	}

	/** Idempotently rebuild in-process queue state and replay only durable terminal handoffs. */
	recover(): void {
		if (this.recoveringDurableState) return;
		this.recoveringDurableState = true;
		const { lifecycle, scheduler } = this.options;
		try {
			if (!this.queueRecovered) {
				const suspendedAttemptIds = new Set(lifecycle.suspendBoundInProcessAttemptsForRestart());
				try {
					this.options.recoverWriteReservations();
				} catch (error) {
					this.options.warn(
						`Worker write reservation recovery failed closed: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				const queued = lifecycle.recoverQueued();
				const snapshot = lifecycle.getTaskRuntimeSnapshot();
				for (const attemptId of suspendedAttemptIds) {
					const attempt = snapshot.attempts[attemptId];
					if (!attempt || attempt.dispatch.executionKind === "managed-process") continue;
					const record = lifecycle.getRecord(attempt.taskId);
					const task = snapshot.tasks[attempt.taskId]?.task;
					if (!record || !task) continue;
					queued.push({
						record,
						attempt,
						...(task.verificationOfTaskId ? { verificationOfTaskId: task.verificationOfTaskId } : {}),
					});
				}
				for (const { attempt, record, verificationOfTaskId } of queued) {
					scheduler.enqueue(
						record,
						this.recoveredRequest(attempt, verificationOfTaskId),
						true,
						verificationOfTaskId !== undefined,
					);
				}
				this.queueRecovered = true;
			}

			for (const recovery of lifecycle.getPendingVerificationRecoveries()) {
				if (recovery.action === "reconcile") {
					try {
						this.options.publishTerminalRecord(lifecycle.reconcileVerification(recovery));
						this.verificationRecoveryFailures.delete(recovery.subjectTaskId);
					} catch (error) {
						this.options.warn(
							`Failed to reconcile recovered verification for ${recovery.subjectTaskId}: ${error instanceof Error ? error.message : String(error)}`,
						);
					}
					continue;
				}
				const started = this.options.dispatchVerification(recovery);
				if (started.started) {
					this.verificationRecoveryFailures.delete(recovery.subjectTaskId);
					continue;
				}
				if (this.verificationRecoveryFailures.get(recovery.subjectTaskId) === started.skipReason) continue;
				this.verificationRecoveryFailures.set(recovery.subjectTaskId, started.skipReason);
				this.options.warn(
					`Recovered verification for ${recovery.subjectTaskId} did not start: ${started.skipReason}`,
				);
			}

			for (const notification of lifecycle.getPendingTerminalNotifications()) {
				this.options.publishTerminalRecord(notification.record);
			}
		} finally {
			this.recoveringDurableState = false;
		}
	}

	/** Rebuild task metadata from its durable dispatch; no current profile/model selection is consulted. */
	recoveredRequest(attempt: AttemptRuntimeState, verificationOfTaskId?: string): WorkerDelegationRequest {
		const task = this.options.lifecycle.getTask(attempt.taskId)?.task;
		return {
			instructions: attempt.dispatch.instructions,
			profileId: attempt.dispatch.profileId,
			...(verificationOfTaskId ? { verificationOfTaskId } : {}),
			...(task
				? {
						taskContext: {
							requirementIds: attempt.dispatch.requirementIds ?? [],
							dependsOnTaskIds: task.dependsOn,
							acceptanceCriterionIds: task.acceptanceCriterionIds,
							resourcePointerIds: attempt.dispatch.resourcePointerIds,
						},
					}
				: {}),
		};
	}

	/** Append deterministic unknown outcomes only for tool calls not durably followed by a result. */
	repairInterruptedToolResults(conversation: WorkerConversation): void {
		const messages = conversation.getProviderMessages();
		const completedToolCallIds = new Set<string>();
		let index = messages.length - 1;
		while (index >= 0 && messages[index]?.role === "toolResult") {
			completedToolCallIds.add((messages[index] as Extract<Message, { role: "toolResult" }>).toolCallId);
			index -= 1;
		}
		const assistant = messages[index];
		if (!assistant || assistant.role !== "assistant") return;
		for (const content of assistant.content) {
			if (content.type !== "toolCall" || completedToolCallIds.has(content.id)) continue;
			conversation.appendMessage({
				role: "toolResult",
				toolCallId: content.id,
				toolName: content.name,
				content: [
					{
						type: "text",
						text: "Execution outcome is unknown because this worker was interrupted before a durable tool result was recorded. Inspect the workspace and prior evidence before deciding whether to retry this operation.",
					},
				],
				isError: true,
				timestamp: Date.now(),
			});
		}
	}

	/** Return an already-persisted final assistant response so recovery cannot duplicate provider work. */
	recoveredTerminalCompletion(
		conversation: WorkerConversation,
	): { text: string; usage: Usage; stopReason: string } | undefined {
		const last = conversation.getProviderMessages().at(-1);
		if (!last || last.role !== "assistant" || last.stopReason === "error" || last.stopReason === "aborted") {
			return undefined;
		}
		if (last.content.some((content) => content.type === "toolCall")) return undefined;
		const text = last.content
			.filter(
				(content): content is Extract<(typeof last.content)[number], { type: "text" }> => content.type === "text",
			)
			.map((content) => content.text)
			.join("");
		return text ? { text, usage: last.usage, stopReason: last.stopReason } : undefined;
	}

	/** Legacy raw transcripts predate durable usage checkpoints; reconstruct their bounded cumulative baseline. */
	initialUsage(
		conversation: WorkerConversation,
		checkpointUsage: AttemptUsageSnapshot | undefined,
	): AttemptUsageSnapshot {
		const transcriptUsage = conversation.getRawTranscriptUsage();
		return checkpointUsage ? reconcileAttemptUsage(checkpointUsage, transcriptUsage) : transcriptUsage;
	}

	/** Fail closed when the current owner profile no longer permits a persisted grant. */
	durableGrantIsStillPermitted(
		grant: ExecutionGrant,
		plan: WorkerExecutionPlan,
		selectedResources: readonly ResourcePointer[],
	): boolean {
		const allowedTools = new Set(plan.toolManifests.map((manifest) => manifest.toolName));
		const allowedCapabilities = new Set(plan.requiredCapabilities);
		const scopesRemainPermitted = (granted: readonly string[], permitted: readonly string[]) =>
			granted.every((scope) => permitted.some((candidate) => isPathWithinScope(scope, candidate)));
		const liveDenialsRemainEnforced = plan.deniedPaths.every((denied) =>
			grant.deniedPaths.some((granted) => isPathWithinScope(denied, granted)),
		);
		const budgetRemainsPermitted = (Object.keys(plan.budget) as Array<keyof RiskBudget>).every((field) => {
			const current = plan.budget[field];
			const persisted = grant.budget[field];
			return current === undefined || (persisted !== undefined && persisted <= current);
		});
		const resourcesRemainPermitted =
			grant.resources.length === selectedResources.length &&
			grant.resources.every((granted, index) => {
				const selected = selectedResources[index];
				return (
					selected !== undefined &&
					granted.id === selected.id &&
					granted.kind === selected.kind &&
					granted.uri === selected.uri &&
					granted.readOnly === selected.readOnly &&
					typeof granted.digest === "string" &&
					(selected.digest === undefined || selected.digest === granted.digest) &&
					granted.metadata?.name === selected.metadata?.name
				);
			});
		return (
			grant.allowedTools.every((toolName) => allowedTools.has(toolName)) &&
			grant.capabilities.every((capability) => allowedCapabilities.has(capability)) &&
			resourcesRemainPermitted &&
			scopesRemainPermitted(grant.readPaths, plan.readPaths) &&
			scopesRemainPermitted(grant.writePaths, plan.writePaths) &&
			liveDenialsRemainEnforced &&
			budgetRemainsPermitted
		);
	}
}
