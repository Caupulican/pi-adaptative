import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentState } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { createEmptyUsage } from "@caupulican/pi-agent-core/usage";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerUsageReceiptDelivery } from "../src/core/delegation/worker-usage-receipt-delivery.ts";
import { EMPTY_ATTEMPT_USAGE, providerUsageFromAttemptUsage } from "../src/core/orchestration/attempt-usage.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime } from "../src/core/orchestration/task-runtime.ts";
import { SessionAnalytics } from "../src/core/session-analytics.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";

const directories: string[] = [];
const deliveries: WorkerUsageReceiptDelivery[] = [];
const tokens = (totalTokens: number) => ({ ...EMPTY_ATTEMPT_USAGE, inputTokens: totalTokens, totalTokens });

function analyticsFor(parent: SessionManager, directory: string): SessionAnalytics {
	return new SessionAnalytics({
		getState: () => ({ messages: [] }) as unknown as AgentState,
		getMessages: () => [],
		getModel: () => undefined,
		getSessionManager: () => parent,
		getSettingsManager: () => SettingsManager.inMemory(),
		getToolDefinition: () => undefined,
		getToolRecoveryEventLogPath: () => join(directory, "recovery.jsonl"),
		getAgentDir: () => directory,
	});
}

function setup() {
	const directory = mkdtempSync(join(tmpdir(), "pi-worker-receipt-delivery-"));
	directories.push(directory);
	const parent = SessionManager.create(directory, directory, join(directory, "sessions"));
	const parentSessionId = parent.getSessionId();
	const store = new OrchestrationEventStore({ agentDir: directory, sessionId: parentSessionId });
	const runtime = new DurableTaskRuntime({ store });
	const objective = runtime.createObjective({ title: "Usage", description: "Report paid work" });
	const task = runtime.createTask({
		objectiveId: objective.objectiveId,
		title: "Worker",
		description: "Run",
		role: "implementer",
	});
	const attempt = runtime.queueAttempt(
		task.taskId,
		{ taskId: task.taskId, profileId: "worker", instructions: "Run", resourcePointerIds: [] },
		"grant",
	);
	const lease = runtime.leaseAttempt(attempt.attemptId, "owner", 60_000);
	runtime.startAttempt(lease.attemptId, lease.leaseId, lease.fencingToken);
	const analytics = analyticsFor(parent, directory);
	const state = { disposed: false };
	const deliver = vi.fn(analytics.deliverSpawnedUsageReceipt.bind(analytics));
	const warn = vi.fn();
	const connect = (owner = runtime, events = store) => {
		const delivery = new WorkerUsageReceiptDelivery({
			parentSessionId,
			runtime: owner,
			subscribe: (listener) => events.subscribe(listener),
			deliver,
			isDisposed: () => state.disposed,
			warn,
		});
		deliveries.push(delivery);
		return delivery;
	};
	const flushParent = () =>
		parent.appendMessage({
			role: "assistant",
			content: [],
			api: "messages",
			provider: "anthropic",
			model: "test",
			usage: createEmptyUsage(),
			stopReason: "stop",
			timestamp: Date.now(),
		});
	const pending = (owner = runtime) =>
		Object.values(owner.getSnapshot().attempts[lease.attemptId].usageReceipts ?? {});
	return {
		directory,
		parent,
		parentSessionId,
		store,
		runtime,
		task,
		lease,
		analytics,
		state,
		deliver,
		warn,
		connect,
		flushParent,
		pending,
	};
}

afterEach(() => {
	for (const delivery of deliveries.splice(0)) delivery.dispose();
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("worker usage receipt delivery", () => {
	it("retains a failed parent append behind the native session fence until explicit reload", async () => {
		vi.useFakeTimers();
		try {
			const { runtime, lease, parent, analytics, connect, flushParent, pending, deliver } = setup();
			flushParent();
			const delivery = connect();
			const append = vi.spyOn(parent, "appendCustomEntry");
			const file = parent.getSessionFile()!;
			const contents = readFileSync(file);
			// Fault below the real SessionManager, which fences uncertain writes. Mocking
			// appendCustomEntry itself would bypass that mandatory owner and invent safe retry.
			rmSync(file);
			mkdirSync(file);
			runtime.beginAttemptUsage(lease, tokens(0));
			runtime.recordAttemptUsage(lease, tokens(10));
			await Promise.resolve();
			expect(pending()).toHaveLength(1);
			expect(deliver).toHaveBeenCalledOnce();
			expect(analytics.getCumulativeUsage().totalTokens).toBe(0);
			expect(append.mock.results[0].type).toBe("throw");
			rmSync(file, { recursive: true });
			writeFileSync(file, contents);
			// Restoring the file does not clear uncertain-write ownership. A blind retry
			// must remain fenced, not duplicate a possibly persisted suffix.
			await vi.advanceTimersByTimeAsync(60_000);
			expect(deliver).toHaveBeenCalledOnce();
			delivery.signal();
			await Promise.resolve();
			expect(pending()).toHaveLength(1);
			expect(append.mock.results[1].value).toEqual(
				expect.objectContaining({ message: expect.stringContaining("uncertain") }),
			);
			expect(analytics.getCumulativeUsage().totalTokens).toBe(0);
			parent.setSessionFile(file);
			delivery.signal();
			await Promise.resolve();
			expect(pending()).toHaveLength(0);
			expect(deliver).toHaveBeenCalledTimes(3);
			expect(append).toHaveBeenCalledTimes(3);
			expect(analytics.getCumulativeUsage().totalTokens).toBe(10);
			await vi.advanceTimersByTimeAsync(60_000);
			expect(deliver).toHaveBeenCalledTimes(3);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("delivers after commit adoption and leaves execution/completion state alone, including late charges", async () => {
		const { runtime, lease, analytics, connect, flushParent, pending, deliver } = setup();
		flushParent();
		connect();
		runtime.beginAttemptUsage(lease, tokens(0));
		runtime.recordAttemptUsage(lease, tokens(10));
		expect(deliver).not.toHaveBeenCalled();
		expect(pending()).toHaveLength(1);
		await Promise.resolve();
		expect(pending()).toHaveLength(0);
		expect(analytics.getCumulativeUsage().totalTokens).toBe(10);
		runtime.cancelAttempt(lease.attemptId, "cancelled");
		const terminal = runtime.getSnapshot();
		runtime.recordAttemptUsage(lease, tokens(15));
		await Promise.resolve();
		expect(pending()).toHaveLength(0);
		expect(analytics.getCumulativeUsage().totalTokens).toBe(15);
		expect(runtime.getSnapshot().attempts[lease.attemptId].status).toBe("cancelled");
		expect(runtime.getSnapshot().notifications).toEqual(terminal.notifications);
		expect(runtime.getSnapshot().tasks).toEqual(terminal.tasks);
		runtime.recordAttemptUsage(lease, tokens(15));
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledTimes(2);
	});

	it("retains buffered parent receipts without busy retrying and drains them on a persistence boundary", async () => {
		const { runtime, lease, analytics, connect, flushParent, pending, deliver } = setup();
		const delivery = connect();
		runtime.beginAttemptUsage(lease, tokens(0));
		runtime.recordAttemptUsage(lease, tokens(10));
		runtime.recordAttemptUsage(lease, tokens(15));
		await Promise.resolve();
		expect(pending()).toHaveLength(2);
		expect(deliver).toHaveBeenCalledTimes(2);
		expect(analytics.getCumulativeUsage().totalTokens).toBe(15);
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledTimes(2);
		flushParent();
		delivery.signal();
		await Promise.resolve();
		expect(pending()).toHaveLength(0);
		expect(analytics.getCumulativeUsage().totalTokens).toBe(15);
	});

	it("replays a persisted parent receipt after acknowledgement failure without charging it twice", async () => {
		const { directory, parent, parentSessionId, runtime, lease, analytics, connect, flushParent, pending, warn } =
			setup();
		flushParent();
		const delivery = connect();
		runtime.beginAttemptUsage(lease, tokens(0));
		runtime.recordAttemptUsage(lease, tokens(10));
		vi.spyOn(runtime, "acknowledgeUsageReceipt").mockImplementationOnce(() => {
			throw new Error("ack unavailable");
		});
		await Promise.resolve();
		expect(pending()).toHaveLength(1);
		expect(analytics.getCumulativeUsage().totalTokens).toBe(10);
		expect(warn).toHaveBeenCalled();
		delivery.dispose();
		const reopenedStore = new OrchestrationEventStore({ agentDir: directory, sessionId: parentSessionId });
		const reopenedRuntime = new DurableTaskRuntime({ store: reopenedStore });
		// Reconstruct BOTH owners: keeping the original analytics would hide reload/dedupe defects.
		const reopenedParent = SessionManager.open(parent.getSessionFile()!, directory);
		const reopenedAnalytics = analyticsFor(reopenedParent, directory);
		const recoveredDelivery = new WorkerUsageReceiptDelivery({
			parentSessionId,
			runtime: reopenedRuntime,
			subscribe: (listener) => reopenedStore.subscribe(listener),
			deliver: (usage, options) => reopenedAnalytics.deliverSpawnedUsageReceipt(usage, options),
			isDisposed: () => false,
			warn,
		});
		deliveries.push(recoveredDelivery);
		await Promise.resolve();
		expect(pending(reopenedRuntime)).toHaveLength(0);
		expect(reopenedAnalytics.getCumulativeUsage().totalTokens).toBe(10);
		expect(reopenedParent.getEntryCount()).toBe(parent.getEntryCount());
		// Negative control: a new charge after restart must not be mistaken for the replay.
		reopenedRuntime.recordAttemptUsage(lease, tokens(15));
		await Promise.resolve();
		expect(pending(reopenedRuntime)).toHaveLength(0);
		expect(reopenedAnalytics.getCumulativeUsage().totalTokens).toBe(15);
		expect(reopenedParent.getEntryCount()).toBe(parent.getEntryCount() + 1);
	});

	it("deduplicates a matching legacy baseline and retains a conflicting baseline ahead of its deltas", async () => {
		const { runtime, task, lease, analytics, parentSessionId, connect, flushParent, pending } = setup();
		flushParent();
		analytics.addSpawnedUsage(providerUsageFromAttemptUsage(tokens(5)), {
			reportId: `worker:${parentSessionId}:${task.taskId}`,
		});
		const delivery = connect();
		runtime.beginAttemptUsage(lease, tokens(5));
		runtime.recordAttemptUsage(lease, tokens(12));
		await Promise.resolve();
		expect(pending()).toHaveLength(0);
		expect(analytics.getCumulativeUsage().totalTokens).toBe(12);
		delivery.dispose();
		const conflicting = setup();
		conflicting.flushParent();
		conflicting.analytics.addSpawnedUsage(providerUsageFromAttemptUsage(tokens(20)), {
			reportId: `worker:${conflicting.parentSessionId}:${conflicting.task.taskId}`,
		});
		conflicting.connect();
		conflicting.runtime.beginAttemptUsage(conflicting.lease, tokens(5));
		conflicting.runtime.recordAttemptUsage(conflicting.lease, tokens(12));
		const snapshot = conflicting.runtime.getSnapshot();
		const attempt = snapshot.attempts[conflicting.lease.attemptId];
		vi.spyOn(conflicting.runtime, "getSnapshot").mockReturnValue({
			...snapshot,
			attempts: {
				...snapshot.attempts,
				[attempt.attemptId]: {
					...attempt,
					usageReceipts: Object.fromEntries(Object.entries(attempt.usageReceipts!).reverse()),
				},
			},
		});
		await Promise.resolve();
		expect(conflicting.pending()).toHaveLength(2);
		expect(conflicting.analytics.getCumulativeUsage().totalTokens).toBe(20);
		expect(conflicting.warn).toHaveBeenCalled();
	});

	it("keeps pending receipts on disposal or parent replacement and cancels queued delivery", async () => {
		const { runtime, lease, connect, deliver, pending, state, parent } = setup();
		const delivery = connect();
		runtime.beginAttemptUsage(lease, tokens(0));
		runtime.recordAttemptUsage(lease, tokens(10));
		state.disposed = true;
		await Promise.resolve();
		expect(deliver).not.toHaveBeenCalled();
		expect(pending()).toHaveLength(1);
		state.disposed = false;
		parent.newSession();
		delivery.signal();
		await Promise.resolve();
		expect(deliver.mock.results.at(-1)?.value).toBe("foreign_session");
		expect(parent.getEntries()).toHaveLength(0);
		expect(pending()).toHaveLength(1);
		delivery.signal();
		delivery.dispose();
		const calls = deliver.mock.calls.length;
		runtime.recordAttemptUsage(lease, tokens(12));
		await Promise.resolve();
		expect(deliver).toHaveBeenCalledTimes(calls);
		expect(pending()).toHaveLength(2);
	});
});
