import { describe, expect, it } from "vitest";
import { WorkerSemanticSupervisor } from "../src/core/supervision/worker-semantic-supervisor.ts";
import { WorkerSupervisionCoordinator } from "../src/core/supervision/worker-supervision-coordinator.ts";

function observation(overrides: { toolCalls: number; outputTail: string; role?: string }) {
	return {
		agentId: "worker-1",
		objectiveId: "objective-1",
		taskId: "task-1",
		attemptId: "attempt-1",
		role: overrides.role ?? "explorer",
		mission: "Inspect the failing interaction",
		toolCalls: overrides.toolCalls,
		elapsedMs: 10_000,
		outputTail: overrides.outputTail,
		changedFiles: [],
		recentFailures: [],
		recentToolNames: ["read", "grep", "read"],
		isRepeating: true,
		isStalled: true,
	};
}

describe("worker supervision control delivery", () => {
	it("does not count a rejected semantic steer or reroute a worker that never received it", async () => {
		const supervisor = new WorkerSemanticSupervisor({ debounceMs: 0, minToolCalls: 0, minElapsedMs: 0 });
		const errors: string[] = [];
		const cancelled: string[] = [];
		let steerAttempts = 0;
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: {
				steerWorker: async () => {
					steerAttempts += 1;
					if (steerAttempts === 1) throw new Error("steer transport failed");
				},
				cancelWorker: (agentId) => {
					cancelled.push(agentId);
				},
			},
			onSupervisionError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
		});

		const first = await coordinator
			.observe(observation({ toolCalls: 4, outputTail: "unchanged stalled step" }))
			.catch((error: unknown) => error);
		const second = await coordinator.observe(observation({ toolCalls: 7, outputTail: "unchanged stalled step" }));

		expect({
			first: first instanceof Error ? first.message : first,
			second: second?.action,
			priorSteeringCount: supervisor.getPriorSteeringCount("attempt-1"),
			steerAttempts,
			cancelled,
			signals: coordinator.getSignals().map((signal) => signal.action),
			errors,
		}).toEqual({
			first: undefined,
			second: "steer_once",
			priorSteeringCount: 1,
			steerAttempts: 2,
			cancelled: [],
			signals: ["steer_once"],
			errors: ["steer transport failed"],
		});
	});

	it("negative control: a delivered semantic steer permits reroute only after grace", async () => {
		const supervisor = new WorkerSemanticSupervisor({ debounceMs: 0, minToolCalls: 0, minElapsedMs: 0 });
		const cancelled: string[] = [];
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: {
				steerWorker: () => {},
				cancelWorker: (agentId) => {
					cancelled.push(agentId);
				},
			},
		});

		expect((await coordinator.observe(observation({ toolCalls: 4, outputTail: "first stalled step" })))?.action).toBe(
			"steer_once",
		);
		expect((await coordinator.observe(observation({ toolCalls: 6, outputTail: "inside grace" })))?.action).not.toBe(
			"stop_and_reroute",
		);
		expect((await coordinator.observe(observation({ toolCalls: 7, outputTail: "grace elapsed" })))?.action).toBe(
			"stop_and_reroute",
		);
		expect(cancelled).toEqual(["worker-1"]);
	});

	it("does not retain a reroute signal until cancellation succeeds", async () => {
		const supervisor = new WorkerSemanticSupervisor({ debounceMs: 0, minToolCalls: 0, minElapsedMs: 0 });
		const errors: string[] = [];
		let cancelAttempts = 0;
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: {
				steerWorker: () => {},
				cancelWorker: () => {
					cancelAttempts += 1;
					if (cancelAttempts === 1) throw new Error("cancel transport failed");
				},
			},
			onSupervisionError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
		});

		const first = await coordinator.observe(observation({ toolCalls: 4, outputTail: "first stalled step" }));
		const failedReroute = await coordinator
			.observe(observation({ toolCalls: 7, outputTail: "cancel attempt" }))
			.catch((error: unknown) => error);
		const retriedReroute = await coordinator.observe(observation({ toolCalls: 8, outputTail: "cancel attempt" }));

		expect({
			first: first?.action,
			failedReroute: failedReroute instanceof Error ? failedReroute.message : failedReroute,
			retriedReroute: retriedReroute?.action,
			cancelAttempts,
			signals: coordinator.getSignals().map((signal) => signal.action),
			errors,
		}).toEqual({
			first: "steer_once",
			failedReroute: undefined,
			retriedReroute: "stop_and_reroute",
			cancelAttempts: 2,
			signals: ["steer_once", "stop_and_reroute"],
			errors: ["cancel transport failed"],
		});
	});

	it.each([
		{ label: "steer", previouslySteered: false, toolCalls: 4 },
		{ label: "reroute", previouslySteered: true, toolCalls: 7 },
	] as const)("drops a delayed $label after the logical agent has moved to a newer attempt", async (scenario) => {
		const decisiveStall = {
			meaningful_progress: 0.05,
			worker_stuck: 0.95,
			strategy_repetition: 0.95,
			work_off_track: 0.05,
			needs_independent_verification: 0.05,
			specialist_gap_present: 0.05,
			capability_gap_present: 0.05,
			external_block_present: 0.05,
		};
		let releaseCertificate:
			| ((certificate: { certificate_id: string; answers: typeof decisiveStall }) => void)
			| undefined;
		let markAssessmentStarted: (() => void) | undefined;
		const assessmentStarted = new Promise<void>((resolve) => {
			markAssessmentStarted = resolve;
		});
		const pendingCertificate = new Promise<{ certificate_id: string; answers: typeof decisiveStall }>((resolve) => {
			releaseCertificate = resolve;
		});
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			steering: {
				requireCertificate: async () => {
					markAssessmentStarted?.();
					return pendingCertificate;
				},
			},
		});
		if (scenario.previouslySteered) supervisor.noteSteering("attempt-1", 4);
		let currentAttemptId = "attempt-1";
		const steered: string[] = [];
		const cancelled: string[] = [];
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: {
				steerWorker: (agentId) => {
					steered.push(agentId);
				},
				cancelWorker: (agentId) => {
					cancelled.push(agentId);
				},
			},
			isAttemptLive: (attemptId) => attemptId === currentAttemptId,
		});

		const delayed = coordinator.observe({
			...observation({ toolCalls: scenario.toolCalls, outputTail: "stalled attempt 1", role: "explorer" }),
			agentId: "persistent-agent",
		});
		await assessmentStarted;
		currentAttemptId = "attempt-2";
		releaseCertificate?.({ certificate_id: "decisive-stall", answers: decisiveStall });

		expect(await delayed).toBeUndefined();
		expect(steered).toEqual([]);
		expect(cancelled).toEqual([]);
		expect(coordinator.getSignals().map((signal) => signal.action)).toEqual([]);
	});

	it("drops an aborted semantic result even while the suspended attempt remains live", async () => {
		const decisiveStall = {
			meaningful_progress: 0.05,
			worker_stuck: 0.95,
			strategy_repetition: 0.95,
			work_off_track: 0.05,
			needs_independent_verification: 0.05,
			specialist_gap_present: 0.05,
			capability_gap_present: 0.05,
			external_block_present: 0.05,
		};
		let releaseCertificate:
			| ((certificate: { certificate_id: string; answers: typeof decisiveStall }) => void)
			| undefined;
		let markAssessmentStarted: (() => void) | undefined;
		const assessmentStarted = new Promise<void>((resolve) => {
			markAssessmentStarted = resolve;
		});
		const pendingCertificate = new Promise<{ certificate_id: string; answers: typeof decisiveStall }>((resolve) => {
			releaseCertificate = resolve;
		});
		const controller = new AbortController();
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			steering: {
				requireCertificate: async () => {
					markAssessmentStarted?.();
					return pendingCertificate;
				},
			},
		});
		supervisor.noteSteering("attempt-1", 4);
		const cancelled: string[] = [];
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: {
				steerWorker: () => {},
				cancelWorker: (agentId) => {
					cancelled.push(agentId);
				},
			},
			// The session treats suspended attempts as resumable, so liveness alone does not fence abort.
			isAttemptLive: () => true,
		});

		const delayed = coordinator.observe(
			observation({ toolCalls: 7, outputTail: "stalled attempt 1" }),
			controller.signal,
		);
		await assessmentStarted;
		controller.abort();
		releaseCertificate?.({ certificate_id: "decisive-stall", answers: decisiveStall });

		expect(await delayed).toBeUndefined();
		expect(cancelled).toEqual([]);
		expect(coordinator.getSignals()).toEqual([]);
	});

	it("still applies decisive supervision to the current attempt", async () => {
		const supervisor = new WorkerSemanticSupervisor({ debounceMs: 0, minToolCalls: 0, minElapsedMs: 0 });
		supervisor.noteSteering("attempt-1", 4);
		const cancelled: string[] = [];
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: {
				steerWorker: () => {},
				cancelWorker: (agentId) => {
					cancelled.push(agentId);
				},
			},
			isAttemptLive: (attemptId) => attemptId === "attempt-1",
		});

		const result = await coordinator.observe(observation({ toolCalls: 7, outputTail: "stalled attempt 1" }));
		expect(result?.action).toBe("stop_and_reroute");
		expect(cancelled).toEqual(["worker-1"]);
	});

	it("does not count a rejected validation-churn steer or reroute on the next window", async () => {
		const supervisor = new WorkerSemanticSupervisor({ debounceMs: 0, minToolCalls: 0, minElapsedMs: 0 });
		const errors: string[] = [];
		const cancelled: string[] = [];
		let steerAttempts = 0;
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: {
				steerWorker: () => {
					steerAttempts += 1;
					if (steerAttempts === 1) throw new Error("churn steer failed");
				},
				cancelWorker: (agentId) => {
					cancelled.push(agentId);
				},
			},
			onSupervisionError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
		});
		const churn = (toolCalls: number) => ({
			...observation({ toolCalls, outputTail: `validation ${toolCalls}`, role: "implementer" }),
			recentToolNames: ["bash", "bash", "bash"],
			changedFileCountAtWindowStart: 1,
			changedFileCount: 1,
		});

		const first = await coordinator.observe(churn(4)).catch((error: unknown) => error);
		const second = await coordinator.observe(churn(7));

		expect({
			first: first instanceof Error ? first.message : first,
			second: second?.action,
			priorSteeringCount: supervisor.getPriorSteeringCount("attempt-1"),
			steerAttempts,
			cancelled,
			signals: coordinator.getSignals().map((signal) => signal.action),
			errors,
		}).toEqual({
			first: undefined,
			second: "steer_once",
			priorSteeringCount: 1,
			steerAttempts: 2,
			cancelled: [],
			signals: ["steer_once"],
			errors: ["churn steer failed"],
		});
	});
});
