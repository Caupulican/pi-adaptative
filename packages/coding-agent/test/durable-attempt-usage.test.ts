import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EMPTY_ATTEMPT_USAGE } from "../src/core/orchestration/attempt-usage.ts";
import { toJsonObject } from "../src/core/orchestration/contracts.ts";
import { OrchestrationEventStore } from "../src/core/orchestration/event-store.ts";
import { DurableTaskRuntime, reduceOrchestrationEvent } from "../src/core/orchestration/task-runtime.ts";
import { projectionFromSnapshot } from "../src/core/orchestration/task-runtime-codecs.ts";
import { type FaultableFs, nodeFs } from "../src/core/util/faultable-fs.ts";

const directories: string[] = [];
const tokens = (totalTokens: number) => ({ ...EMPTY_ATTEMPT_USAGE, inputTokens: totalTokens, totalTokens });

function setup(maxTailEvents?: number, fs?: FaultableFs) {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-attempt-usage-"));
	directories.push(agentDir);
	const clock = { ms: Date.parse("2026-09-18T00:00:00.000Z") };
	const store = new OrchestrationEventStore({
		agentDir,
		sessionId: "accounting",
		now: () => new Date(clock.ms).toISOString(),
		maxTailEvents,
		fs,
	});
	const runtime = new DurableTaskRuntime({ store, now: () => clock.ms });
	const objective = runtime.createObjective({ title: "Usage", description: "Retain received charges" });
	const task = runtime.createTask({
		objectiveId: objective.objectiveId,
		title: "Worker",
		description: "Account across suspension",
		role: "implementer",
	});
	const agent = runtime.registerAgent({
		role: "implementer",
		resumeContext: {
			provider: "pi",
			sessionId: "worker",
			cwd: agentDir,
			resourceProfileNames: [],
			contextPointers: [],
		},
	});
	const attempt = runtime.queueAttempt(
		task.taskId,
		{ taskId: task.taskId, profileId: "worker", instructions: "Do work", resourcePointerIds: [] },
		"grant",
	);
	const lease = runtime.leaseAttempt(attempt.attemptId, "owner", 60_000, agent.agentId);
	runtime.startAttempt(lease.attemptId, lease.leaseId, lease.fencingToken);
	return { runtime, store, agent, lease, clock };
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("durable usage independent of execution authority", () => {
	it("persists distinct parent receipts for a recovered baseline and later charges without replaying completion", () => {
		const { runtime, store, lease } = setup(1);
		runtime.beginAttemptUsage(lease, tokens(5));
		runtime.recordAttemptUsage(lease, tokens(15));
		runtime.cancelAttempt(lease.attemptId, "owner cancelled");
		const beforeLate = runtime.getSnapshot();
		runtime.recordAttemptUsage(lease, tokens(18));
		const pending = Object.values(runtime.getSnapshot().attempts[lease.attemptId].usageReceipts ?? {});
		expect(pending.map((receipt) => [receipt.kind, receipt.usage.totalTokens])).toEqual([
			["baseline", 5],
			["increase", 10],
			["increase", 3],
		]);
		expect(new Set(pending.map((receipt) => receipt.receiptId)).size).toBe(3);
		expect(runtime.getSnapshot().notifications).toEqual(beforeLate.notifications);
		expect(runtime.getSnapshot().attempts[lease.attemptId].status).toBe("cancelled");
		const restarted = new DurableTaskRuntime({ store });
		expect(Object.values(restarted.getSnapshot().attempts[lease.attemptId].usageReceipts ?? {})).toEqual(pending);
		restarted.acknowledgeUsageReceipt(lease.attemptId, pending[0].receiptId);
		const acknowledged = restarted.getSnapshot();
		restarted.acknowledgeUsageReceipt(lease.attemptId, pending[0].receiptId);
		expect(restarted.getSnapshot()).toBe(acknowledged);
		expect(Object.values(acknowledged.attempts[lease.attemptId].usageReceipts ?? {})).toEqual(pending.slice(1));
		expect(acknowledged.attempts[lease.attemptId].usageAccounting?.total.totalTokens).toBe(18);
		expect(acknowledged.notifications).toEqual(beforeLate.notifications);
		expect(new DurableTaskRuntime({ store }).getSnapshot()).toEqual(acknowledged);
	});

	it("keeps parent receipts pending on failed acknowledgement and does not bill clock-only advances", () => {
		const { runtime, store, lease } = setup();
		runtime.beginAttemptUsage(lease, tokens(0));
		runtime.recordAttemptUsage(lease, { ...tokens(0), activeWallClockMs: 10 });
		expect(runtime.getSnapshot().attempts[lease.attemptId].usageReceipts).toBeUndefined();
		runtime.recordAttemptUsage(lease, { ...tokens(2), activeWallClockMs: 15 });
		const pending = Object.values(runtime.getSnapshot().attempts[lease.attemptId].usageReceipts ?? {});
		expect(pending).toHaveLength(1);
		vi.spyOn(store, "append").mockImplementationOnce(() => {
			throw new Error("ack write failed");
		});
		expect(() => runtime.acknowledgeUsageReceipt(lease.attemptId, pending[0].receiptId)).toThrow("ack write failed");
		expect(Object.values(runtime.getSnapshot().attempts[lease.attemptId].usageReceipts ?? {})).toEqual(pending);
		runtime.acknowledgeUsageReceipt(lease.attemptId, pending[0].receiptId);
		expect(runtime.getSnapshot().attempts[lease.attemptId].usageReceipts).toEqual({});
	});

	it("rejects forged receipt identities and inflated pending totals when restoring a snapshot", () => {
		const { runtime, lease } = setup();
		runtime.beginAttemptUsage(lease, tokens(0));
		runtime.recordAttemptUsage(lease, tokens(10));
		const snapshot = runtime.getSnapshot();
		const [receiptId] = Object.keys(snapshot.attempts[lease.attemptId].usageReceipts!);
		for (const field of ["receiptId", "leaseId"] as const) {
			const corrupt = structuredClone(snapshot);
			const receipts = { ...corrupt.attempts[lease.attemptId].usageReceipts };
			receipts[receiptId] = { ...receipts[receiptId]!, [field]: "forged" };
			corrupt.attempts[lease.attemptId].usageReceipts = receipts;
			expect(() => projectionFromSnapshot(toJsonObject(corrupt), corrupt.lastOrdinal)).toThrow(/receipt/);
		}
		const inflated = structuredClone(snapshot);
		inflated.attempts[lease.attemptId].usageReceipts = {
			[receiptId]: { ...inflated.attempts[lease.attemptId].usageReceipts![receiptId], usage: tokens(11) },
		};
		expect(() => projectionFromSnapshot(toJsonObject(inflated), inflated.lastOrdinal)).toThrow(/exceed/);
		expect(runtime.getSnapshot()).toBe(snapshot);
	});

	it("retains interleaved late receipts through suspension, resume, restart and cancellation", () => {
		const { runtime, store, agent, lease } = setup(1);
		expect(runtime.beginAttemptUsage(lease, tokens(0)).totalTokens).toBe(0);
		runtime.recordAttemptUsage(lease, tokens(100));
		runtime.suspendBoundAttempt({ ...lease, reasonCode: "shutdown" });
		const suspended = runtime.getSnapshot();
		runtime.recordAttemptUsage(lease, tokens(110));
		expect(runtime.getSnapshot().agents).toEqual(suspended.agents);
		expect(runtime.getSnapshot().attempts[lease.attemptId].status).toBe("suspended");
		expect(() => runtime.checkpointAttempt({ ...lease, summary: "stale progress" })).toThrow("not running");
		runtime.requestAgentResume(agent.agentId, lease.attemptId);
		const resumed = runtime.resumeAttempt(lease.attemptId, agent.agentId, 60_000, "new-owner");
		runtime.startAttempt(resumed.attemptId, resumed.leaseId, resumed.fencingToken);
		expect(runtime.beginAttemptUsage(resumed).totalTokens).toBe(110);
		runtime.recordAttemptUsage(resumed, tokens(160));
		const beforeLate = runtime.getSnapshot();
		runtime.recordAttemptUsage(lease, tokens(120));
		const afterLate = runtime.getSnapshot();
		expect(afterLate.attempts[lease.attemptId].usageAccounting?.total.totalTokens).toBe(170);
		expect(afterLate.agents).toEqual(beforeLate.agents);
		expect(afterLate.checkpoints).toEqual(beforeLate.checkpoints);
		expect(afterLate.attempts[lease.attemptId].lease).toEqual(resumed);
		expect(() => runtime.checkpointAttempt({ ...lease, summary: "stale progress" })).toThrow("stale");
		runtime.checkpointAttempt({ ...resumed, summary: "current progress" });
		const restarted = new DurableTaskRuntime({ store });
		const beforeReplay = restarted.getSnapshot();
		expect(restarted.recordAttemptUsage(lease, tokens(120)).totalTokens).toBe(170);
		expect(restarted.getSnapshot()).toBe(beforeReplay);
		restarted.cancelAttempt(lease.attemptId, "finished session");
		const cancelled = restarted.getSnapshot();
		expect(restarted.recordAttemptUsage(resumed, tokens(180)).totalTokens).toBe(190);
		expect(restarted.getSnapshot().attempts[lease.attemptId].status).toBe("cancelled");
		expect(restarted.getSnapshot().tasks).toEqual(cancelled.tasks);
		const final = restarted.getSnapshot();
		expect(projectionFromSnapshot(toJsonObject(final), final.lastOrdinal)).toEqual(final);
	});

	it("does not admit new accounting identities after fencing or lease expiration", () => {
		const { runtime, lease, clock } = setup();
		const initial = runtime.getSnapshot();
		expect(() => runtime.recordAttemptUsage(lease, tokens(10))).toThrow("not registered");
		expect(() => runtime.beginAttemptUsage({ ...lease, fencingToken: lease.fencingToken + 1 }, tokens(0))).toThrow(
			"stale",
		);
		expect(runtime.getSnapshot()).toBe(initial);
		clock.ms += 60_001;
		expect(() => runtime.beginAttemptUsage(lease, tokens(0))).toThrow(/expired/);
		expect(runtime.getSnapshot()).toBe(initial);
	});

	it("retains exactly one charge when append succeeds but its acknowledgment is lost", () => {
		const { runtime, store, lease } = setup();
		runtime.beginAttemptUsage(lease, tokens(0));
		const append = store.append.bind(store);
		vi.spyOn(store, "append").mockImplementationOnce((input, options) => {
			append(input, options);
			throw new Error("lost acknowledgment");
		});
		expect(() => runtime.recordAttemptUsage(lease, tokens(10))).toThrow("lost acknowledgment");
		const restarted = new DurableTaskRuntime({ store });
		const committed = restarted.getSnapshot();
		const receipts = Object.values(committed.attempts[lease.attemptId].usageReceipts ?? {});
		expect(receipts).toHaveLength(1);
		expect(receipts[0].usage).toEqual(tokens(10));
		expect(receipts[0].receiptId).toBe(store.readAll().at(-1)!.eventId);
		expect(restarted.recordAttemptUsage(lease, tokens(10)).totalTokens).toBe(10);
		expect(restarted.getSnapshot()).toBe(committed);
		expect(runtime.recordAttemptUsage(lease, tokens(20)).totalTokens).toBe(20);
	});

	it("reconstructs the same receipt from the committed event when the cursor write fails", () => {
		let failCursor = false;
		const fs: FaultableFs = {
			...nodeFs,
			writeFileSync: (path, data, options) => {
				if (failCursor && basename(path) === "cursor.json") {
					failCursor = false;
					throw new Error("cursor unavailable");
				}
				nodeFs.writeFileSync(path, data, options);
			},
		};
		const { runtime, store, lease } = setup(undefined, fs);
		runtime.beginAttemptUsage(lease, tokens(0));
		failCursor = true;
		expect(() => runtime.recordAttemptUsage(lease, tokens(10))).toThrow("cursor unavailable");
		// Restart with a fresh store and default filesystem: neither in-process projection nor store indexes survive.
		const freshStore = new OrchestrationEventStore({ agentDir: directories.at(-1)!, sessionId: "accounting" });
		const restarted = new DurableTaskRuntime({ store: freshStore });
		const committed = restarted.getSnapshot();
		const receipt = Object.values(committed.attempts[lease.attemptId].usageReceipts ?? {});
		expect(receipt).toHaveLength(1);
		expect(receipt[0].usage).toEqual(tokens(10));
		expect(receipt[0].receiptId).toBe(store.readAll().at(-1)!.eventId);
		expect(restarted.recordAttemptUsage(lease, tokens(10))).toEqual(tokens(10));
		expect(restarted.getSnapshot()).toBe(committed);
		expect(committed.attempts[lease.attemptId].usageAccounting?.total).toEqual(tokens(10));
	});

	it("replays registration with its original baseline after losing the commit acknowledgment", () => {
		const { runtime, store, lease } = setup();
		const append = store.append.bind(store);
		vi.spyOn(store, "append").mockImplementationOnce((input, options) => {
			append(input, options);
			throw new Error("registration acknowledgment lost");
		});
		expect(() => runtime.beginAttemptUsage(lease, tokens(10))).toThrow("registration acknowledgment lost");
		const registered = runtime.getSnapshot();
		expect(runtime.beginAttemptUsage(lease, tokens(10))).toEqual(tokens(10));
		expect(runtime.getSnapshot()).toBe(registered);
		runtime.recordAttemptUsage(lease, tokens(30));
		const reported = runtime.getSnapshot();
		expect(runtime.beginAttemptUsage(lease, tokens(10))).toEqual(tokens(10));
		expect(() => runtime.beginAttemptUsage(lease, tokens(30))).toThrow("conflicting baseline");
		expect(runtime.getSnapshot()).toBe(reported);
	});

	it("retains the old state on a failed durable write and accepts the same report after recovery", () => {
		const { runtime, store, lease } = setup();
		runtime.beginAttemptUsage(lease, tokens(0));
		const before = runtime.getSnapshot();
		vi.spyOn(store, "append").mockImplementationOnce(() => {
			throw new Error("disk unavailable");
		});
		expect(() => runtime.recordAttemptUsage(lease, tokens(10))).toThrow("disk unavailable");
		expect(runtime.getSnapshot()).toBe(before);
		expect(runtime.recordAttemptUsage(lease, tokens(10)).totalTokens).toBe(10);
	});

	it("rejects forged replay identities and corrupted snapshots without changing the source state", () => {
		const { runtime, store, lease } = setup();
		runtime.beginAttemptUsage(lease, tokens(0));
		runtime.recordAttemptUsage(lease, tokens(10));
		const snapshot = runtime.getSnapshot();
		const event = store.readAll().at(-1)!;
		expect(() =>
			reduceOrchestrationEvent(snapshot, {
				...event,
				ordinal: snapshot.lastOrdinal + 1,
				payload: { ...event.payload, leaseId: "unregistered" },
			}),
		).toThrow("not registered");
		const corrupted = structuredClone(snapshot);
		corrupted.attempts[lease.attemptId].usageAccounting!.total.totalTokens++;
		expect(() => projectionFromSnapshot(toJsonObject(corrupted), corrupted.lastOrdinal)).toThrow(/accounting total/);
		expect(runtime.getSnapshot()).toBe(snapshot);
	});
});
