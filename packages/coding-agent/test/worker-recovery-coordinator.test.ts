import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { WorkerRecoveryCoordinator } from "../src/core/delegation/worker-recovery-coordinator.ts";
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
		const legacyConversation = store.open({ agentDir, resumeContext });
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
