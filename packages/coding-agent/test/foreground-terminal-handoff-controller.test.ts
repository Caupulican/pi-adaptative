import { describe, expect, it, vi } from "vitest";
import type {
	ForegroundRecoveryController,
	ForegroundSubmissionLease,
} from "../src/core/foreground-recovery-controller.ts";
import { ForegroundTerminalHandoffController } from "../src/core/foreground-terminal-handoff-controller.ts";
import type { GoalState } from "../src/core/goals/goal-state.ts";

function createController(
	goal: Pick<GoalState, "goalId" | "status"> | undefined = { goalId: "goal-active", status: "active" },
	getWorkerResult?: () => {
		artifacts: Array<{
			artifactId: string;
			kind: "report";
			uri: string;
			sizeBytes: number;
			createdAt: string;
			metadata: { source: string; complete: boolean };
		}>;
	},
) {
	const lease = {} as ForegroundSubmissionLease;
	const foreground = {
		waitForIdle: vi.fn(async () => undefined),
		tryAcquireSubmission: vi.fn(() => lease),
		releaseSubmission: vi.fn(),
	} as unknown as ForegroundRecoveryController;
	const sendCustomMessage = vi.fn(async () => undefined);
	const startCustomMessageTurn = vi.fn(async () => ({ completion: Promise.resolve() }));
	const enqueueCustomMessageTurn = vi.fn(async () => undefined);
	const controller = new ForegroundTerminalHandoffController({
		foreground,
		isDisposed: () => false,
		getGoalStateSnapshot: () => goal,
		...(getWorkerResult ? { getWorkerResult } : {}),
		startCustomMessageTurn,
		enqueueCustomMessageTurn,
		sendCustomMessage,
		warn: vi.fn(),
	});
	return { controller, foreground, lease, enqueueCustomMessageTurn, sendCustomMessage, startCustomMessageTurn };
}

describe("ForegroundTerminalHandoffController", () => {
	it("delivers an unread terminal at the next provider boundary without waiting for the foreground run to end", async () => {
		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const lease = {} as ForegroundSubmissionLease;
		const foreground = {
			isBusy: true,
			waitForIdle: vi.fn(() => idle),
			tryAcquireSubmission: vi.fn(() => lease),
			acquireSubmission: vi.fn(() => idle.then(() => lease)),
			releaseSubmission: vi.fn(),
		} as unknown as ForegroundRecoveryController;
		const enqueueCustomMessageTurn = vi.fn(async () => undefined);
		const deps = {
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => ({ goalId: "goal-active", status: "active" as const }),
			startCustomMessageTurn: vi.fn(async () => ({ completion: Promise.resolve() })),
			sendCustomMessage: vi.fn(async () => undefined),
			enqueueCustomMessageTurn,
			warn: vi.fn(),
		};
		const controller = new ForegroundTerminalHandoffController(deps);

		let settled = false;
		const notification = controller
			.notifyWorkers([{ laneId: "worker-fast", status: "succeeded", goalId: "goal-active" }])
			.then(() => {
				settled = true;
			});
		await Promise.resolve();
		expect(settled).toBe(false);

		controller.flushProviderBoundary();
		controller.flushProviderBoundary();
		await notification;

		expect(enqueueCustomMessageTurn).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-worker-completion" }),
		);
		expect(enqueueCustomMessageTurn).toHaveBeenCalledOnce();
		expect(foreground.acquireSubmission).not.toHaveBeenCalled();
		expect(foreground.tryAcquireSubmission).not.toHaveBeenCalled();
		releaseIdle();
	});

	it("persists one worker handoff when the same terminal generation is notified repeatedly", async () => {
		const { controller, startCustomMessageTurn } = createController();
		const terminal = {
			laneId: "worker-idempotent",
			status: "failed" as const,
			reasonCode: "managed_process_launch_failed",
			completedAt: "2026-08-21T20:00:01.000Z",
			goalId: "goal-active",
		};

		await controller.notifyWorkers([{ ...terminal }]);
		await controller.notifyWorkers([{ ...terminal }]);
		await controller.notifyWorkers([{ ...terminal }]);

		expect(startCustomMessageTurn).toHaveBeenCalledOnce();
	});

	it("suppresses a boundary wake when the terminal was observed during the active turn", async () => {
		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		const foreground = {
			waitForIdle: vi.fn(() => idle),
			tryAcquireSubmission: vi.fn(),
			releaseSubmission: vi.fn(),
		} as unknown as ForegroundRecoveryController;
		const enqueueCustomMessageTurn = vi.fn(async () => undefined);
		const controller = new ForegroundTerminalHandoffController({
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => ({ goalId: "goal-active", status: "active" }),
			startCustomMessageTurn: vi.fn(async () => ({ completion: Promise.resolve() })),
			enqueueCustomMessageTurn,
			sendCustomMessage: vi.fn(async () => undefined),
			warn: vi.fn(),
		});
		const record = {
			laneId: "worker-observed-at-boundary",
			status: "succeeded" as const,
			goalId: "goal-active",
		};

		const notification = controller.notifyWorkers([record]);
		Object.assign(record, { observedAt: "2026-08-21T20:00:01.000Z" });
		controller.flushProviderBoundary();
		await notification;

		expect(enqueueCustomMessageTurn).not.toHaveBeenCalled();
		expect(foreground.tryAcquireSubmission).not.toHaveBeenCalled();
		releaseIdle();
	});

	it("never steers after disposal while a terminal is waiting for the next boundary", async () => {
		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		let disposed = false;
		const enqueueCustomMessageTurn = vi.fn(async () => undefined);
		const controller = new ForegroundTerminalHandoffController({
			foreground: {
				waitForIdle: vi.fn(() => idle),
				tryAcquireSubmission: vi.fn(),
			} as unknown as ForegroundRecoveryController,
			isDisposed: () => disposed,
			getGoalStateSnapshot: () => ({ goalId: "goal-active", status: "active" }),
			startCustomMessageTurn: vi.fn(async () => ({ completion: Promise.resolve() })),
			enqueueCustomMessageTurn,
			sendCustomMessage: vi.fn(async () => undefined),
			warn: vi.fn(),
		});

		const notification = controller.notifyWorkers([
			{ laneId: "worker-disposed", status: "succeeded", goalId: "goal-active" },
		]);
		disposed = true;
		controller.flushProviderBoundary();

		await expect(notification).rejects.toThrow(/Session disposed/);
		expect(enqueueCustomMessageTurn).not.toHaveBeenCalled();
		releaseIdle();
	});

	it("persists but does not wake a tool terminal after its owning goal becomes terminal", async () => {
		let releaseIdle!: () => void;
		const idle = new Promise<void>((resolve) => {
			releaseIdle = resolve;
		});
		let goalStatus: GoalState["status"] = "active";
		const lease = {} as ForegroundSubmissionLease;
		const foreground = {
			waitForIdle: vi.fn(() => idle),
			tryAcquireSubmission: vi.fn(() => lease),
			releaseSubmission: vi.fn(),
		} as unknown as ForegroundRecoveryController;
		const enqueueCustomMessageTurn = vi.fn(async () => undefined);
		const sendCustomMessage = vi.fn(async () => undefined);
		const controller = new ForegroundTerminalHandoffController({
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => ({ goalId: "goal-tool", status: goalStatus }),
			startCustomMessageTurn: vi.fn(async () => ({ completion: Promise.resolve() })),
			enqueueCustomMessageTurn,
			sendCustomMessage,
			warn: vi.fn(),
		});
		const record = {
			sessionId: "session-a",
			taskId: "tool-task-1",
			toolCallId: "call-1",
			toolName: "delegate",
			goalId: "goal-tool",
			status: "completed" as const,
			startedAt: "2026-08-21T20:00:00.000Z",
			completedAt: "2026-08-21T20:00:01.000Z",
			elapsedBeforeHandoffMs: 15_000,
			summary: "delegate completed",
			output: "done",
		};

		const notification = controller.notifyTools([record], true);
		goalStatus = "completed";
		controller.flushProviderBoundary();
		expect(enqueueCustomMessageTurn).not.toHaveBeenCalled();

		releaseIdle();
		await notification;
		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({
				customType: "background-tool-completion",
				content: expect.stringContaining("Parent was not woken"),
			}),
			{ triggerTurn: false, deliverAs: "followUp" },
			lease,
		);
		expect(foreground.releaseSubmission).toHaveBeenCalledWith(lease);
	});

	it("still wakes for a goal-independent tool terminal while the current goal is stopped", async () => {
		const { controller, lease, startCustomMessageTurn } = createController({
			goalId: "goal-stopped",
			status: "completed",
		});

		await controller.notifyTools(
			[
				{
					sessionId: "session-a",
					taskId: "tool-task-1",
					toolCallId: "call-1",
					toolName: "delegate",
					status: "completed",
					startedAt: "2026-08-21T20:00:00.000Z",
					completedAt: "2026-08-21T20:00:01.000Z",
					elapsedBeforeHandoffMs: 15_000,
					summary: "delegate completed",
					output: "done",
				},
			],
			true,
		);

		expect(startCustomMessageTurn).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-tool-completion" }),
			lease,
			undefined,
		);
	});

	it("rechecks goal eligibility after waiting for the foreground lease", async () => {
		const lease = {} as ForegroundSubmissionLease;
		let releaseLease!: () => void;
		const leaseAvailable = new Promise<void>((resolve) => {
			releaseLease = resolve;
		});
		let goalStatus: GoalState["status"] = "active";
		const foreground = {
			waitForIdle: vi.fn(async () => {
				await leaseAvailable;
			}),
			tryAcquireSubmission: vi.fn(() => lease),
			releaseSubmission: vi.fn(),
		} as unknown as ForegroundRecoveryController;
		const sendCustomMessage = vi.fn(async () => undefined);
		const startCustomMessageTurn = vi.fn(async () => ({ completion: Promise.resolve() }));
		const controller = new ForegroundTerminalHandoffController({
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => ({ goalId: "goal-runaway", status: goalStatus }),
			startCustomMessageTurn,
			enqueueCustomMessageTurn: vi.fn(async () => undefined),
			sendCustomMessage,
			warn: vi.fn(),
		});

		const notification = controller.notifyWorkers([
			{ laneId: "worker-late", status: "succeeded", goalId: "goal-runaway" },
		]);
		goalStatus = "blocked";
		releaseLease();
		await notification;

		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-worker-completion" }),
			{ triggerTurn: false, deliverAs: "followUp" },
			lease,
		);
	});

	it("rejects an idle delivery receipt when durable custom-message acceptance fails", async () => {
		const lease = {} as ForegroundSubmissionLease;
		const failure = new Error("session append failed");
		const foreground = {
			waitForIdle: vi.fn(async () => undefined),
			tryAcquireSubmission: vi.fn(() => lease),
			releaseSubmission: vi.fn(),
		} as unknown as ForegroundRecoveryController;
		const controller = new ForegroundTerminalHandoffController({
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => ({ goalId: "goal-active", status: "active" }),
			startCustomMessageTurn: vi.fn(async () => {
				throw failure;
			}),
			enqueueCustomMessageTurn: vi.fn(async () => undefined),
			sendCustomMessage: vi.fn(async () => undefined),
			warn: vi.fn(),
		});

		await expect(
			controller.notifyWorkers([{ laneId: "worker-failed-append", status: "succeeded", goalId: "goal-active" }]),
		).rejects.toThrow(failure);
		expect(foreground.releaseSubmission).toHaveBeenCalledWith(lease);
	});

	it.each<GoalState["status"]>(["paused", "blocked", "usage_limited", "budget_limited", "completed", "cancelled"])(
		"persists a terminal handoff without resurrecting a %s parent",
		async (status) => {
			const { controller, foreground, lease, sendCustomMessage } = createController({
				goalId: "goal-runaway",
				status,
			});

			await controller.notifyWorkers([
				{
					laneId: "worker-late",
					status: "succeeded",
					goalId: "goal-runaway",
				},
			]);

			expect(sendCustomMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					customType: "background-worker-completion",
					content: expect.stringContaining("do not continue or replan automatically"),
				}),
				{ triggerTurn: false, deliverAs: "followUp" },
				lease,
			);
			expect(foreground.releaseSubmission).toHaveBeenCalledWith(lease);
		},
	);

	it("does not wake a newer active goal for an older goal's worker", async () => {
		const { controller, lease, sendCustomMessage } = createController({
			goalId: "goal-new",
			status: "active",
		});

		await controller.notifyWorkers([{ laneId: "worker-old", status: "succeeded", goalId: "goal-old" }]);

		expect(sendCustomMessage).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-worker-completion" }),
			{ triggerTurn: false, deliverAs: "followUp" },
			lease,
		);
	});

	it("still wakes the parent for an eligible terminal handoff", async () => {
		const { controller, lease, startCustomMessageTurn } = createController();

		await controller.notifyWorkers([
			{
				laneId: "worker-active",
				status: "succeeded",
				goalId: "goal-active",
			},
		]);

		expect(startCustomMessageTurn).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-worker-completion" }),
			lease,
			"goal-active",
		);
	});

	it("delivers the complete terminal-output file pointer to the parent", async () => {
		const { controller, startCustomMessageTurn } = createController(undefined, () => ({
			artifacts: [
				{
					artifactId: "worker-output-1",
					kind: "report",
					uri: "file:///tmp/worker-output-1.txt",
					sizeBytes: 75_000,
					createdAt: "2026-08-20T00:00:00.000Z",
					metadata: { source: "worker_terminal_output", complete: true },
				},
			],
		}));

		await controller.notifyWorkers([{ laneId: "worker-output", status: "succeeded" }]);

		expect(startCustomMessageTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("file:///tmp/worker-output-1.txt"),
				details: expect.objectContaining({
					records: [
						expect.objectContaining({
							outputArtifact: expect.objectContaining({ uri: "file:///tmp/worker-output-1.txt" }),
						}),
					],
				}),
			}),
			expect.anything(),
			undefined,
		);
	});

	it("reports records omitted from the bounded parent handoff", async () => {
		const { controller, startCustomMessageTurn } = createController();
		const records = Array.from({ length: 10 }, (_, index) => ({
			laneId: `worker-${index + 1}`,
			status: index === 8 ? ("failed" as const) : index === 9 ? ("blocked" as const) : ("succeeded" as const),
			goalId: "goal-active",
		}));

		await controller.notifyWorkers(records);

		expect(startCustomMessageTurn).toHaveBeenCalledWith(
			expect.objectContaining({
				content: expect.stringContaining("2 additional terminal worker(s) omitted"),
				details: expect.objectContaining({
					records: expect.arrayContaining([expect.objectContaining({ laneId: "worker-8" })]),
				}),
			}),
			expect.anything(),
			"goal-active",
		);
		const calls = startCustomMessageTurn.mock.calls as unknown as Array<
			[{ details?: { records?: readonly unknown[]; summary?: unknown } }]
		>;
		const message = calls[0]?.[0];
		expect(message?.details?.records).toHaveLength(8);
		expect(message?.details?.summary).toEqual({
			kind: "agent",
			totalCount: 10,
			attentionCount: 1,
			failedCount: 1,
			canceledCount: 0,
		});
	});

	it("still wakes for goal-independent work while the current goal is stopped", async () => {
		const { controller, lease, startCustomMessageTurn } = createController({
			goalId: "goal-blocked",
			status: "blocked",
		});

		await controller.notifyWorkers([{ laneId: "worker-independent", status: "succeeded" }]);

		expect(startCustomMessageTurn).toHaveBeenCalledWith(
			expect.objectContaining({ customType: "background-worker-completion" }),
			lease,
			undefined,
		);
	});

	it("acknowledges durable delivery before the induced turn completes while retaining the lease", async () => {
		let finishTurn!: () => void;
		const completion = new Promise<void>((resolve) => {
			finishTurn = resolve;
		});
		const { controller, foreground, lease, startCustomMessageTurn } = createController();
		startCustomMessageTurn.mockResolvedValueOnce({ completion });

		await controller.notifyWorkers([{ laneId: "worker-slow-parent", status: "succeeded", goalId: "goal-active" }]);

		expect(startCustomMessageTurn).toHaveBeenCalledOnce();
		expect(foreground.releaseSubmission).not.toHaveBeenCalled();

		finishTurn();
		await completion;
		await vi.waitFor(() => expect(foreground.releaseSubmission).toHaveBeenCalledWith(lease));
	});

	it("silently consumes a worker terminal observed while it waits for the foreground lease", async () => {
		const lease = {} as ForegroundSubmissionLease;
		let releaseLease!: () => void;
		const leaseAvailable = new Promise<void>((resolve) => {
			releaseLease = resolve;
		});
		const foreground = {
			waitForIdle: vi.fn(async () => {
				await leaseAvailable;
			}),
			tryAcquireSubmission: vi.fn(() => lease),
			releaseSubmission: vi.fn(),
		} as unknown as ForegroundRecoveryController;
		const sendCustomMessage = vi.fn(async () => undefined);
		const startCustomMessageTurn = vi.fn(async () => ({ completion: Promise.resolve() }));
		const controller = new ForegroundTerminalHandoffController({
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => ({ goalId: "goal-active", status: "active" }),
			startCustomMessageTurn,
			enqueueCustomMessageTurn: vi.fn(async () => undefined),
			sendCustomMessage,
			warn: vi.fn(),
		});
		const record = {
			laneId: "worker-observed",
			status: "succeeded" as const,
			goalId: "goal-active",
			completedAt: "2026-08-21T20:00:00.000Z",
		};

		const notification = controller.notifyWorkers([record]);
		Object.assign(record, { observedAt: "2026-08-21T20:00:01.000Z" });
		releaseLease();
		await notification;

		expect(startCustomMessageTurn).not.toHaveBeenCalled();
		expect(sendCustomMessage).not.toHaveBeenCalled();
		expect(foreground.releaseSubmission).toHaveBeenCalledWith(lease);
	});

	it("silently consumes a background tool terminal observed before delivery", async () => {
		const { controller, foreground, lease, sendCustomMessage, startCustomMessageTurn } = createController();

		await controller.notifyTools(
			[
				{
					sessionId: "session-a",
					taskId: "tool-task-1",
					toolCallId: "call-1",
					toolName: "delegate",
					status: "completed",
					startedAt: "2026-08-21T20:00:00.000Z",
					completedAt: "2026-08-21T20:00:01.000Z",
					elapsedBeforeHandoffMs: 15_000,
					summary: "delegate completed",
					output: "done",
					observedAt: "2026-08-21T20:00:02.000Z",
				},
			],
			true,
		);

		expect(startCustomMessageTurn).not.toHaveBeenCalled();
		expect(sendCustomMessage).not.toHaveBeenCalled();
		expect(foreground.releaseSubmission).not.toHaveBeenCalledWith(lease);
	});
});
