import type { SessionManager } from "@caupulican/pi-agent-core/node";
import { describe, expect, it, vi } from "vitest";
import {
	BackgroundLaneController,
	clampLaneMaxUsd,
	isLocalExecutionModel,
} from "../src/core/background-lane-controller.ts";

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
		const controller = new BackgroundLaneController({
			getSessionManager: () => ({ getEntries }) as unknown as SessionManager,
		} as never);
		const seedLaneHistory = (controller as unknown as { _seedLaneHistory(): void })._seedLaneHistory.bind(controller);

		seedLaneHistory();
		seedLaneHistory();

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
		expect(timeoutSpy).toHaveBeenCalledWith(expect.any(Function), 30_000);
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

			await vi.advanceTimersByTimeAsync(30_000);
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
	it("terminalizes queued and running lanes instead of leaving orphaned active records", () => {
		const controller = new BackgroundLaneController({} as never);
		const internals = controller as unknown as {
			_laneTracker: {
				enqueue(args: { type: "worker" }): { laneId: string };
				start(args: { type: "research" }): { laneId: string };
			};
			_queuedWorkers: Map<string, { instructions: string }>;
		};
		const queued = internals._laneTracker.enqueue({ type: "worker" });
		internals._queuedWorkers.set(queued.laneId, { instructions: "queued work" });
		internals._laneTracker.start({ type: "research" });

		controller.abortInFlightLanes();

		expect(controller.getActiveLaneCount()).toBe(0);
		expect(internals._queuedWorkers.size).toBe(0);
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
