import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LaneTracker } from "../src/core/autonomy/lane-tracker.ts";
import {
	BackgroundLaneController,
	clampLaneMaxUsd,
	isLocalExecutionModel,
} from "../src/core/background-lane-controller.ts";
import type { WorkerLifecycle } from "../src/core/delegation/worker-lifecycle.ts";
import { ORCHESTRATION_SCHEMA_VERSION, type WorkerResultContract } from "../src/core/orchestration/contracts.ts";
import type { StartedDelegationAttempt } from "../src/core/orchestration/delegation-ledger.ts";
import { createWorkerExecutionContract } from "../src/core/orchestration/worker-execution-contract.ts";
import { getInFlightWorkUnits, resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { ResearchLaneController } from "../src/core/research/research-lane-controller.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createTestExecutionGrant,
	createTestWorkerExecutionAuthority,
	createTestWorkerOrchestrationProfile,
	saveTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";
import { createTestResourceLoader } from "./utilities.ts";

function resultFor(
	handle: StartedDelegationAttempt,
	overrides: Partial<Pick<WorkerResultContract, "status" | "reasonCode" | "summary">> = {},
): WorkerResultContract {
	return {
		schemaVersion: ORCHESTRATION_SCHEMA_VERSION,
		resultId: `result-${handle.attemptId}`,
		objectiveId: handle.objectiveId,
		taskId: handle.taskId,
		attemptId: handle.attemptId,
		leaseId: handle.leaseId,
		fencingToken: handle.fencingToken,
		status: "completed",
		reasonCode: "worker_completed",
		summary: "done",
		artifacts: [],
		evidence: [],
		errors: [],
		usage: { costUsd: 0, wallClockMs: 10, toolCalls: 1 },
		createdAt: new Date().toISOString(),
		...overrides,
	};
}

describe("background lane budgets", () => {
	it("clamps research lane spend to the foreground envelope cap", () => {
		expect(clampLaneMaxUsd(1.5, 0.25)).toBe(0.25);
		expect(clampLaneMaxUsd(0.1, 0.25)).toBe(0.1);
		expect(clampLaneMaxUsd(0.1, undefined)).toBe(0.1);
	});
});

describe("background lane history", () => {
	it("seeds persisted lane counters once instead of rescanning the session per lane", () => {
		const getEntries = vi.fn(() => []);
		const controller = new ResearchLaneController(
			{
				getSessionManager: () => ({ getEntries }) as unknown as SessionManager,
			} as never,
			new LaneTracker(),
			{} as never,
		);

		controller.seedHistory();
		controller.seedHistory();

		expect(getEntries).toHaveBeenCalledTimes(1);
	});
});

describe("worker terminal handoffs", () => {
	it("retains goal ownership through the asynchronous terminal outbox", async () => {
		let resolveHandoff!: () => void;
		const handoff = new Promise<void>((resolve) => {
			resolveHandoff = resolve;
		});
		const notifyWorkerTerminalHandoff = vi.fn(async () => {
			resolveHandoff();
		});
		const controller = new BackgroundLaneController({
			emit: () => {},
			notifyWorkerTerminalHandoff,
		} as never);
		const recordTerminal = (
			controller as unknown as {
				_recordWorkerTerminal(record: {
					laneId: string;
					type: "worker";
					status: "succeeded";
					goalId: string;
				}): void;
			}
		)._recordWorkerTerminal.bind(controller);

		recordTerminal({ laneId: "worker-late", type: "worker", status: "succeeded", goalId: "goal-runaway" });
		await handoff;

		expect(notifyWorkerTerminalHandoff).toHaveBeenCalledWith([
			{
				laneId: "worker-late",
				status: "succeeded",
				goalId: "goal-runaway",
			},
		]);
		controller.abortInFlightLanes();
	});

	it("batches same-tick terminal events into one event-driven parent wake", async () => {
		const emitted: unknown[] = [];
		let resolveHandoff!: () => void;
		const handoff = new Promise<void>((resolve) => {
			resolveHandoff = resolve;
		});
		const notifyWorkerTerminalHandoff = vi.fn(async () => {
			resolveHandoff();
		});
		const controller = new BackgroundLaneController({
			emit: (event: unknown) => emitted.push(event),
			notifyWorkerTerminalHandoff,
		} as never);
		const recordTerminal = (
			controller as unknown as {
				_recordWorkerTerminal(record: { laneId: string; type: "worker"; status: "succeeded" | "failed" }): void;
			}
		)._recordWorkerTerminal.bind(controller);
		recordTerminal({ laneId: "worker-1", type: "worker", status: "succeeded" });
		recordTerminal({ laneId: "worker-2", type: "worker", status: "failed" });
		expect(notifyWorkerTerminalHandoff).not.toHaveBeenCalled();
		await handoff;

		expect(notifyWorkerTerminalHandoff).toHaveBeenCalledTimes(1);
		expect(notifyWorkerTerminalHandoff).toHaveBeenCalledWith([
			{ laneId: "worker-1", status: "succeeded" },
			{ laneId: "worker-2", status: "failed" },
		]);
		expect(emitted).toContainEqual(
			expect.objectContaining({
				type: "delegate_workers",
				completedSinceFlush: 1,
				failedSinceFlush: 1,
			}),
		);
		controller.abortInFlightLanes();
	});

	it("marks a terminal read before delivery when an event-driven agent wait already owns it", async () => {
		const record = {
			laneId: "task-1",
			type: "worker" as const,
			status: "succeeded" as const,
			completedAt: "2026-08-21T20:00:00.000Z",
		};
		let resolveWait!: () => void;
		const wait = new Promise<{ status: "idle"; timedOut: false }>((resolve) => {
			resolveWait = () => resolve({ status: "idle", timedOut: false });
		});
		const agentControl = { waitForWorkerAgent: vi.fn(() => wait) };
		const workers = {
			getAgentControl: () => agentControl,
			getRecords: () => [record],
			abort: () => {},
		};
		const lifecycle = {
			getActiveAttempt: (laneId: string) =>
				laneId === record.laneId
					? { agentId: "agent-1", taskId: record.laneId, dispatch: { logicalLaneId: "agent-1" } }
					: undefined,
			getManagedAttempt: () => undefined,
			getManagedRecords: () => [],
			getAllRecords: () => [record],
			getTerminalNotification: () => undefined,
			markNotificationsDelivered: vi.fn(),
		};
		let delivered!: readonly { laneId: string; observedAt?: string }[];
		const notifyWorkerTerminalHandoff = vi.fn(async (records) => {
			delivered = records;
		});
		const controller = new BackgroundLaneController({
			isDelegateToolActive: () => true,
			getSessionManager: () => ({ getEntries: () => [] }) as unknown as SessionManager,
			emit: () => {},
			notifyWorkerTerminalHandoff,
		} as never);
		Object.assign(controller as object, { _workers: workers, _workerLifecycle: lifecycle });

		const waiting = controller.waitForWorkerAgent("agent-1");
		(
			controller as unknown as {
				_recordWorkerTerminal(terminalRecord: typeof record, durableNotificationId: string): void;
			}
		)._recordWorkerTerminal(record, "notification-task-1");
		await vi.waitFor(() => expect(notifyWorkerTerminalHandoff).toHaveBeenCalledOnce());

		expect(delivered).toEqual([
			expect.objectContaining({
				laneId: record.laneId,
				completedAt: record.completedAt,
				observedAt: expect.any(String),
			}),
		]);
		resolveWait();
		await waiting;
		controller.abortInFlightLanes();
	});

	it("serializes later terminal batches behind one unresolved durable handoff", async () => {
		vi.useFakeTimers();
		try {
			const emitted: unknown[] = [];
			let resolveFirst!: () => void;
			const firstHandoff = new Promise<void>((resolve) => {
				resolveFirst = resolve;
			});
			const notifyWorkerTerminalHandoff = vi
				.fn<() => Promise<void>>()
				.mockReturnValueOnce(firstHandoff)
				.mockResolvedValue(undefined);
			const controller = new BackgroundLaneController({
				emit: (event: unknown) => emitted.push(event),
				notifyWorkerTerminalHandoff,
			} as never);
			const recordTerminal = (
				controller as unknown as {
					_recordWorkerTerminal(record: { laneId: string; type: "worker"; status: "succeeded" | "failed" }): void;
				}
			)._recordWorkerTerminal.bind(controller);

			recordTerminal({ laneId: "worker-1", type: "worker", status: "succeeded" });
			await Promise.resolve();
			await Promise.resolve();
			expect(notifyWorkerTerminalHandoff).toHaveBeenCalledTimes(1);

			recordTerminal({ laneId: "worker-2", type: "worker", status: "failed" });
			for (let flush = 0; flush < 4; flush++) await Promise.resolve();

			expect(notifyWorkerTerminalHandoff).toHaveBeenCalledTimes(1);
			resolveFirst();
			for (let flush = 0; flush < 4; flush++) await Promise.resolve();
			expect(notifyWorkerTerminalHandoff).toHaveBeenCalledTimes(2);
			expect(emitted).toContainEqual(expect.objectContaining({ type: "delegate_workers", failedSinceFlush: 1 }));
			controller.abortInFlightLanes();
		} finally {
			vi.useRealTimers();
		}
	});

	it("backfills a durable notification for a transient record the moment it flushes, not only whenever a later WorkerLifecycle construction happens to sweep for it", async () => {
		// getOutstandingRecords() with zero callers isn't durability by itself. What THIS fix adds:
		// WorkerLifecycle.getPendingTerminalNotifications() already sweeps and backfills every
		// terminal durable task's notification as a side effect of ensureTerminalNotifications() --
		// so a naive test that reads getPendingTerminalNotifications() (or constructs a SECOND
		// WorkerLifecycle, which replays via the same call) to check "is this durable yet?"
		// self-fulfills its own answer and can't distinguish this fix from that pre-existing sweep.
		// The real, isolated contribution is TIMING: without this fix, a transient record's durable
		// notification only exists once something happens to trigger that sweep (e.g. a restart's
		// WorkerLifecycle construction) -- nothing guarantees that happens before the process
		// actually goes away. With this fix, it exists immediately on the flush that records it.
		// Isolated here by materializing the controller's OWN lifecycle (a real construction-time
		// sweep, but over an EMPTY ledger, so it finds nothing) BEFORE the task is ever prepared, so
		// the only thing left that can create the notification during this test is the flush itself.
		const agentDir = mkdtempSync(join(tmpdir(), "pi-background-lane-restart-replay-"));
		try {
			const sessionId = "session-restart-replay";
			// Never resolves -- strands the batch behind an in-flight notify(), exactly like the
			// scenario the wave-1 watchdog observes but cannot itself fix.
			const notifyWorkerTerminalHandoff = vi.fn(() => new Promise<void>(() => {}));
			const controller = new BackgroundLaneController({
				getAgentDir: () => agentDir,
				getSessionId: () => sessionId,
				emit: () => {},
				notifyWorkerTerminalHandoff,
			} as never);
			const controllerInternals = controller as unknown as {
				_getWorkerLifecycle(): WorkerLifecycle;
				_recordWorkerTerminal(record: { laneId: string; type: "worker"; status: "succeeded" }): void;
			};
			// Materialized over an empty ledger (no durable tasks exist yet), so its own
			// construction-time sweep finds nothing -- it cannot be what backfills the notification
			// created below.
			const lifecycle = controllerInternals._getWorkerLifecycle();

			// One real durable worker attempt, finished WITHOUT its automatic notification (`notify:
			// false`) -- the exact precondition for a "transient" record: terminal, but with no
			// durable notification backing it yet. Uses the SAME lifecycle instance the controller
			// already owns, so it shares the coordinator's `getWorkerRecords`/`markDurableDelivered`
			// wiring exactly as it would in production.
			const profile = createTestWorkerOrchestrationProfile({
				profileId: "restart-replay",
				model: { provider: "test", id: "model" },
			});
			const authority = createTestWorkerExecutionAuthority(profile);
			const prepared = lifecycle.prepare({
				instructions: "stranded",
				executionContract: createWorkerExecutionContract({
					worker: { profile, modelBinding: profile.modelPolicy.candidates[0]!, authority },
				}),
				requiredCapabilities: [],
			});
			const task = lifecycle.getTask(prepared.attempt.taskId);
			if (!task) throw new Error("Expected durable task");
			lifecycle.bindGrant(
				prepared.attempt.attemptId,
				createTestExecutionGrant({
					objectiveId: task.task.objectiveId,
					taskId: task.task.taskId,
					attemptId: prepared.attempt.attemptId,
					role: "implementer",
				}),
			);
			const handle = lifecycle.start(prepared.record.laneId, 60_000);
			lifecycle.finish(resultFor(handle), { notify: false });
			const laneId = prepared.record.laneId;
			const notificationId = `worker-terminal:${prepared.attempt.attemptId}`;

			// Raw read, deliberately bypassing getPendingTerminalNotifications()/its own sweep.
			expect(notificationId in lifecycle.ledger.runtime.getSnapshot().notifications).toBe(false);

			// Recorded WITHOUT a durableNotificationId -- the exact transient case.
			controllerInternals._recordWorkerTerminal({ laneId, type: "worker", status: "succeeded" });
			await Promise.resolve();
			await Promise.resolve();
			expect(notifyWorkerTerminalHandoff).toHaveBeenCalledOnce();

			// Same raw read as above, same lifecycle instance -- no NEW WorkerLifecycle construction
			// (and therefore no NEW sweep) happens between the two reads.
			expect(notificationId in lifecycle.ledger.runtime.getSnapshot().notifications).toBe(true);

			controller.abortInFlightLanes();
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("background lane disposal", () => {
	it("terminalizes queued and running research lanes instead of leaving orphaned active records", () => {
		const controller = new BackgroundLaneController({
			getAgentDir: () => "/tmp/pi-background-lane-disposal",
			getSessionManager: () =>
				({ getEntries: () => [], appendCustomEntry: () => "entry-1" }) as unknown as SessionManager,
		} as never);
		const internals = controller as unknown as {
			_laneTracker: {
				enqueue(args: { type: "research" }): { laneId: string };
				start(args: { type: "research" }): { laneId: string };
			};
		};
		const queued = internals._laneTracker.enqueue({ type: "research" });
		internals._laneTracker.start({ type: "research" });

		controller.abortInFlightLanes();

		expect(controller.getActiveLaneCount()).toBe(0);
		expect(controller.getLaneRecords()).toEqual([
			expect.objectContaining({
				laneId: queued.laneId,
				status: "canceled",
				reasonCode: "session_disposed",
			}),
			expect.objectContaining({
				type: "research",
				status: "canceled",
				reasonCode: "session_disposed",
			}),
		]);
	});
});

describe("worker runtime construction", () => {
	it("does not materialize worker orchestration when UAC withholds delegate", () => {
		const controller = new BackgroundLaneController({
			isDelegateToolActive: () => false,
			getAgentDir: () => "/tmp/pi-background-lane-uac",
			getSessionManager: () => ({ getEntries: () => [] }) as unknown as SessionManager,
		} as never);
		const internals = controller as unknown as { _workers?: unknown };

		expect(controller.getLaneRecords()).toEqual([]);
		controller.drainQueuedWorkerDelegations();
		controller.abortInFlightLanes();
		expect(internals._workers).toBeUndefined();
	});

	it("refuses logical-worker controls before materializing delegation when UAC withholds it", () => {
		const controller = new BackgroundLaneController({
			isDelegateToolActive: () => false,
			getAgentDir: () => "/tmp/pi-background-lane-uac-controls",
			getSessionManager: () => ({ getEntries: () => [] }) as unknown as SessionManager,
		} as never);
		const internals = controller as unknown as { _workers?: unknown };

		expect(() => controller.sendWorkerAgentMessage("agent-1", "do not load")).toThrow("UAC surface");
		expect(internals._workers).toBeUndefined();
	});

	it("forwards recursive caller scope through the session-level worker-control boundary", async () => {
		const listWorkerAgents = vi.fn(() => []);
		const getWorkerAgentActivity = vi.fn(() => "idle" as const);
		const readWorkerAgentTranscript = vi.fn(() => ({
			agentId: "child",
			cursor: 0,
			messages: [],
		}));
		const interruptWorkerAgent = vi.fn(() => ({ interrupted: false }));
		const resumeWorkerAgent = vi.fn(() => ({ started: false }));
		const cancelWorkerAgent = vi.fn(() => undefined);
		const startWorkerAgentTask = vi.fn(() => ({
			started: true as const,
			steering: false as const,
			messageId: "worker-message-1",
		}));
		const waitForWorkerAgent = vi.fn(async () => ({ status: "idle" as const, timedOut: false }));
		const waitForWorkerAgents = vi.fn(async () => ({
			statuses: [{ agentId: "child", status: "idle" as const }],
			updatedAgentIds: [],
			timedOut: false,
		}));
		const broadcastWorkerAgentMessage = vi.fn(() => ({
			results: [
				{
					agentId: "child",
					accepted: true as const,
					queued: true as const,
					replayed: false,
					messageId: "message-1",
				},
			],
		}));
		const retireWorkerAgent = vi.fn(() => ({
			agent: {
				agentId: "child",
				rootAgentId: "parent",
				depth: 1,
				role: "explorer" as const,
				status: "retired" as const,
				createdAt: "T0",
				updatedAt: "T1",
			},
			retired: true as const,
			replayed: false,
		}));
		const agentControl = {
			listWorkerAgents,
			getWorkerAgentActivity,
			readWorkerAgentTranscript,
			startWorkerAgentTask,
			interruptWorkerAgent,
			resumeWorkerAgent,
			cancelWorkerAgent,
			waitForWorkerAgent,
			waitForWorkerAgents,
			broadcastWorkerAgentMessage,
			retireWorkerAgent,
		};
		const controller = new BackgroundLaneController({ isDelegateToolActive: () => true } as never);
		(
			controller as unknown as {
				_workers: { getAgentControl(): typeof agentControl };
			}
		)._workers = { getAgentControl: () => agentControl };
		const scope = { callerAgentId: "parent" };

		controller.listWorkerAgents(scope);
		controller.getWorkerAgentActivity("child", scope);
		controller.readWorkerAgentTranscript("child", { cursor: 2, maxMessages: 3, ...scope });
		controller.startWorkerAgentTask("child", "new task", scope);
		controller.interruptWorkerAgent("child", scope);
		controller.resumeWorkerAgent("child", scope);
		controller.cancelWorkerAgent("child", "agent_cancelled", scope);
		await controller.waitForWorkerAgent("child", 1_000, scope);
		await controller.waitForWorkerAgents(["child", "peer"], "all", 2_000, scope);
		controller.broadcastWorkerAgentMessage(["child", "peer"], "Share evidence.", {
			senderAgentId: "parent",
			idempotencyKey: "broadcast-1",
		});
		controller.retireWorkerAgent("child", scope);

		expect(listWorkerAgents).toHaveBeenCalledWith(scope);
		expect(getWorkerAgentActivity).toHaveBeenCalledWith("child", scope);
		expect(readWorkerAgentTranscript).toHaveBeenCalledWith("child", { cursor: 2, maxMessages: 3, ...scope });
		expect(startWorkerAgentTask).toHaveBeenCalledWith("child", "new task", scope);
		expect(interruptWorkerAgent).toHaveBeenCalledWith("child", scope);
		expect(resumeWorkerAgent).toHaveBeenCalledWith("child", scope);
		expect(cancelWorkerAgent).toHaveBeenCalledWith("child", "agent_cancelled", scope);
		expect(waitForWorkerAgent).toHaveBeenCalledWith("child", 1_000, scope);
		expect(waitForWorkerAgents).toHaveBeenCalledWith(["child", "peer"], "all", 2_000, scope);
		expect(broadcastWorkerAgentMessage).toHaveBeenCalledWith(["child", "peer"], "Share evidence.", {
			senderAgentId: "parent",
			idempotencyKey: "broadcast-1",
		});
		expect(retireWorkerAgent).toHaveBeenCalledWith("child", scope);
	});

	it("releases an active wait-consumer receipt when a worker wait throws synchronously", () => {
		const waitForWorkerAgent = vi.fn(() => {
			throw new Error("worker wait unavailable");
		});
		const waitForWorkerAgents = vi.fn(() => {
			throw new Error("worker waits unavailable");
		});
		const agentControl = { waitForWorkerAgent, waitForWorkerAgents };
		const controller = new BackgroundLaneController({ isDelegateToolActive: () => true } as never);
		(
			controller as unknown as {
				_workers: { getAgentControl(): typeof agentControl };
			}
		)._workers = { getAgentControl: () => agentControl };

		expect(() => controller.waitForWorkerAgent("child")).toThrow("worker wait unavailable");
		expect(() => controller.waitForWorkerAgents(["child", "peer"], "all")).toThrow("worker waits unavailable");
		expect((controller as unknown as { _workerWaitConsumers: Map<string, number> })._workerWaitConsumers).toEqual(
			new Map(),
		);
	});
});

describe("worker execution locality", () => {
	it("recognizes built-in and custom loopback models without classifying remote providers as local", () => {
		expect(isLocalExecutionModel({ provider: "ollama", baseUrl: "https://remote.invalid" })).toBe(true);
		expect(isLocalExecutionModel({ provider: "custom", baseUrl: "http://127.0.0.1:9000/v1" })).toBe(true);
		expect(isLocalExecutionModel({ provider: "custom", baseUrl: "http://[::1]:9000/v1" })).toBe(true);
		expect(isLocalExecutionModel({ provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" })).toBe(
			false,
		);
		expect(isLocalExecutionModel({ provider: "fugu", baseUrl: "https://api.sakana.ai/v1" })).toBe(false);
	});
});

describe("quiesce registry", () => {
	afterEach(() => {
		resetInFlightWorkRegistryForTests();
	});

	it("registers a research lane in the quiesce registry while running, deregisters on completion", async () => {
		const agentDir = "/tmp/pi-test-quiesce-research";
		let resolveCompletion!: (value: { text: string; usage: unknown; stopReason: string }) => void;
		const completionPromise = new Promise((resolve) => {
			resolveCompletion = resolve as never;
		});
		const model = { provider: "test", id: "test-model", contextWindow: 128_000 };
		const controller = new BackgroundLaneController({
			isDisposed: () => false,
			getSessionId: () => "test-session",
			getCwd: () => "/repo",
			getAgentDir: () => agentDir,
			getSessionManager: () =>
				({ getEntries: () => [], appendCustomEntry: () => "entry-1" }) as unknown as SessionManager,
			getSettingsManager: () =>
				({
					getResearchLaneSettings: () => ({
						maxUsd: 1,
						maxSources: 3,
						maxFindings: 3,
						maxWallClockMs: 0,
					}),
					getModelCapabilitySettings: () => ({ mode: "off" }),
				}) as never,
			getModel: () => model,
			isModelExhausted: () => false,
			getCapabilityEnvelope: () => undefined,
			collectWorkspaceSources: async () => [],
			runIsolatedCompletion: () => completionPromise as never,
			saveEvidenceBundleSnapshot: () => "evidence-1",
			addSpawnedUsage: () => undefined,
			emitAutonomyTelemetry: () => {},
			emit: () => {},
		} as never);

		const runPromise = controller.runResearchLaneOnce({ query: "q", context: "c" });
		// Let the synchronous setup (through the awaited `runIsolatedCompletion` call) settle.
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		const inFlight = getInFlightWorkUnits(agentDir);
		expect(inFlight).toHaveLength(1);
		expect(inFlight[0]?.kind).toBe("lane");
		expect(inFlight[0]?.label).toMatch(/^research:/);

		resolveCompletion({
			text: '{"findings":[{"summary":"test finding","confidence":0.8}]}',
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
		});
		const outcome = await runPromise;

		expect(outcome.started).toBe(true);
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
	});

	it("deregisters a worker lane from the quiesce registry even when it throws", async () => {
		const agentDir = mkdtempSync(join(tmpdir(), "pi-test-quiesce-worker-throw-"));
		const model = { provider: "test", id: "test-model", contextWindow: 128_000 };
		const settingsManager = SettingsManager.inMemory({
			workerDelegation: { enabled: true, orchestrationProfile: "throw-worker", maxConcurrent: 3 },
		});
		saveTestWorkerOrchestrationProfile({
			agentDir,
			cwd: "/repo",
			profile: createTestWorkerOrchestrationProfile({ profileId: "throw-worker", model }),
		});
		const controller = new BackgroundLaneController({
			isDisposed: () => false,
			getSessionId: () => "test-session",
			getCwd: () => "/repo",
			getAgentDir: () => agentDir,
			getSessionManager: () =>
				({
					getEntries: () => [],
					getLeafId: () => null,
					getEntry: () => undefined,
					buildSessionContext: () => ({ messages: [] }),
					appendCustomEntry: () => "entry-1",
				}) as unknown as SessionManager,
			getSettingsManager: () => settingsManager,
			getResourceLoader: () => createTestResourceLoader(),
			getModelRegistry: () => ({ find: () => model, hasConfiguredAuth: () => true }) as never,
			getModel: () => model,
			isModelExhausted: () => false,
			isDelegateToolActive: () => true,
			getCapabilityEnvelope: () => undefined,
			getGoalStateSnapshot: () => undefined,
			readMemoryForLane: async () => "",
			// Throws inside the lane's try block, after registration — proves the finally still deregisters.
			runIsolatedCompletion: () => Promise.reject(new Error("boom")),
			emitAutonomyTelemetry: () => {},
			emit: () => {},
		} as never);

		const outcome = await controller.runWorkerDelegationOnce({ instructions: "do something" });

		expect(outcome.started).toBe(true);
		expect(getInFlightWorkUnits(agentDir)).toEqual([]);
		rmSync(agentDir, { recursive: true, force: true });
	});
});
