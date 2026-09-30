import { describe, expect, it } from "vitest";
import { MAX_ORCHESTRATION_ATTEMPTS } from "../src/core/orchestration/contracts.ts";
import { WorkerSemanticSupervisor } from "../src/core/supervision/worker-semantic-supervisor.ts";
import { WorkerSupervisionCoordinator } from "../src/core/supervision/worker-supervision-coordinator.ts";

const HEALTHY_ANSWERS = {
	meaningful_progress: 0.9,
	worker_stuck: 0.1,
	work_off_track: 0.1,
	strategy_repetition: 0.1,
	needs_independent_verification: 0.1,
	specialist_gap_present: 0.1,
	capability_gap_present: 0.1,
	external_block_present: 0.1,
};

function observation(attemptId: string, outputTail = attemptId) {
	return {
		agentId: `agent-${attemptId}`,
		objectiveId: "objective",
		taskId: `task-${attemptId}`,
		attemptId,
		role: "explorer",
		mission: "inspect",
		toolCalls: 4,
		elapsedMs: 10_000,
		outputTail,
		changedFiles: [],
		recentFailures: [],
		recentToolNames: ["read"],
		isRepeating: false,
		isStalled: false,
	};
}

describe("worker supervision retention", () => {
	it("scopes direct semantic evaluations to the exact logical worker task", async () => {
		let options: { evaluationScope?: { kind: string; id: string } } | undefined;
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			decisionEngine: {
				evaluate: async (_program, _state, receivedOptions) => {
					options = receivedOptions;
					return {
						answers: Object.fromEntries(Object.entries(HEALTHY_ANSWERS).map(([id, value]) => [id, { value }])),
					};
				},
			},
		});

		await supervisor.observe({
			objectiveId: "objective/one",
			taskId: "task:two",
			attemptId: "attempt-1",
			role: "explorer",
			mission: "inspect",
			toolCalls: 4,
			elapsedMs: 10_000,
			outputTail: "progress",
		});

		expect(options?.evaluationScope).toEqual({
			kind: "worker-task",
			id: JSON.stringify(["objective/one", "task:two"]),
		});
	});

	it("bounds observational history without evicting pending root-request ownership", async () => {
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			steering: {
				requireCertificate: async (_checkpoint, payload) => {
					const state = payload as { attemptId: string };
					return {
						certificate_id: `cert-${state.attemptId}`,
						answers:
							state.attemptId === "pending"
								? { ...HEALTHY_ANSWERS, specialist_gap_present: 0.95 }
								: HEALTHY_ANSWERS,
					};
				},
			},
		});
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: { steerWorker: () => {}, cancelWorker: () => {} },
		});

		const pending = await coordinator.observe(observation("pending"));
		expect(pending?.action).toBe("request_specialist");
		for (let index = 0; index <= MAX_ORCHESTRATION_ATTEMPTS; index++) {
			await coordinator.observe(observation(`history-${index}`));
		}

		const retainedAttemptIds = coordinator.getSignals().map((signal) => signal.attempt_id);
		expect({
			length: retainedAttemptIds.length,
			first: retainedAttemptIds[0],
			last: retainedAttemptIds.at(-1),
			pending: coordinator.getPendingRootRequests().map((signal) => signal.signal_id),
		}).toEqual({
			length: MAX_ORCHESTRATION_ATTEMPTS,
			first: "history-1",
			last: `history-${MAX_ORCHESTRATION_ATTEMPTS}`,
			pending: [pending?.signal_id],
		});

		coordinator.consumePendingRootRequest(pending!.signal_id);
		expect(coordinator.getPendingRootRequests()).toEqual([]);
		const replacement = await coordinator.observe(observation("pending", "materially changed"));
		expect(replacement?.action).toBe("request_specialist");
		expect(coordinator.getPendingRootRequests().map((signal) => signal.signal_id)).toEqual([replacement?.signal_id]);

		const firstChurn = await coordinator.steerValidationChurn("agent-churn", observation("churn"));
		const secondChurn = await coordinator.steerValidationChurn("agent-churn", observation("churn"));
		expect(firstChurn?.signal_id).not.toBe(secondChurn?.signal_id);
	});

	it("forgets actionable ownership once its attempt is known terminal", async () => {
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			steering: {
				requireCertificate: async () => ({
					certificate_id: "cert-terminal",
					answers: { ...HEALTHY_ANSWERS, specialist_gap_present: 0.95 },
				}),
			},
		});
		let live = true;
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: { steerWorker: () => {}, cancelWorker: () => {} },
			isAttemptLive: () => live,
		});

		const pending = await coordinator.observe(observation("terminal"));
		expect(coordinator.getPendingRootRequests().map((signal) => signal.signal_id)).toEqual([pending?.signal_id]);
		live = false;
		expect(coordinator.getPendingRootRequests()).toEqual([]);
		live = true;
		expect(coordinator.getPendingRootRequests()).toEqual([]);
	});

	it("bounds diagnostic fingerprints and re-reports an entry evicted under saturation", async () => {
		const supervisor = new WorkerSemanticSupervisor({
			debounceMs: 0,
			minToolCalls: 0,
			minElapsedMs: 0,
			decisionEngine: {
				evaluate: async (_program, state) => {
					throw new Error(`semantic failure ${(state as { attemptId: string }).attemptId}`);
				},
			},
		});
		const errors: string[] = [];
		const coordinator = new WorkerSupervisionCoordinator({
			supervisor,
			control: { steerWorker: () => {}, cancelWorker: () => {} },
			onSupervisionError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
		});

		for (let index = 0; index <= MAX_ORCHESTRATION_ATTEMPTS; index++) {
			await coordinator.observe(observation(`error-${index}`));
		}
		await coordinator.observe(observation("error-0"));
		await coordinator.observe(observation("error-2"));

		expect(errors).toHaveLength(MAX_ORCHESTRATION_ATTEMPTS + 2);
		expect(errors.at(-1)).toBe("semantic failure error-0");
	});
});
