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
import { getInFlightWorkUnits, resetInFlightWorkRegistryForTests } from "../src/core/reload-blockers.ts";
import { ResearchLaneController } from "../src/core/research/research-lane-controller.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import {
	createTestWorkerOrchestrationProfile,
	saveTestWorkerOrchestrationProfile,
} from "./orchestration-profile-fixture.ts";
import { createTestResourceLoader } from "./utilities.ts";

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
		const timeoutSpy = vi.spyOn(globalThis, "setTimeout");

		recordTerminal({ laneId: "worker-1", type: "worker", status: "succeeded" });
		recordTerminal({ laneId: "worker-2", type: "worker", status: "failed" });
		expect(notifyWorkerTerminalHandoff).not.toHaveBeenCalled();
		await handoff;

		expect(timeoutSpy).toHaveBeenCalledTimes(1);
		expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 1_800_000);
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
		timeoutSpy.mockRestore();
	});

	it("bounds a stuck handoff so the next terminal batch is not starved", async () => {
		vi.useFakeTimers();
		try {
			const emitted: unknown[] = [];
			let notificationCalls = 0;
			const notifyWorkerTerminalHandoff = vi.fn(() => {
				notificationCalls++;
				return notificationCalls === 1 ? new Promise<void>(() => {}) : Promise.resolve();
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
			await Promise.resolve();
			await Promise.resolve();
			expect(notifyWorkerTerminalHandoff).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(1_800_000);
			recordTerminal({ laneId: "worker-2", type: "worker", status: "failed" });
			for (let flush = 0; flush < 4; flush++) await Promise.resolve();

			expect(notifyWorkerTerminalHandoff).toHaveBeenCalledTimes(2);
			expect(emitted).toContainEqual(
				expect.objectContaining({
					type: "warning",
					message: expect.stringContaining("worker terminal handoff timed out"),
				}),
			);
			controller.abortInFlightLanes();
		} finally {
			vi.useRealTimers();
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
