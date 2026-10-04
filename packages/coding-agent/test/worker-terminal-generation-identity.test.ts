// @isolated: fixed system clock and real AgentSession harnesses.
import type { CustomMessage } from "@caupulican/pi-agent-core";
import { SessionManager } from "@caupulican/pi-agent-core/session";
import { fauxAssistantMessage } from "@caupulican/pi-ai/faux";
import type { AssistantMessage } from "@caupulican/pi-ai/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WorkerClaim, WorkerRequest } from "../src/core/autonomy/contracts.ts";
import { isLaneRecord, type LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import {
	appendWorkerClaimSnapshot,
	getLatestWorkerClaimSnapshot,
	getWorkerClaimSnapshotForAttempt,
} from "../src/core/delegation/session-worker-claim.ts";
import { WorkerConversation } from "../src/core/delegation/worker-conversation-store.ts";
import { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import {
	WorkerNotificationCoordinator,
	type WorkerTerminalHandoffRecord,
} from "../src/core/delegation/worker-notification-coordinator.ts";
import type {
	ForegroundRecoveryController,
	ForegroundSubmissionLease,
} from "../src/core/foreground-recovery-controller.ts";
import { ForegroundTerminalHandoffController } from "../src/core/foreground-terminal-handoff-controller.ts";
import { ORCHESTRATION_SCHEMA_VERSION } from "../src/core/orchestration/contracts.ts";
import type { AttemptRuntimeState } from "../src/core/orchestration/task-runtime-state.ts";
import { createTestManagedLaneDispatch } from "./managed-lane-fixture.ts";
import { setConcurrentResponses } from "./suite/concurrent-responses.ts";
import { createHarness, type Harness } from "./suite/harness.ts";

/**
 * A worker lane can run several generations (a managed lane is redispatched; a persistent worker
 * takes new tasks). Terminal observation and foreground delivery identify the exact generation by
 * its attempt, so two generations that end on the same clock tick with the same status and reason
 * are two terminals: observing one never consumes the other, and each is delivered with its own
 * claim. A record without an attempt identity never aliases one that has it.
 */

afterEach(() => vi.useRealTimers());

const AT = "2026-10-02T12:00:00.000Z";

function record(attemptId: string | undefined, overrides: Partial<LaneRecord> = {}): LaneRecord {
	return {
		laneId: "lane",
		type: "tmux-worker",
		status: "succeeded",
		completedAt: AT,
		reasonCode: "managed_worker_succeeded",
		...(attemptId ? { attemptId } : {}),
		...overrides,
	};
}

describe("one generation identity for terminal observation", () => {
	function createCoordinator() {
		const delivered: WorkerTerminalHandoffRecord[][] = [];
		const coordinator = new WorkerNotificationCoordinator({
			getWorkerRecords: () => [],
			emitStatus: () => {},
			notify: async (records) => {
				delivered.push([...records]);
				await new Promise<void>(() => {});
			},
			warn: () => {},
			markDurableDelivered: () => {},
		});
		return { coordinator, delivered };
	}

	it("observing one generation leaves a same-lane, same-tick generation unread", () => {
		const { coordinator } = createCoordinator();
		coordinator.recordTerminal(record("attempt-1"), "worker-terminal:attempt-1");
		coordinator.recordTerminal(record("attempt-2"), "worker-terminal:attempt-2");
		coordinator.observeTerminals([record("attempt-1")]);

		const outstanding = coordinator.getOutstandingRecords();
		expect(outstanding.map((entry) => [entry.attemptId, entry.observedAt !== undefined])).toEqual([
			["attempt-1", true],
			["attempt-2", false],
		]);
	});

	it("a record without attempt identity never aliases a known generation, either way", () => {
		const { coordinator } = createCoordinator();
		coordinator.recordTerminal(record("attempt-1"), "worker-terminal:attempt-1");
		coordinator.recordTerminal(record(undefined));
		coordinator.observeTerminals([record(undefined)]);

		expect(
			coordinator.getOutstandingRecords().map((entry) => [entry.attemptId, entry.observedAt !== undefined]),
		).toEqual([
			["attempt-1", false],
			[undefined, true],
		]);
	});

	it("a lane record's attempt identity is validated and preserved", () => {
		expect(isLaneRecord(record("attempt-1"))).toBe(true);
		expect(isLaneRecord({ ...record(undefined), attemptId: 42 })).toBe(false);
	});
});

describe("exact-generation claim lookup", () => {
	it("returns only a claim naming the generation, with its originating request preserved", () => {
		const session = SessionManager.inMemory();
		const request: WorkerRequest = {
			id: "lane",
			instructions: "do something",
			route: { tier: "cheap", risk: "read-only", confidence: 1, reasonCode: "r1", reasons: [] },
			envelope: { id: "envelope", capabilities: ["filesystem.read"] },
		};
		const claim = (summary: string, terminalAttemptId?: string): WorkerClaim => ({
			requestId: "lane",
			status: "completed",
			summary,
			changedFiles: [],
			...(terminalAttemptId ? { terminalAttemptId } : {}),
		});
		appendWorkerClaimSnapshot(session, claim("generation 1", "attempt-1"), request);
		appendWorkerClaimSnapshot(session, claim("generation 2", "attempt-2"));
		appendWorkerClaimSnapshot(session, claim("names no generation"));
		const entries = session.getEntries();

		expect(getWorkerClaimSnapshotForAttempt(entries, "lane", "attempt-1")).toMatchObject({
			claim: { summary: "generation 1", terminalAttemptId: "attempt-1" },
			request: { id: "lane" },
		});
		expect(getWorkerClaimSnapshotForAttempt(entries, "lane", "attempt-2")?.claim.summary).toBe("generation 2");
		expect(getWorkerClaimSnapshotForAttempt(entries, "lane", "attempt-3")).toBeUndefined();
		// A lane lookup without a generation keeps its latest-wins behavior.
		expect(getLatestWorkerClaimSnapshot(entries, "lane")?.claim.summary).toBe("names no generation");
	});
});

describe("one generation identity for foreground delivery", () => {
	function controller() {
		const started: Pick<CustomMessage<unknown>, "customType" | "content" | "display" | "details">[] = [];
		const foreground = {
			waitForIdle: async () => {},
			tryAcquireSubmission: () => ({}) as ForegroundSubmissionLease,
			releaseSubmission: () => {},
			getCurrentSubmissionEpoch: () => undefined,
		} as unknown as ForegroundRecoveryController;
		const handoffs = new ForegroundTerminalHandoffController({
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => undefined,
			startCustomMessageTurn: async (message) => {
				started.push(message);
				return { completion: Promise.resolve() };
			},
			enqueueCustomMessageTurn: async () => {},
			sendCustomMessage: async () => {},
			warn: () => {},
		});
		const deliveredAttempts = () =>
			started.flatMap((message) =>
				(message.details as { records: { attemptId?: string }[] }).records.map((entry) => entry.attemptId),
			);
		return { handoffs, deliveredAttempts };
	}

	const handoff = (attemptId: string | undefined): WorkerTerminalHandoffRecord => ({
		laneId: "lane",
		status: "succeeded",
		completedAt: AT,
		reasonCode: "managed_worker_succeeded",
		...(attemptId ? { attemptId } : {}),
	});

	it("delivers both same-lane, same-tick generations, and a repeated generation once", async () => {
		const { handoffs, deliveredAttempts } = controller();
		await handoffs.notifyWorkers([handoff("attempt-1"), handoff("attempt-2")]);
		await handoffs.notifyWorkers([handoff("attempt-1")]);
		expect(deliveredAttempts()).toEqual(["attempt-1", "attempt-2"]);
	});

	it("an identity-less record and a known generation are delivered separately", async () => {
		const { handoffs, deliveredAttempts } = controller();
		await handoffs.notifyWorkers([handoff(undefined), handoff("attempt-1")]);
		expect(deliveredAttempts()).toEqual([undefined, "attempt-1"]);
	});
});

describe("same-tick generations end to end", () => {
	function dispatch(harness: Harness, sequence: number): AttemptRuntimeState {
		harness.session.backgroundLanes.recordManagedLane({
			laneId: "lane",
			phase: "dispatch",
			dispatch: createTestManagedLaneDispatch({ sequence }),
		});
		const running = Object.values(harness.session.backgroundLanes.getTaskRuntimeSnapshot()?.attempts ?? {}).find(
			(attempt) => attempt.dispatch.dispatchSequence === sequence && attempt.status === "running",
		);
		if (!running) throw new Error(`Generation ${sequence} is not running.`);
		return running;
	}

	function finish(harness: Harness, summary: string): void {
		harness.session.backgroundLanes.recordManagedLane({
			laneId: "lane",
			phase: "terminal",
			status: "succeeded",
			summary,
		});
	}

	/** Resolves with the records of the next worker terminal handoff the session delivers. */
	function nextHandoff(harness: Harness): Promise<{ attemptId?: string; claim?: { summary?: string } }[]> {
		return new Promise((resolve) => {
			const unsubscribe = harness.session.subscribe((event) => {
				if (event.type !== "message_end") return;
				const message = event.message as { role?: string; customType?: string; details?: unknown };
				if (message.role !== "custom" || message.customType !== "background-worker-completion") return;
				unsubscribe();
				resolve((message.details as { records: { attemptId?: string; claim?: { summary?: string } }[] }).records);
			});
		});
	}

	async function sameTickHarness() {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(new Date(AT));
		const harness = await createHarness({
			settings: { workerDelegation: { enabled: false } },
			excludedToolNames: ["delegate"],
		});
		harness.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage("acknowledged")));
		return harness;
	}

	it("a wait captures generation 1; generation 2 stays unread and is delivered with its own claim", async () => {
		const harness = await sameTickHarness();
		try {
			const first = dispatch(harness, 1);
			const delivered = nextHandoff(harness);
			const wait = harness.session.backgroundLanes.waitForRunningAttempts([first.attemptId], { timeoutMs: 60_000 });
			finish(harness, "first generation");
			const second = dispatch(harness, 2);
			finish(harness, "second generation");

			expect(await wait).toEqual({ kind: "changed", attemptIds: [first.attemptId] });
			const records = await delivered;
			expect(records.map((entry) => entry.attemptId)).toEqual([second.attemptId]);
			expect(records[0]?.claim?.summary).toContain("second generation");
		} finally {
			await harness.cleanup();
		}
	});

	it("unobserved same-tick generations are both delivered, each with its own claim", async () => {
		const harness = await sameTickHarness();
		try {
			const first = dispatch(harness, 1);
			const delivered = nextHandoff(harness);
			finish(harness, "first generation");
			const second = dispatch(harness, 2);
			finish(harness, "second generation");

			const records = await delivered;
			expect(records.map((entry) => entry.attemptId)).toEqual([first.attemptId, second.attemptId]);
			expect(records[0]?.claim?.summary).toContain("first generation");
			expect(records[1]?.claim?.summary).toContain("second generation");
		} finally {
			await harness.cleanup();
		}
	});

	it("a known generation without its own claim is delivered with its terminal evidence and no unbound claim", async () => {
		const harness = await sameTickHarness();
		try {
			const first = dispatch(harness, 1);
			const lanes = harness.session.backgroundLanes as unknown as {
				_workerLifecycle: WorkerLifecycle;
				_recordWorkerTerminal(record: LaneRecord, notificationId: string): void;
			};
			const handle = lanes._workerLifecycle.getManagedHandle("lane");
			if (!handle) throw new Error("Generation 1 has no handle.");
			// Generation 1 ends without persisting a claim of its own.
			const ended = lanes._workerLifecycle.finish({
				schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
				resultId: `result-${first.attemptId}`,
				objectiveId: handle.objectiveId,
				taskId: handle.taskId,
				attemptId: first.attemptId,
				leaseId: handle.leaseId,
				fencingToken: handle.fencingToken,
				status: "completed",
				reasonCode: "worker_completed",
				summary: "first generation result",
				artifacts: [],
				evidence: [],
				errors: [],
				usage: { costUsd: 0, wallClockMs: 1, toolCalls: 0 },
				createdAt: AT,
			});
			// A newer claim on the same lane that names no generation.
			appendWorkerClaimSnapshot(harness.sessionManager, {
				requestId: "lane",
				status: "completed",
				summary: "unbound newer claim",
				changedFiles: [],
			});
			const notification = lanes._workerLifecycle.getAttemptTerminalNotification(first.attemptId);
			if (!notification) throw new Error("Generation 1 has no terminal notification.");
			const delivered = nextHandoff(harness);
			lanes._recordWorkerTerminal(ended, notification.notificationId);

			const records = await delivered;
			expect(records.map((entry) => entry.attemptId)).toEqual([first.attemptId]);
			expect(records[0]?.claim).toBeUndefined();
		} finally {
			await harness.cleanup();
		}
	});

	it("durable replay binds each pending notification to its own generation", async () => {
		const harness = await sameTickHarness();
		try {
			const first = dispatch(harness, 1);
			finish(harness, "first generation");
			const second = dispatch(harness, 2);
			finish(harness, "second generation");
			const lifecycle = (
				harness.session.backgroundLanes as unknown as {
					_workerLifecycle: {
						getPendingTerminalNotifications(): { notificationId: string; record: LaneRecord }[];
					};
				}
			)._workerLifecycle;

			expect(
				lifecycle
					.getPendingTerminalNotifications()
					.map((pending) => [pending.notificationId, pending.record.attemptId]),
			).toEqual([
				[`worker-terminal:${first.attemptId}`, first.attemptId],
				[`worker-terminal:${second.attemptId}`, second.attemptId],
			]);
		} finally {
			await harness.cleanup();
		}
	});
});

describe("the host names the generation of an in-process worker's claim", () => {
	function attemptsOf(harness: Harness, taskId: string): AttemptRuntimeState[] {
		const snapshot = new WorkerLifecycle({
			agentDir: harness.tempDir,
			sessionId: harness.session.sessionId,
		}).getTaskRuntimeSnapshot();
		return (snapshot.tasks[taskId]?.attemptIds ?? []).flatMap((attemptId) => {
			const attempt = snapshot.attempts[attemptId];
			return attempt ? [attempt] : [];
		});
	}

	it("a completed claim names its own attempt in the outcome, the session and the exact lookup", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"done","status":"completed"}')]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Complete one task" });
			if (!run.started || !run.record) throw new Error("Expected the worker to run.");
			const [attempt] = attemptsOf(harness, run.record.laneId);
			if (!attempt) throw new Error("Expected a durable attempt.");

			expect(run.outcome?.claim.terminalAttemptId).toBe(attempt.attemptId);
			expect(harness.session.getWorkerClaimSnapshots().map((claim) => claim.terminalAttemptId)).toEqual([
				attempt.attemptId,
			]);
			const exact = getWorkerClaimSnapshotForAttempt(
				harness.sessionManager.getEntries(),
				run.record.laneId,
				attempt.attemptId,
			);
			expect(exact?.claim.summary).toBe("done");
			expect(exact?.request?.id).toBe(run.record.laneId);
		} finally {
			harness.cleanup();
		}
	});

	it("an identity the worker's report carries is replaced by the attempt that ran", async () => {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		try {
			harness.setResponses([
				fauxAssistantMessage('{"summary":"done","status":"completed","terminalAttemptId":"attempt-spoofed"}'),
			]);
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Complete one task" });
			if (!run.started || !run.record) throw new Error("Expected the worker to run.");
			const [attempt] = attemptsOf(harness, run.record.laneId);
			if (!attempt) throw new Error("Expected a durable attempt.");

			expect(run.outcome?.claim.terminalAttemptId).toBe(attempt.attemptId);
			expect(harness.session.getWorkerClaimSnapshots().map((claim) => claim.terminalAttemptId)).toEqual([
				attempt.attemptId,
			]);
			expect(
				getWorkerClaimSnapshotForAttempt(harness.sessionManager.getEntries(), run.record.laneId, "attempt-spoofed"),
			).toBeUndefined();
		} finally {
			harness.cleanup();
		}
	});

	it("a cancelled generation's claim names the cancelled attempt; the earlier generation keeps its own", async () => {
		const harness = await createHarness();
		let releaseHeld!: (message: AssistantMessage) => void;
		const held = new Promise<AssistantMessage>((resolve) => {
			releaseHeld = resolve;
		});
		try {
			harness.setResponses([fauxAssistantMessage('{"summary":"initial turn complete","status":"completed"}')]);
			const initial = await harness.session.runWorkerDelegationOnce({ instructions: "Start a durable worker" });
			if (!initial.started || !initial.record) throw new Error("Expected the initial worker turn to complete.");
			const [initialAttempt] = attemptsOf(harness, initial.record.laneId);
			if (!initialAttempt) throw new Error("Expected the initial durable attempt.");

			let heldRequestSeen = false;
			setConcurrentResponses(harness, [
				() => {
					heldRequestSeen = true;
					return held;
				},
			]);
			const controls = (
				harness.session as unknown as {
					_backgroundLanes: {
						followUpWorkerAgent(agentId: string, message: string): { record?: { laneId: string } };
						cancelWorkerAgent(agentId: string, reason?: string): unknown;
					};
				}
			)._backgroundLanes;
			const followUp = controls.followUpWorkerAgent(initial.record.laneId, "Keep going.");
			const followUpLaneId = followUp.record?.laneId;
			if (!followUpLaneId) throw new Error("Expected a durable follow-up record.");
			await vi.waitFor(() => expect(heldRequestSeen).toBe(true), { timeout: 10_000 });

			controls.cancelWorkerAgent(initial.record.laneId, "owner_cancelled");
			await vi.waitFor(() => expect(attemptsOf(harness, followUpLaneId).at(-1)?.result).toBeDefined(), {
				timeout: 10_000,
			});
			const cancelledAttempt = attemptsOf(harness, followUpLaneId).at(-1);
			if (!cancelledAttempt) throw new Error("Expected the cancelled durable attempt.");

			const entries = harness.sessionManager.getEntries();
			const cancelled = getWorkerClaimSnapshotForAttempt(entries, followUpLaneId, cancelledAttempt.attemptId);
			expect(cancelled?.claim.status).toBe("cancelled");
			expect(cancelled?.claim.terminalAttemptId).toBe(cancelledAttempt.attemptId);
			const earlier = getWorkerClaimSnapshotForAttempt(entries, initial.record.laneId, initialAttempt.attemptId);
			expect(earlier?.claim.summary).toBe("initial turn complete");
			expect(earlier?.claim.terminalAttemptId).toBe(initialAttempt.attemptId);
		} finally {
			releaseHeld(fauxAssistantMessage('{"summary":"cleanup"}'));
			harness.cleanup();
		}
	});
});

describe("a worker generation that fails by exception", () => {
	const CAUSE = "injected executor failure";

	/** Make the executor throw for one run, after the attempt is leased and running. */
	function failExecutorOnce(onFailure?: (attemptId: string) => void) {
		return vi
			.spyOn(WorkerConversation.prototype, "previousAttemptParentSession")
			.mockImplementationOnce((attemptId: string) => {
				onFailure?.(attemptId);
				throw new Error(CAUSE);
			});
	}

	function lifecycleOf(harness: Harness): WorkerLifecycle {
		return new WorkerLifecycle({ agentDir: harness.tempDir, sessionId: harness.session.sessionId });
	}

	function attemptOf(harness: Harness, laneId: string): AttemptRuntimeState | undefined {
		const snapshot = lifecycleOf(harness).getTaskRuntimeSnapshot();
		const attemptId = snapshot.tasks[laneId]?.attemptIds.at(-1);
		return attemptId ? snapshot.attempts[attemptId] : undefined;
	}

	function failureClaims(harness: Harness): WorkerClaim[] {
		return harness.session
			.getWorkerClaimSnapshots()
			.filter((claim) => claim.summary.startsWith("Worker delegation failed:"));
	}

	async function delegationHarness() {
		const harness = await createHarness({ settings: { workerDelegation: { enabled: true } } });
		harness.setResponses([fauxAssistantMessage('{"summary":"resumed","status":"completed"}')]);
		return harness;
	}

	it("saves the finalized failure claim under its attempt, with the originating request", async () => {
		const harness = await delegationHarness();
		const spy = failExecutorOnce();
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Fail by exception" });
			if (!run.started || !run.record) throw new Error("Expected the worker to start.");
			const attempt = attemptOf(harness, run.record.laneId);
			if (!attempt) throw new Error("Expected a durable attempt.");

			expect(attempt.result).toMatchObject({ status: "failed", reasonCode: "worker_delegation_error" });
			const exact = getWorkerClaimSnapshotForAttempt(
				harness.sessionManager.getEntries(),
				run.record.laneId,
				attempt.attemptId,
			);
			expect(exact?.claim).toMatchObject({
				status: "failed",
				terminalAttemptId: attempt.attemptId,
				summary: `Worker delegation failed: ${CAUSE}`,
			});
			expect(exact?.request?.id).toBe(run.record.laneId);
		} finally {
			spy.mockRestore();
			harness.cleanup();
		}
	});

	it("a superseded lease fence leaves no failure claim from the stale owner", async () => {
		const harness = await delegationHarness();
		const spy = failExecutorOnce((attemptId) => {
			// Another owner takes the attempt over under a fresh fence before this run unwinds.
			const other = lifecycleOf(harness);
			const attempt = other.getTaskRuntimeSnapshot().attempts[attemptId];
			if (!attempt?.agentId || !attempt.lease) throw new Error("Expected a leased agent-bound attempt.");
			other.suspendAgent(attempt.taskId, attempt.agentId, attempt.lease.ownerId, "owner_takeover");
			other.resumeAgent(attempt.taskId, attempt.agentId, 60_000, "other-owner");
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Fail after a takeover" });
			if (!run.started || !run.record) throw new Error("Expected the worker to start.");
			const attempt = attemptOf(harness, run.record.laneId);

			expect(attempt?.lease?.ownerId).toBe("other-owner");
			expect(attempt?.result).toBeUndefined();
			expect(failureClaims(harness)).toEqual([]);
		} finally {
			spy.mockRestore();
			harness.cleanup();
		}
	});

	it("a suspension before the run unwinds leaves no failure claim", async () => {
		const harness = await delegationHarness();
		const spy = failExecutorOnce((attemptId) => {
			const owner = lifecycleOf(harness);
			const attempt = owner.getTaskRuntimeSnapshot().attempts[attemptId];
			if (!attempt?.agentId || !attempt.lease) throw new Error("Expected a leased agent-bound attempt.");
			owner.suspendAgent(attempt.taskId, attempt.agentId, attempt.lease.ownerId, "agent_process_interrupted");
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Fail after a suspension" });
			if (!run.started || !run.record) throw new Error("Expected the worker to start.");

			expect(failureClaims(harness)).toEqual([]);
			expect(
				lifecycleOf(harness).getTaskRuntimeSnapshot().attempts[spy.mock.calls[0]![0]]?.result?.reasonCode,
			).not.toBe("worker_delegation_error");
		} finally {
			spy.mockRestore();
			harness.cleanup();
		}
	});

	it("a failed fenced finalization leaves no claim snapshot", async () => {
		const harness = await delegationHarness();
		const spy = failExecutorOnce();
		const finish = vi.spyOn(WorkerLifecycle.prototype, "finish").mockImplementationOnce(() => {
			throw new Error("injected finalization failure");
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Fail twice" });
			if (!run.started || !run.record) throw new Error("Expected the worker to start.");
			const attempt = attemptOf(harness, run.record.laneId);
			if (!attempt) throw new Error("Expected a durable attempt.");

			expect(attempt.result).toBeUndefined();
			expect(attempt.status).toBe("cancelled");
			expect(
				getWorkerClaimSnapshotForAttempt(harness.sessionManager.getEntries(), run.record.laneId, attempt.attemptId),
			).toBeUndefined();
		} finally {
			finish.mockRestore();
			spy.mockRestore();
			harness.cleanup();
		}
	});

	it("a claim snapshot save failure keeps the durable failure, its cause and the parent wake", async () => {
		const harness = await delegationHarness();
		const spy = failExecutorOnce();
		const save = vi.spyOn(harness.session, "saveWorkerClaimSnapshot").mockImplementation(() => {
			throw new Error("injected snapshot failure");
		});
		try {
			const run = await harness.session.runWorkerDelegationOnce({ instructions: "Fail and lose the snapshot" });
			if (!run.started || !run.record) throw new Error("Expected the worker to start.");
			const attempt = attemptOf(harness, run.record.laneId);
			if (!attempt) throw new Error("Expected a durable attempt.");

			expect(save).toHaveBeenCalledTimes(1);
			expect(run.record).toMatchObject({ status: "failed", reasonCode: "worker_delegation_error" });
			expect(attempt.result?.summary).toBe(`Worker delegation failed: ${CAUSE}`);
			expect(lifecycleOf(harness).getAttemptTerminalNotification(attempt.attemptId)?.record).toMatchObject({
				attemptId: attempt.attemptId,
				status: "failed",
				reasonCode: "worker_delegation_error",
			});
			expect(
				harness.eventsOfType("warning").some((event) => event.message === `Worker delegation failed: ${CAUSE}`),
			).toBe(true);
		} finally {
			save.mockRestore();
			spy.mockRestore();
			harness.cleanup();
		}
	});
});
