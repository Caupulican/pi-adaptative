import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerConversationStore } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { WorkerRecoveryCoordinator } from "../src/core/delegation/worker-recovery-coordinator.ts";
import {
	collectWorkerTreeBudgetSeeds,
	WorkerTreeBudgetCoordinator,
} from "../src/core/delegation/worker-tree-budget-coordinator.ts";
import { WorkerUsageAccounting } from "../src/core/delegation/worker-usage-accounting.ts";
import { EMPTY_ATTEMPT_USAGE, providerUsageFromAttemptUsage } from "../src/core/orchestration/attempt-usage.ts";
import { CapabilityGateway } from "../src/core/orchestration/capability-gateway.ts";
import { createTestExecutionGrant } from "./orchestration-profile-fixture.ts";

const directories: string[] = [];
const tokens = (totalTokens: number) => ({ ...EMPTY_ATTEMPT_USAGE, inputTokens: totalTokens, totalTokens });

function fixture() {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-worker-usage-projection-"));
	directories.push(agentDir);
	const lifecycle = new WorkerLifecycle({ agentDir, sessionId: "usage-projection" });
	const runtime = lifecycle.ledger.runtime;
	const objective = runtime.createObjective({ title: "Usage", description: "Restore attributed usage" });
	const task = runtime.createTask({
		objectiveId: objective.objectiveId,
		title: "Worker",
		description: "Account for late receipts",
		role: "implementer",
	});
	const conversation = new WorkerConversationStore().ensure({
		agentDir,
		parentSessionId: "usage-projection",
		logicalAgentId: "worker",
		cwd: agentDir,
		resourceProfileNames: [],
		contextPointers: [],
	});
	const agent = runtime.registerAgent({ role: "implementer", resumeContext: conversation.getResumeContext() });
	const attempt = runtime.queueAttempt(
		task.taskId,
		{
			taskId: task.taskId,
			profileId: "worker",
			instructions: "Do work",
			resourcePointerIds: [],
		},
		"grant",
	);
	const lease = runtime.leaseAttempt(attempt.attemptId, "owner", 60_000, agent.agentId);
	runtime.startAttempt(lease.attemptId, lease.leaseId, lease.fencingToken);
	conversation.beginAttemptUsage(attempt.attemptId);
	const recovery = new WorkerRecoveryCoordinator({
		lifecycle,
		scheduler: { enqueue: vi.fn() },
		recoverWriteReservations: vi.fn(),
		publishTerminalRecord: vi.fn(),
		dispatchVerification: () => ({ started: false, skipReason: "unused" }),
		recoverTaskBearingMailboxTurns: vi.fn(),
		recoverSessionRootReplies: vi.fn(),
		warn: vi.fn(),
	});
	return { lifecycle, runtime, conversation, recovery, agent, lease };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("worker durable usage projections", () => {
	it("updates a terminal lane's cost without reopening it or emitting another terminal notification", () => {
		const { lifecycle, runtime, lease } = fixture();
		runtime.beginAttemptUsage(lease, tokens(0));
		runtime.recordAttemptUsage(lease, { ...tokens(10), costUsd: 1 });
		const taskId = runtime.getSnapshot().attempts[lease.attemptId].taskId;
		const terminal = lifecycle.cancel(taskId, "owner_cancelled")!;
		expect(terminal.costUsd).toBe(1);
		const notification = lifecycle.getTerminalNotification(taskId)!;
		lifecycle.markNotificationsDelivered([notification.notificationId]);
		const before = runtime.getSnapshot();
		runtime.recordAttemptUsage(lease, { ...tokens(20), costUsd: 2 });
		expect(lifecycle.getRecord(taskId)).toEqual({ ...terminal, costUsd: 2 });
		expect(lifecycle.getTerminalNotification(taskId)).toMatchObject({
			notificationId: notification.notificationId,
			status: "delivered",
		});
		const after = runtime.getSnapshot();
		expect(after.notifications).toEqual(before.notifications);
		expect(after.tasks).toEqual(before.tasks);
		expect(after.agents).toEqual(before.agents);
		expect(after.checkpoints).toEqual(before.checkpoints);
	});

	it("binds real gateway receipts to their captured generation through suspension and resume", () => {
		const { lifecycle, runtime, agent, lease } = fixture();
		const grant = createTestExecutionGrant({ objectiveId: "objective", taskId: "task", attemptId: lease.attemptId });
		const old = new CapabilityGateway({ grant, cwd: process.cwd(), now: () => 100 });
		old.bindUsageAccounting(lifecycle.beginUsageAccounting(lease, tokens(10)));
		old.recordUsage({ inputTokens: 20 });
		old.flushUsage();
		old.stopUsageClock();
		runtime.suspendBoundAttempt({ ...lease, reasonCode: "shutdown" });
		runtime.requestAgentResume(agent.agentId, lease.attemptId);
		const resumed = runtime.resumeAttempt(lease.attemptId, agent.agentId, 60_000, "resumed-owner");
		runtime.startAttempt(resumed.attemptId, resumed.leaseId, resumed.fencingToken);
		const current = new CapabilityGateway({ grant, cwd: process.cwd(), now: () => 100 });
		// A stale caller baseline is ignored after canonical accounting exists.
		current.bindUsageAccounting(lifecycle.beginUsageAccounting(resumed, tokens(999)));
		current.recordUsage({ inputTokens: 20 });
		current.flushUsage();
		const beforeLate = runtime.getSnapshot();
		old.recordUsage({ inputTokens: 80 });
		old.flushUsage();
		expect(current.getUsage().totalTokens).toBe(130);
		expect(lifecycle.ledger.getAttemptUsage(lease.attemptId)).toEqual(tokens(130));
		current.flushUsage();
		expect(
			runtime.getSnapshot().attempts[lease.attemptId].usageAccounting?.generations[resumed.leaseId].reported,
		).toEqual(tokens(50));
		expect(runtime.getSnapshot().agents).toEqual(beforeLate.agents);
		expect(runtime.getSnapshot().checkpoints).toEqual(beforeLate.checkpoints);
		expect(runtime.getSnapshot().attempts[lease.attemptId].lease).toEqual(resumed);
		expect(() => lifecycle.checkpoint(lease, { summary: "stale execution" })).toThrow("stale");
	});

	it("restores canonical late receipts instead of reimporting unattributed transcript totals", () => {
		const { lifecycle, runtime, conversation, recovery, agent, lease } = fixture();
		runtime.checkpointAttempt({ ...lease, summary: "legacy usage", usage: tokens(10) });
		runtime.beginAttemptUsage(lease, tokens(10));
		runtime.recordAttemptUsage(lease, tokens(30));
		conversation.appendMessage({
			...fauxAssistantMessage("receipt not yet attributed"),
			usage: providerUsageFromAttemptUsage(tokens(100)),
		});
		const readTranscript = vi.spyOn(conversation, "getRawTranscriptUsage");
		expect(recovery.initialUsage(conversation, tokens(10), lease.attemptId)).toEqual(tokens(30));
		expect(readTranscript).not.toHaveBeenCalled();
		runtime.suspendBoundAttempt({ ...lease, reasonCode: "shutdown" });
		runtime.requestAgentResume(agent.agentId, lease.attemptId);
		const resumed = runtime.resumeAttempt(lease.attemptId, agent.agentId, 60_000, "resumed-owner");
		runtime.startAttempt(resumed.attemptId, resumed.leaseId, resumed.fencingToken);
		expect(runtime.beginAttemptUsage(resumed)).toEqual(tokens(30));
		runtime.recordAttemptUsage(resumed, tokens(50));
		runtime.recordAttemptUsage(lease, tokens(110));
		const expected = tokens(130);
		expect(lifecycle.ledger.getAttemptUsage(lease.attemptId)).toEqual(expected);
		expect(recovery.initialUsage(conversation, tokens(10), lease.attemptId)).toEqual(expected);
		expect(collectWorkerTreeBudgetSeeds(runtime.getSnapshot(), agent.rootAgentId)).toEqual([
			{ attemptId: lease.attemptId, usage: expected },
		]);
		expect(readTranscript).not.toHaveBeenCalled();
		const detached = lifecycle.ledger.getAttemptUsage(lease.attemptId)!;
		detached.totalTokens = 0;
		expect(lifecycle.ledger.getAttemptUsage(lease.attemptId)).toEqual(expected);
	});

	it.each([false, true])(
		"counts received usage through a real resumed lease before old retry: failed=%s",
		(failed) => {
			vi.useFakeTimers();
			try {
				const { lifecycle, runtime, agent, lease } = fixture();
				const coordinator = new WorkerTreeBudgetCoordinator();
				const budget = { maxTokens: 100 };
				const sibling = coordinator.createPort({
					rootAgentId: agent.rootAgentId,
					attemptId: "sibling",
					budget,
					seeds: [],
					initialUsage: tokens(0),
				});
				const createGateway = (handle: typeof lease, failWrite: boolean) => {
					const port = lifecycle.beginUsageAccounting(handle, tokens(0));
					const shared = coordinator.createPort({
						rootAgentId: agent.rootAgentId,
						attemptId: handle.attemptId,
						budget,
						seeds: collectWorkerTreeBudgetSeeds(runtime.getSnapshot(), agent.rootAgentId),
						initialUsage: port.baseline,
					});
					const gateway = new CapabilityGateway({
						grant: {
							...createTestExecutionGrant({ objectiveId: "o", taskId: "t", attemptId: handle.attemptId }),
							budget: { maxTokens: 30 },
						},
						cwd: process.cwd(),
						now: () => 100,
						sharedBudget: shared,
					});
					const record = vi.fn(port.record);
					if (failWrite)
						record.mockImplementationOnce(() => {
							throw new Error("old receipt write unavailable");
						});
					gateway.bindUsageAccounting(
						new WorkerUsageAccounting({
							port: { ...port, record },
							warn: vi.fn(),
							label: handle.leaseId,
							afterRecord: () => gateway.publishUsage(),
						}),
					);
					return gateway;
				};
				const old = createGateway(lease, failed);
				old.recordUsage({ inputTokens: 10 });
				old.stopUsageClock();
				if (failed) expect(() => old.flushUsage()).toThrow("old receipt write unavailable");
				else old.flushUsage();
				expect(sibling.remainingTokens()).toBe(90);
				runtime.suspendBoundAttempt({ ...lease, reasonCode: "shutdown" });
				runtime.requestAgentResume(agent.agentId, lease.attemptId);
				const resumed = runtime.resumeAttempt(lease.attemptId, agent.agentId, 60_000, "new-owner");
				runtime.startAttempt(resumed.attemptId, resumed.leaseId, resumed.fencingToken);
				const current = createGateway(resumed, false);
				current.recordUsage({ inputTokens: 20 });
				current.stopUsageClock();
				current.flushUsage();
				expect(lifecycle.ledger.getAttemptUsage(lease.attemptId)?.totalTokens).toBe(failed ? 20 : 30);
				expect(sibling.remainingTokens()).toBe(70);
				expect(current.remainingAttemptTokenBudget()).toBe(0);
				expect(() => current.assertBudgetAvailable()).toThrow("Token budget exhausted");
				vi.advanceTimersByTime(250);
				expect(lifecycle.ledger.getAttemptUsage(lease.attemptId)?.totalTokens).toBe(30);
				expect(sibling.remainingTokens()).toBe(70);
				expect(runtime.getSnapshot().attempts[lease.attemptId].lease).toEqual(resumed);
				expect(() => lifecycle.checkpoint(lease, { summary: "old execution" })).toThrow("stale");
			} finally {
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		},
	);

	it("retains legacy checkpoint and transcript reconciliation before accounting is registered", () => {
		const { lifecycle, runtime, conversation, recovery, agent, lease } = fixture();
		const checkpoint = { ...tokens(10), activeWallClockMs: 40 };
		runtime.checkpointAttempt({ ...lease, summary: "legacy usage", usage: checkpoint });
		conversation.appendMessage({
			...fauxAssistantMessage("legacy result"),
			usage: providerUsageFromAttemptUsage(tokens(20)),
		});
		expect(lifecycle.ledger.getAttemptUsage(lease.attemptId)).toEqual(checkpoint);
		expect(collectWorkerTreeBudgetSeeds(runtime.getSnapshot(), agent.rootAgentId)).toEqual([
			{ attemptId: lease.attemptId, usage: checkpoint },
		]);
		expect(recovery.initialUsage(conversation, checkpoint, lease.attemptId)).toEqual({
			...tokens(20),
			activeWallClockMs: 40,
		});
	});

	it("keeps zero usage and tree membership for an admitted attempt without a checkpoint", () => {
		const { lifecycle, runtime, conversation, recovery, agent, lease } = fixture();
		expect(lifecycle.ledger.getAttemptUsage(lease.attemptId)).toBeUndefined();
		expect(recovery.initialUsage(conversation, undefined, lease.attemptId)).toEqual(EMPTY_ATTEMPT_USAGE);
		expect(collectWorkerTreeBudgetSeeds(runtime.getSnapshot(), agent.rootAgentId)).toEqual([
			{ attemptId: lease.attemptId, usage: EMPTY_ATTEMPT_USAGE },
		]);
		expect(collectWorkerTreeBudgetSeeds(runtime.getSnapshot(), "unrelated-root")).toEqual([]);
	});
});
