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
		acquireSubmission: vi.fn(async () => lease),
		releaseSubmission: vi.fn(),
	} as unknown as ForegroundRecoveryController;
	const sendCustomMessage = vi.fn(async () => undefined);
	const startCustomMessageTurn = vi.fn(async () => ({ completion: Promise.resolve() }));
	const controller = new ForegroundTerminalHandoffController({
		foreground,
		isDisposed: () => false,
		getGoalStateSnapshot: () => goal,
		...(getWorkerResult ? { getWorkerResult } : {}),
		startCustomMessageTurn,
		sendCustomMessage,
		warn: vi.fn(),
	});
	return { controller, foreground, lease, sendCustomMessage, startCustomMessageTurn };
}

describe("ForegroundTerminalHandoffController", () => {
	it("rechecks goal eligibility after waiting for the foreground lease", async () => {
		const lease = {} as ForegroundSubmissionLease;
		let releaseLease!: () => void;
		const leaseAvailable = new Promise<void>((resolve) => {
			releaseLease = resolve;
		});
		let goalStatus: GoalState["status"] = "active";
		const foreground = {
			acquireSubmission: vi.fn(async () => {
				await leaseAvailable;
				return lease;
			}),
			releaseSubmission: vi.fn(),
		} as unknown as ForegroundRecoveryController;
		const sendCustomMessage = vi.fn(async () => undefined);
		const startCustomMessageTurn = vi.fn(async () => ({ completion: Promise.resolve() }));
		const controller = new ForegroundTerminalHandoffController({
			foreground,
			isDisposed: () => false,
			getGoalStateSnapshot: () => ({ goalId: "goal-runaway", status: goalStatus }),
			startCustomMessageTurn,
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
});
