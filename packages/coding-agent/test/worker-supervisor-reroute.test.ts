import { describe, expect, it } from "vitest";
import { WorkerSemanticSupervisor } from "../src/core/supervision/worker-semantic-supervisor.ts";

const answers = {
	meaningful_progress: 0.05,
	worker_stuck: 0.95,
	strategy_repetition: 0.95,
	work_off_track: 0.05,
	needs_independent_verification: 0.05,
	specialist_gap_present: 0.05,
	capability_gap_present: 0.05,
	external_block_present: 0.05,
};

function supervisor() {
	return new WorkerSemanticSupervisor({
		debounceMs: 0,
		minToolCalls: 0,
		minElapsedMs: 0,
		steering: { requireCertificate: async () => ({ certificate_id: "adverse", answers }) },
	});
}

function observation(attemptId: string, toolCalls: number, isRepeating = false) {
	return {
		objectiveId: "objective",
		taskId: "task",
		attemptId,
		role: "explorer",
		mission: "Review distinct source files",
		toolCalls,
		elapsedMs: 10_000,
		changedFiles: [],
		recentFailures: [],
		isRepeating,
		isStalled: isRepeating,
		outputTail: `Read file ${toolCalls}`,
	};
}

describe("worker reroute evidence", () => {
	it("does not cancel a reader solely because semantic scoring says progress is poor", async () => {
		const instance = supervisor();
		expect((await instance.observe(observation("reader", 4)))?.action).toBe("steer_once");
		expect((await instance.observe(observation("reader", 7)))?.action).toBe("continue");
	});

	it("still reroutes an exactly repeated strategy after the steering grace window", async () => {
		const instance = supervisor();
		expect((await instance.observe(observation("repeat", 4, true)))?.action).toBe("steer_once");
		expect((await instance.observe(observation("repeat", 7, true)))?.action).toBe("stop_and_reroute");
	});
});
