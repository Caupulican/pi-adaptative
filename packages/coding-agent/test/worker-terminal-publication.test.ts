import { afterEach, describe, expect, it, vi } from "vitest";
import type { LaneRecord } from "../src/core/autonomy/lane-tracker.ts";
import { WorkerDelegationController } from "../src/core/delegation/worker-delegation-controller.ts";
import {
	type WorkerTerminalHandoff,
	WorkerTerminalHandoffCoordinator,
	type WorkerTerminalHandoffDelivery,
} from "../src/core/delegation/worker-terminal-handoff-coordinator.ts";

type TerminalPublicationController = {
	publishTerminalRecord(record: LaneRecord): void;
	deliverTerminalHandoff(handoff: Readonly<WorkerTerminalHandoff>): WorkerTerminalHandoffDelivery;
	publishedTerminalAttemptIds: Set<string>;
	terminalHandoffs: WorkerTerminalHandoffCoordinator;
};

function terminalPublicationHarness(failureEdge?: "snapshot" | "telemetry") {
	const record: LaneRecord = {
		laneId: "child-task",
		type: "worker",
		status: "succeeded",
		completedAt: "2026-08-06T00:00:00.000Z",
	};
	let notificationStatus: "pending" | "delivered" = "pending";
	const appendCustomEntry = vi.fn(() => {
		if (failureEdge === "snapshot") throw new Error("simulated terminal snapshot failure");
		return "snapshot-entry";
	});
	const emitAutonomyTelemetry = vi.fn(() => {
		if (failureEdge === "telemetry") throw new Error("simulated terminal telemetry failure");
	});
	const emit = vi.fn();
	const deliverWorkerTerminalHandoff = vi.fn(() => ({
		messageId: "worker-message-terminal",
		started: false,
		accepted: true,
	}));
	const markNotificationsDelivered = vi.fn(() => {
		notificationStatus = "delivered";
	});
	const signalStateChanged = vi.fn();
	const statusChanged = vi.fn();
	const recordTerminal = vi.fn();

	const controller = Object.create(WorkerDelegationController.prototype) as WorkerDelegationController;
	Object.assign(controller as object, {
		publishedTerminalAttemptIds: new Set<string>(),
		recovery: { clearScheduledRetry: vi.fn() },
		lifecycle: {
			getActiveAttempt: () => ({
				attemptId: "attempt-child-terminal",
				agentId: "child",
				dispatch: { logicalLaneId: "child" },
			}),
			getAgent: (agentId: string) => (agentId === "child" ? { parentAgentId: "parent" } : undefined),
			getTerminalNotification: () => ({
				notificationId: "notification-child-terminal",
				status: notificationStatus,
			}),
			markNotificationsDelivered,
		},
		agentControl: { deliverWorkerTerminalHandoff, signalStateChanged },
		notifications: { statusChanged, recordTerminal },
		deps: {
			isDisposed: () => false,
			getSessionManager: () => ({ appendCustomEntry }),
			emitAutonomyTelemetry,
			emit,
		},
	});
	const internal = controller as unknown as TerminalPublicationController;
	internal.terminalHandoffs = new WorkerTerminalHandoffCoordinator({
		deliver: (handoff) => internal.deliverTerminalHandoff(handoff),
	});

	return {
		publish: () => internal.publishTerminalRecord(record),
		signal: () => internal.terminalHandoffs.signal(),
		publishedTerminalAttemptIds: internal.publishedTerminalAttemptIds,
		appendCustomEntry,
		emitAutonomyTelemetry,
		emit,
		deliverWorkerTerminalHandoff,
		markNotificationsDelivered,
		signalStateChanged,
		statusChanged,
		recordTerminal,
		getNotificationStatus: () => notificationStatus,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("WorkerDelegationController terminal publication", () => {
	it.each(["snapshot", "telemetry"] as const)(
		"keeps accepted terminal delivery fenced when the %s observer throws",
		(failureEdge) => {
			const harness = terminalPublicationHarness(failureEdge);

			expect(harness.publish).not.toThrow();
			expect(harness.getNotificationStatus()).toBe("delivered");
			expect(harness.deliverWorkerTerminalHandoff).toHaveBeenCalledOnce();
			expect(harness.markNotificationsDelivered).toHaveBeenCalledOnce();
			expect(harness.publishedTerminalAttemptIds).toEqual(new Set(["attempt-child-terminal"]));

			harness.publish();
			expect(harness.deliverWorkerTerminalHandoff).toHaveBeenCalledOnce();
			expect(harness.markNotificationsDelivered).toHaveBeenCalledOnce();
			expect(harness.emit).toHaveBeenCalledWith(
				expect.objectContaining({ type: "warning", message: expect.stringContaining(`terminal ${failureEdge}`) }),
			);
		},
	);

	it("preserves the successful observer path as a negative control", () => {
		const harness = terminalPublicationHarness();

		expect(harness.publish).not.toThrow();
		expect(harness.appendCustomEntry).toHaveBeenCalledOnce();
		expect(harness.emitAutonomyTelemetry).toHaveBeenCalledOnce();
		expect(harness.emit).not.toHaveBeenCalled();
		expect(harness.signalStateChanged).toHaveBeenCalledOnce();
		expect(harness.statusChanged).toHaveBeenCalledOnce();
	});

	it.each(["throw", "reject"] as const)(
		"retains a parent terminal handoff after the first %s and retries on an explicit state signal",
		(failureMode) => {
			const harness = terminalPublicationHarness();
			harness.deliverWorkerTerminalHandoff.mockImplementationOnce(() => {
				if (failureMode === "throw") throw new Error("simulated transient parent handoff failure");
				return {
					messageId: "worker-message-terminal",
					started: false,
					accepted: false,
					skipReason: "simulated_backpressure",
				};
			});

			expect(harness.publish).not.toThrow();
			expect(harness.getNotificationStatus()).toBe("pending");
			expect(harness.markNotificationsDelivered).not.toHaveBeenCalled();
			expect(harness.recordTerminal).not.toHaveBeenCalled();
			expect(harness.publishedTerminalAttemptIds).toEqual(new Set());

			harness.signal();
			expect(harness.getNotificationStatus()).toBe("delivered");
			expect(harness.markNotificationsDelivered).toHaveBeenCalledOnce();
			expect(harness.publishedTerminalAttemptIds).toEqual(new Set(["attempt-child-terminal"]));
			expect(harness.deliverWorkerTerminalHandoff).toHaveBeenCalledTimes(2);

			harness.publish();
			expect(harness.deliverWorkerTerminalHandoff).toHaveBeenCalledTimes(2);
		},
	);

	it("retains an accepted parent handoff until an explicit state signal can commit its notification", () => {
		const harness = terminalPublicationHarness();
		harness.markNotificationsDelivered.mockImplementationOnce(() => {
			throw new Error("simulated notification commit failure");
		});

		expect(harness.publish).not.toThrow();
		expect(harness.getNotificationStatus()).toBe("pending");
		expect(harness.deliverWorkerTerminalHandoff).toHaveBeenCalledOnce();
		expect(harness.markNotificationsDelivered).toHaveBeenCalledOnce();
		expect(harness.publishedTerminalAttemptIds).toEqual(new Set());

		harness.signal();

		expect(harness.getNotificationStatus()).toBe("delivered");
		expect(harness.deliverWorkerTerminalHandoff).toHaveBeenCalledTimes(2);
		expect(harness.markNotificationsDelivered).toHaveBeenCalledTimes(2);
		expect(harness.publishedTerminalAttemptIds).toEqual(new Set(["attempt-child-terminal"]));
	});
});
