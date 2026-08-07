import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import type { WorkerDelegationRequest } from "../src/core/delegation/worker-delegation-request.ts";
import { WorkerDispatchScheduler } from "../src/core/delegation/worker-dispatch-scheduler.ts";
import { DEFAULT_WORKER_FLEET_LIMITS } from "../src/core/delegation/worker-fleet-limits.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { WorkerRecoveryCoordinator } from "../src/core/delegation/worker-recovery-coordinator.ts";
import type { AttemptRuntimeState, TaskRuntimeProjection } from "../src/core/orchestration/task-runtime.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";

const roots: string[] = [];

function root(): string {
	const value = mkdtempSync(join(tmpdir(), "pi-worker-recovery-"));
	roots.push(value);
	return value;
}

afterEach(() => {
	while (roots.length > 0) {
		const value = roots.pop();
		if (value) rmSync(value, { recursive: true, force: true });
	}
});

function coordinator(lifecycle: WorkerLifecycle): WorkerRecoveryCoordinator {
	return new WorkerRecoveryCoordinator({
		lifecycle,
		scheduler: { enqueue: vi.fn() },
		recoverWriteReservations: vi.fn(),
		publishTerminalRecord: vi.fn(),
		dispatchVerification: () => ({ started: false, skipReason: "verifier_unavailable" }),
		recoverTaskBearingMailboxTurns: vi.fn(),
		recoverSessionRootReplies: vi.fn(),
		warn: vi.fn(),
	});
}

describe("WorkerRecoveryCoordinator", () => {
	it("reconstructs only the exact durable request context after restart", () => {
		const agentDir = root();
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "session-recovery-request" });
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "pinned-worker",
			model: { provider: "faux", id: "pinned-model" },
		});
		const prepared = lifecycle.prepare({
			instructions: "Inspect only the admitted source tree.",
			executionContract: createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(profile, agentDir),
				},
			}),
			requiredCapabilities: [],
			taskContext: {
				requirementIds: ["requirement-1"],
				dependsOnTaskIds: [],
				acceptanceCriterionIds: [],
				resourcePointerIds: ["resource-1"],
			},
		});

		expect(coordinator(lifecycle).recoveredRequest(prepared.attempt)).toEqual({
			instructions: "Inspect only the admitted source tree.",
			profileId: "pinned-worker",
			taskContext: {
				requirementIds: ["requirement-1"],
				dependsOnTaskIds: [],
				acceptanceCriterionIds: [],
				resourcePointerIds: ["resource-1"],
			},
		});
	});

	it("recovers verifier identity from the durable task without caller-supplied metadata", () => {
		const agentDir = root();
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "session-recovery-verifier" });
		const implementerProfile = createTestWorkerOrchestrationProfile({
			profileId: "pinned-implementer",
			model: { provider: "faux", id: "pinned-implementer-model" },
		});
		const implementerContract = createWorkerExecutionContract({
			worker: {
				profile: implementerProfile,
				modelBinding: implementerProfile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(implementerProfile, agentDir),
			},
		});
		const subject = lifecycle.prepare({
			instructions: "Implement the durable subject.",
			executionContract: implementerContract,
			requiredCapabilities: [],
		});
		const verifierProfile = createTestWorkerOrchestrationProfile({
			profileId: "pinned-verifier",
			model: { provider: "faux", id: "pinned-verifier-model" },
			role: "verifier",
		});
		const verifierContract = createWorkerExecutionContract({
			worker: {
				profile: verifierProfile,
				modelBinding: verifierProfile.modelPolicy.candidates[0]!,
				authority: createTestWorkerExecutionAuthority(verifierProfile, agentDir),
			},
		});
		const verifier = lifecycle.prepare({
			instructions: "Verify the durable subject.",
			executionContract: verifierContract,
			requiredCapabilities: [],
			verificationOfTaskId: subject.record.laneId,
		});

		expect(coordinator(lifecycle).recoveredRequest(verifier.attempt)).toMatchObject({
			instructions: "Verify the durable subject.",
			verificationOfTaskId: subject.record.laneId,
		});
	});

	it("rebuilds the durable scheduler queue without consulting a current model or profile", () => {
		const agentDir = root();
		const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "session-recovery-queue" });
		const profile = createTestWorkerOrchestrationProfile({
			profileId: "durably-pinned-worker",
			model: { provider: "faux", id: "durably-pinned-model" },
		});
		const prepared = lifecycle.prepare({
			instructions: "Continue only the persisted assignment.",
			executionContract: createWorkerExecutionContract({
				worker: {
					profile,
					modelBinding: profile.modelPolicy.candidates[0]!,
					authority: createTestWorkerExecutionAuthority(profile, agentDir),
				},
			}),
			requiredCapabilities: [],
			taskContext: {
				requirementIds: ["requirement-queue"],
				dependsOnTaskIds: [],
				acceptanceCriterionIds: [],
				resourcePointerIds: ["resource-queue"],
			},
		});
		const task = lifecycle.getTask(prepared.record.laneId);
		if (!task) throw new Error("Expected durable task.");
		lifecycle.bindGrant(
			prepared.attempt.attemptId,
			createTestExecutionGrant({
				objectiveId: task.task.objectiveId,
				taskId: prepared.attempt.taskId,
				attemptId: prepared.attempt.attemptId,
				role: profile.role,
			}),
		);
		const enqueue = vi.fn();
		const recovery = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler: { enqueue },
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord: vi.fn(),
			dispatchVerification: () => ({ started: false, skipReason: "verifier_unavailable" }),
			recoverTaskBearingMailboxTurns: vi.fn(),
			recoverSessionRootReplies: vi.fn(),
			warn: vi.fn(),
		});

		recovery.recover();
		expect(enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ laneId: prepared.record.laneId, profileId: "durably-pinned-worker" }),
			{
				instructions: "Continue only the persisted assignment.",
				profileId: "durably-pinned-worker",
				taskContext: {
					requirementIds: ["requirement-queue"],
					dependsOnTaskIds: [],
					acceptanceCriterionIds: [],
					resourcePointerIds: ["resource-queue"],
				},
			},
			true,
			false,
		);
		recovery.recover();
		expect(enqueue).toHaveBeenCalledTimes(1);
	});

	it("retains a failed queue recovery for retry while continuing terminal and mailbox recovery", () => {
		const record: LaneRecord = { laneId: "queued-worker", type: "worker", status: "queued" };
		const terminal: LaneRecord = { laneId: "terminal-worker", type: "worker", status: "succeeded" };
		const attempt: AttemptRuntimeState = {
			attemptId: "queued-attempt",
			taskId: record.laneId,
			status: "queued",
			dispatch: {
				taskId: record.laneId,
				profileId: "pinned",
				instructions: "recover me",
				resourcePointerIds: [],
			},
			checkpointIds: [],
			createdAt: "2026-08-07T00:00:00.000Z",
			updatedAt: "2026-08-07T00:00:00.000Z",
		};
		const lifecycle = {
			suspendBoundInProcessAttemptsForRestart: () => [],
			recoverQueued: () => [{ record, attempt }],
			getTaskRuntimeSnapshot: () => ({ agents: {}, tasks: {}, attempts: { [attempt.attemptId]: attempt } }),
			getTask: () => undefined,
			getPendingVerificationRecoveries: () => [],
			getPendingTerminalNotifications: () => [{ notificationId: "terminal", record: terminal }],
		} as unknown as WorkerLifecycle;
		const enqueue = vi.fn(() => {
			throw new Error("reload blocker unavailable");
		});
		const publishTerminalRecord = vi.fn();
		const recoverSessionRootReplies = vi.fn();
		const recoverTaskBearingMailboxTurns = vi.fn();
		const warn = vi.fn();
		const recovery = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler: { enqueue },
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord,
			dispatchVerification: () => ({ started: false, skipReason: "unused" }),
			recoverTaskBearingMailboxTurns,
			recoverSessionRootReplies,
			warn,
		});

		expect(() => recovery.recover()).not.toThrow();
		expect(publishTerminalRecord).toHaveBeenCalledWith(terminal);
		expect(recoverSessionRootReplies).toHaveBeenCalledOnce();
		expect(recoverTaskBearingMailboxTurns).toHaveBeenCalledOnce();
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("reload blocker unavailable"));

		recovery.recover();
		expect(enqueue).toHaveBeenCalledTimes(2);
	});

	it("reconciles accepted root replies and task-bearing mailboxes on every recovery boundary", () => {
		const lifecycle = new WorkerLifecycle({ agentDir: root(), sessionId: "session-mailbox-recovery" });
		const recoverTaskBearingMailboxTurns = vi.fn();
		const recoverSessionRootReplies = vi.fn();
		const recovery = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler: { enqueue: vi.fn() },
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord: vi.fn(),
			dispatchVerification: () => ({ started: false, skipReason: "verifier_unavailable" }),
			recoverTaskBearingMailboxTurns,
			recoverSessionRootReplies,
			warn: vi.fn(),
		});

		recovery.recover();
		recovery.recover();
		expect(recoverTaskBearingMailboxTurns).toHaveBeenCalledTimes(2);
		expect(recoverSessionRootReplies).toHaveBeenCalledTimes(2);
	});

	it("hands all pending terminal notifications to one atomic recovery batch", () => {
		const records: LaneRecord[] = [
			{ laneId: "terminal-1", type: "worker", status: "succeeded" },
			{ laneId: "terminal-2", type: "worker", status: "failed" },
		];
		const lifecycle = {
			suspendBoundInProcessAttemptsForRestart: () => [],
			recoverQueued: () => [],
			getTaskRuntimeSnapshot: () => ({ agents: {}, tasks: {}, attempts: {} }),
			getPendingVerificationRecoveries: () => [],
			getPendingTerminalNotifications: () =>
				records.map((record, index) => ({ notificationId: `notification-${index}`, record })),
		} as unknown as WorkerLifecycle;
		const publishTerminalRecord = vi.fn();
		const publishTerminalRecords = vi.fn();
		const recovery = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler: { enqueue: vi.fn() },
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord,
			publishTerminalRecords,
			dispatchVerification: () => ({ started: false, skipReason: "unused" }),
			recoverTaskBearingMailboxTurns: vi.fn(),
			recoverSessionRootReplies: vi.fn(),
			warn: vi.fn(),
		});

		recovery.recover();
		expect(publishTerminalRecords).toHaveBeenCalledOnce();
		expect(publishTerminalRecords).toHaveBeenCalledWith(records);
		expect(publishTerminalRecord).not.toHaveBeenCalled();
	});

	it("replays every retained mandatory verifier when a saturated queue releases capacity", async () => {
		const agentDir = root();
		const records = new Map<string, LaneRecord>();
		const scheduler = new WorkerDispatchScheduler({
			agentDir,
			registerInFlightWork: () => () => undefined,
			isDisposed: () => false,
			admit: () => ({ action: "wait", reason: "capacity" }),
			getRecord: (laneId) => records.get(laneId),
			run: async () => ({ started: false, skipReason: "unused" }),
			cancel: vi.fn(),
			warn: vi.fn(),
		});
		for (let index = 0; index < DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches - 1; index += 1) {
			const record = { laneId: `ordinary-${index}`, type: "worker" as const, status: "queued" as const };
			records.set(record.laneId, record);
			scheduler.enqueue(record, { instructions: `ordinary ${index}` });
		}
		const startedSubjects = new Set<string>();
		const recoveries = ["subject-1", "subject-2"].map((subjectTaskId) => ({
			action: "dispatch" as const,
			subjectTaskId,
			implementationProfileId: "implementer",
			summary: `verify ${subjectTaskId}`,
			artifactUris: [],
		}));
		const lifecycle = {
			suspendBoundInProcessAttemptsForRestart: () => [],
			recoverQueued: () => [],
			getTaskRuntimeSnapshot: () => ({ agents: {}, tasks: {}, attempts: {} }),
			getPendingVerificationRecoveries: () =>
				recoveries.filter((recovery) => !startedSubjects.has(recovery.subjectTaskId)),
			getPendingTerminalNotifications: () => [],
		} as unknown as WorkerLifecycle;
		const dispatchVerification = vi.fn((recovery: (typeof recoveries)[number]) => {
			const record = {
				laneId: `verifier-${recovery.subjectTaskId}`,
				type: "worker" as const,
				status: "queued" as const,
			};
			records.set(record.laneId, record);
			const request: WorkerDelegationRequest = {
				instructions: recovery.summary,
				verificationOfTaskId: recovery.subjectTaskId,
			};
			try {
				scheduler.enqueue(record, request, false, true);
				startedSubjects.add(recovery.subjectTaskId);
				return { started: true as const };
			} catch (error) {
				return {
					started: false as const,
					skipReason: error instanceof Error ? error.message : String(error),
				};
			}
		});
		const recovery = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler,
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord: vi.fn(),
			dispatchVerification,
			recoverTaskBearingMailboxTurns: vi.fn(),
			recoverSessionRootReplies: vi.fn(),
			warn: vi.fn(),
		});

		recovery.recover();
		expect(startedSubjects).toEqual(new Set(["subject-1"]));
		expect(scheduler.queuedCount).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches);

		expect(scheduler.dropQueued("ordinary-0")).toBe(true);
		await Promise.resolve();
		expect(startedSubjects).toEqual(new Set(["subject-1", "subject-2"]));
		expect(scheduler.queuedCount).toBe(DEFAULT_WORKER_FLEET_LIMITS.maxQueuedDispatches);
		expect(dispatchVerification.mock.calls.map(([candidate]) => candidate.subjectTaskId)).toEqual([
			"subject-1",
			"subject-2",
			"subject-2",
		]);
		recovery.dispose();
	});

	it("rederives every restart-suspended agent attempt after partial queue recovery", () => {
		const attempts = ["lane-1", "lane-2"].map(
			(laneId, index): AttemptRuntimeState => ({
				attemptId: `attempt-${index + 1}`,
				taskId: laneId,
				agentId: `agent-${index + 1}`,
				dispatch: {
					provider: "pi",
					taskId: laneId,
					instructions: `recover ${laneId}`,
					profileId: "recovery-profile",
					logicalLaneId: `agent-${index + 1}`,
					resourcePointerIds: [],
				},
				status: "suspended",
				reasonCode: "agent_process_recovered_after_owner_exit",
				checkpointIds: [],
				createdAt: "2026-08-07T00:00:00.000Z",
				updatedAt: "2026-08-07T00:00:00.000Z",
			}),
		);
		const records = new Map(
			attempts.map((attempt) => [
				attempt.taskId,
				{ laneId: attempt.taskId, type: "worker" as const, status: "running" as const },
			]),
		);
		const tasks = Object.fromEntries(
			attempts.map((attempt) => [
				attempt.taskId,
				{
					task: { verificationOfTaskId: undefined },
					attemptIds: [attempt.attemptId],
				},
			]),
		);
		const snapshot = {
			agents: {},
			tasks,
			attempts: Object.fromEntries(attempts.map((attempt) => [attempt.attemptId, attempt])),
		} as unknown as TaskRuntimeProjection;
		let firstPass = true;
		const lifecycle = {
			suspendBoundInProcessAttemptsForRestart: () => {
				if (!firstPass) return [];
				firstPass = false;
				return attempts.map(({ attemptId }) => attemptId);
			},
			recoverQueued: () => [],
			getTaskRuntimeSnapshot: () => snapshot,
			getRecord: (laneId: string) => records.get(laneId),
			getTask: (taskId: string) => snapshot.tasks[taskId],
			getPendingVerificationRecoveries: () => [],
			getPendingTerminalNotifications: () => [],
		} as unknown as WorkerLifecycle;
		const queued = new Set<string>();
		const running = new Set<string>();
		let capacityListener: (() => void) | undefined;
		const enqueue = vi.fn((record: LaneRecord) => {
			if (queued.has(record.laneId) || running.has(record.laneId)) return;
			if (queued.size >= 1) throw new Error("worker_dispatch_queue_full");
			queued.add(record.laneId);
		});
		const recovery = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler: {
				enqueue,
				onQueueCapacityAvailable: (listener) => {
					capacityListener = listener;
					return () => {
						capacityListener = undefined;
					};
				},
			},
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord: vi.fn(),
			dispatchVerification: () => ({ started: false, skipReason: "unused" }),
			recoverTaskBearingMailboxTurns: vi.fn(),
			recoverSessionRootReplies: vi.fn(),
			warn: vi.fn(),
		});

		recovery.recover();
		expect(queued).toEqual(new Set(["lane-1"]));
		running.add("lane-1");
		queued.delete("lane-1");
		capacityListener?.();
		expect(queued).toEqual(new Set(["lane-2"]));
		expect(enqueue.mock.calls.map(([record]) => record.laneId)).toEqual(["lane-1", "lane-2", "lane-1", "lane-2"]);
		recovery.dispose();
	});

	it("does not immediately enqueue a retry-suspended attempt before its durable deadline", () => {
		const notBefore = "2026-08-07T02:00:00.000Z";
		const attempt = {
			attemptId: "attempt-retry",
			taskId: "lane-retry",
			agentId: "agent-retry",
			dispatch: {
				provider: "pi",
				taskId: "lane-retry",
				instructions: "retry later",
				profileId: "recovery-profile",
				logicalLaneId: "agent-retry",
				resourcePointerIds: [],
			},
			status: "suspended",
			reasonCode: "retry_scheduled:server_error",
			retry: { retriesUsed: 1, notBefore },
			checkpointIds: [],
			createdAt: "2026-08-07T00:00:00.000Z",
			updatedAt: "2026-08-07T00:00:00.000Z",
		} as AttemptRuntimeState;
		const snapshot = {
			agents: {},
			tasks: { [attempt.taskId]: { task: {}, attemptIds: [attempt.attemptId] } },
			attempts: { [attempt.attemptId]: attempt },
		} as unknown as TaskRuntimeProjection;
		const lifecycle = {
			suspendBoundInProcessAttemptsForRestart: () => [],
			recoverQueued: () => [],
			getTaskRuntimeSnapshot: () => snapshot,
			getRecord: () => ({ laneId: attempt.taskId, type: "worker", status: "running" }),
			getTask: (taskId: string) => snapshot.tasks[taskId],
			getActiveAttempt: () => attempt,
			getPendingVerificationRecoveries: () => [],
			getPendingTerminalNotifications: () => [],
		} as unknown as WorkerLifecycle;
		const enqueue = vi.fn();
		const recovery = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler: { enqueue },
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord: vi.fn(),
			dispatchVerification: () => ({ started: false, skipReason: "unused" }),
			recoverTaskBearingMailboxTurns: vi.fn(),
			recoverSessionRootReplies: vi.fn(),
			now: () => Date.parse("2026-08-07T01:00:00.000Z"),
			warn: vi.fn(),
		});

		recovery.recover();
		expect(enqueue).not.toHaveBeenCalled();
		recovery.dispose();
	});

	it("isolates a throwing verifier dispatch and continues every remaining recovery owner", () => {
		const terminalRecord = { laneId: "terminal", type: "worker" as const, status: "succeeded" as const };
		const recoveries = ["subject-throws", "subject-starts"].map((subjectTaskId) => ({
			action: "dispatch" as const,
			subjectTaskId,
			implementationProfileId: "implementer",
			summary: `verify ${subjectTaskId}`,
			artifactUris: [],
		}));
		const lifecycle = {
			suspendBoundInProcessAttemptsForRestart: () => [],
			recoverQueued: () => [],
			getTaskRuntimeSnapshot: () => ({ agents: {}, tasks: {}, attempts: {} }),
			getPendingVerificationRecoveries: () => recoveries,
			getPendingTerminalNotifications: () => [{ notificationId: "notification-1", record: terminalRecord }],
		} as unknown as WorkerLifecycle;
		const publishTerminalRecord = vi.fn();
		const recoverTaskBearingMailboxTurns = vi.fn();
		const recoverSessionRootReplies = vi.fn();
		const warn = vi.fn();
		const dispatchVerification = vi.fn((recovery: (typeof recoveries)[number]) => {
			if (recovery.subjectTaskId === "subject-throws") throw new Error("verifier boundary failed");
			return { started: true as const };
		});
		const recovery = new WorkerRecoveryCoordinator({
			lifecycle,
			scheduler: { enqueue: vi.fn() },
			recoverWriteReservations: vi.fn(),
			publishTerminalRecord,
			dispatchVerification,
			recoverTaskBearingMailboxTurns,
			recoverSessionRootReplies,
			warn,
		});

		expect(() => recovery.recover()).not.toThrow();
		expect(dispatchVerification.mock.calls.map(([candidate]) => candidate.subjectTaskId)).toEqual([
			"subject-throws",
			"subject-starts",
		]);
		expect(publishTerminalRecord).toHaveBeenCalledWith(terminalRecord);
		expect(recoverSessionRootReplies).toHaveBeenCalledOnce();
		expect(recoverTaskBearingMailboxTurns).toHaveBeenCalledOnce();
		recovery.recover();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			"Recovered verification for subject-throws threw during dispatch: verifier boundary failed",
		);
	});

	it("repairs only unmatched interrupted tool calls and reuses a terminal response", () => {
		const agentDir = root();
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId: "session-recovery-tools",
			logicalAgentId: "agent-recovery-tools",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		const assistant = fauxAssistantMessage(
			[fauxToolCall("read", { path: "first.ts" }), fauxToolCall("read", { path: "second.ts" })],
			{ stopReason: "toolUse" },
		);
		const calls = (assistant as AssistantMessage).content.filter(
			(content): content is Extract<AssistantMessage["content"][number], { type: "toolCall" }> =>
				content.type === "toolCall",
		);
		if (calls.length !== 2) throw new Error("Expected two tool calls.");
		conversation.appendMessage({ role: "user", content: "Read both files.", timestamp: 1 });
		conversation.appendMessage(assistant);
		conversation.appendMessage({
			role: "toolResult",
			toolCallId: calls[0]!.id,
			toolName: "read",
			content: [{ type: "text", text: "first completed" }],
			isError: false,
			timestamp: 2,
		});

		const recovery = coordinator(new WorkerLifecycle({ agentDir, sessionId: "session-recovery-tools" }));
		recovery.repairInterruptedToolResults(conversation);
		expect(
			conversation
				.getProviderContext()
				.messages.filter((message) => message.role === "toolResult")
				.map((message) => message.toolCallId),
		).toEqual([calls[0]!.id, calls[1]!.id]);

		conversation.beginAttemptUsage("attempt-terminal");
		const terminal = fauxAssistantMessage("Persisted terminal response", { stopReason: "stop" });
		conversation.appendMessage(terminal);
		expect(recovery.recoveredTerminalCompletion(conversation, "attempt-terminal")).toMatchObject({
			text: "Persisted terminal response",
			stopReason: "stop",
		});
	});

	it("requires terminal assistant evidence after the recovered attempt boundary", () => {
		const agentDir = root();
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId: "session-terminal-attempt-scope",
			logicalAgentId: "agent-terminal-attempt-scope",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		conversation.appendMessage(fauxAssistantMessage("prior task completed", { stopReason: "stop" }));
		conversation.beginAttemptUsage("attempt-2");
		const recovery = coordinator(new WorkerLifecycle({ agentDir, sessionId: "session-terminal-attempt-scope" }));

		expect(recovery.recoveredTerminalCompletion(conversation, "attempt-2")).toBeUndefined();
		conversation.appendMessage(fauxAssistantMessage("attempt 2 completed", { stopReason: "stop" }));
		expect(recovery.recoveredTerminalCompletion(conversation, "attempt-2")).toMatchObject({
			text: "attempt 2 completed",
			stopReason: "stop",
		});
		conversation.beginAttemptUsage("attempt-3");
		conversation.appendMessage(fauxAssistantMessage("attempt 3 completed", { stopReason: "stop" }));
		expect(recovery.recoveredTerminalCompletion(conversation, "attempt-2")).toMatchObject({
			text: "attempt 2 completed",
			stopReason: "stop",
		});
	});

	it("recovers an empty terminal assistant without replaying the provider", () => {
		const agentDir = root();
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId: "session-empty-terminal-recovery",
			logicalAgentId: "agent-empty-terminal-recovery",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		conversation.beginAttemptUsage("attempt-empty-terminal");
		const usage = {
			input: 7,
			output: 0,
			cacheRead: 3,
			cacheWrite: 0,
			totalTokens: 10,
			cost: { input: 0.07, output: 0, cacheRead: 0.01, cacheWrite: 0, total: 0.08 },
		};
		conversation.appendMessage({
			...fauxAssistantMessage("", { stopReason: "stop" }),
			model: "persisted-empty-model",
			responseModel: "resolved-empty-model",
			usage,
		});
		const recovery = coordinator(new WorkerLifecycle({ agentDir, sessionId: "session-empty-terminal-recovery" }));
		const replayProvider = vi.fn();

		const recovered = recovery.recoveredTerminalCompletion(conversation, "attempt-empty-terminal");
		if (!recovered) replayProvider();

		expect(replayProvider).not.toHaveBeenCalled();
		expect(recovered).toEqual({ text: "", usage, stopReason: "stop" });
		expect(conversation.getLastAttemptMessage("attempt-empty-terminal")).toMatchObject({
			model: "persisted-empty-model",
			responseModel: "resolved-empty-model",
			usage,
		});
	});

	it("recovers cumulative usage without cloning compacted raw transcript payloads", () => {
		const agentDir = root();
		const store = new WorkerConversationStore();
		const conversation = store.ensure({
			agentDir,
			parentSessionId: "session-recovery-usage",
			logicalAgentId: "agent-recovery-usage",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		conversation.appendMessage({
			...fauxAssistantMessage("provider result"),
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		});
		conversation.appendMessage({
			role: "toolResult",
			toolCallId: "tool-usage-1",
			toolName: "read",
			content: [{ type: "text", text: "large payload must not be cloned" }],
			isError: false,
			timestamp: 2,
		});
		const resumeContext = conversation.getResumeContext();
		const metadataFile = `${resumeContext.sessionFile}.worker.json`;
		const legacyMetadata = JSON.parse(readFileSync(metadataFile, "utf-8")) as Record<string, unknown>;
		delete legacyMetadata.usageAccountingVersion;
		writeFileSync(metadataFile, `${JSON.stringify(legacyMetadata)}\n`);
		const legacyConversation = new WorkerConversationStore().open({ agentDir, resumeContext });
		const rawTranscript = vi.spyOn(legacyConversation, "getRawTranscript");

		const usage = coordinator(new WorkerLifecycle({ agentDir, sessionId: "session-recovery-usage" })).initialUsage(
			legacyConversation,
			undefined,
			"attempt-legacy",
		);

		expect(rawTranscript).not.toHaveBeenCalled();
		expect(usage).toMatchObject({ toolCalls: 1, inputTokens: 1, outputTokens: 1, totalTokens: 2 });
	});

	it("starts versioned recovery at zero when the durable attempt boundary was not appended before a crash", () => {
		const agentDir = root();
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId: "session-versioned-missing-boundary",
			logicalAgentId: "agent-versioned-missing-boundary",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		conversation.appendMessage({
			...fauxAssistantMessage("prior completed task"),
			usage: {
				input: 80,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 100,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.5 },
			},
		});

		const usage = coordinator(
			new WorkerLifecycle({ agentDir, sessionId: "session-versioned-missing-boundary" }),
		).initialUsage(conversation, undefined, "attempt-prepared-before-crash");

		expect(usage).toEqual({
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 0,
			costUsd: 0,
			activeWallClockMs: 0,
		});
	});

	it("reconciles an append-before-checkpoint crash only within the current attempt", () => {
		const agentDir = root();
		const conversation = new WorkerConversationStore().ensure({
			agentDir,
			parentSessionId: "session-attempt-usage",
			logicalAgentId: "agent-attempt-usage",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		});
		conversation.appendMessage({
			...fauxAssistantMessage("prior task"),
			usage: {
				input: 100,
				output: 20,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 120,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.6 },
			},
		});
		conversation.beginAttemptUsage("attempt-current");
		conversation.appendMessage({
			...fauxAssistantMessage("current response persisted before its checkpoint"),
			usage: {
				input: 3,
				output: 2,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 5,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.03 },
			},
		});
		conversation.appendMessage({
			role: "toolResult",
			toolCallId: "tool-current",
			toolName: "read",
			content: [{ type: "text", text: "persisted result" }],
			isError: false,
			timestamp: 2,
		});

		const usage = coordinator(new WorkerLifecycle({ agentDir, sessionId: "session-attempt-usage" })).initialUsage(
			conversation,
			{
				toolCalls: 0,
				inputTokens: 2,
				outputTokens: 1,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 3,
				costUsd: 0.02,
				activeWallClockMs: 40,
			},
			"attempt-current",
		);

		expect(usage).toEqual({
			toolCalls: 1,
			inputTokens: 3,
			outputTokens: 2,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			totalTokens: 5,
			costUsd: 0.03,
			activeWallClockMs: 40,
		});
	});
});
