import { visibleWidth } from "@caupulican/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { addTaskStep, createTaskStepsState, updateTaskStep } from "../src/core/tasks/task-state.ts";
import {
	ActivityLaneComponent,
	projectActivityLane,
	renderActivityLaneLine,
} from "../src/modes/interactive/components/activity-lane.ts";
import { initTheme, theme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("activity lane", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("projects current task, workers, and goal into one bounded horizontal line", () => {
		const taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Implement status lane", activeForm: "Implementing status lane", status: "in_progress" },
			"T1",
		);
		const projection = projectActivityLane({
			taskState,
			goalState: {
				goalId: "goal-1",
				userGoal: "Stabilize the harness",
				status: "active",
				requirements: [],
				evidence: [],
				events: [],
				createdAt: "T0",
				updatedAt: "T1",
				lastProgressAt: "T1",
				stallTurns: 0,
			},
			laneRecords: [{ laneId: "worker-1", type: "worker", status: "running", label: "Fast coder" }],
		});
		const lines = renderActivityLaneLine(theme, projection.active, 62);
		const text = stripAnsi(lines.join("\n"));

		expect(lines).toHaveLength(1);
		expect(text).toContain("Implementing status lane");
		expect(text).toContain("+1");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(62);
	});

	it("does not replay old terminal state when a resumed session is primed", () => {
		let taskState = addTaskStep(createTaskStepsState("T0"), { content: "Already done" }, "T1");
		const step = taskState.steps[0];
		if (!step) throw new Error("test step missing");
		taskState = updateTaskStep(taskState, step.id, { status: "completed", evidence: ["verified"] }, "T2");
		const lane = new ActivityLaneComponent(theme, () => {});

		lane.replaceCanonical("resumed", { taskState, laneRecords: [] });

		expect(lane.getItems()).toEqual([]);
		lane.dispose();
	});

	it("briefly reports a successful transition, then disappears without polling", () => {
		vi.useFakeTimers();
		let renders = 0;
		const lane = new ActivityLaneComponent(theme, () => {
			renders += 1;
		});
		let taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Verify behavior", status: "in_progress" },
			"T1",
		);
		lane.replaceCanonical("session", { taskState, laneRecords: [] });
		const step = taskState.steps[0];
		if (!step) throw new Error("test step missing");
		taskState = updateTaskStep(taskState, step.id, { status: "completed", evidence: ["passed"] }, "T2");

		lane.updateCanonical("session", { taskState, laneRecords: [] });

		expect(lane.getItems()).toEqual([
			expect.objectContaining({ kind: "task", status: "success", label: "Completed · Verify behavior" }),
		]);
		vi.advanceTimersByTime(2_000);
		expect(lane.getItems()).toEqual([]);
		expect(renders).toBeGreaterThanOrEqual(3);
		lane.dispose();
	});

	it("uses a red terminal state for failed workers and expires it", () => {
		vi.useFakeTimers();
		const lane = new ActivityLaneComponent(theme, () => {});
		lane.replaceCanonical("session", {
			laneRecords: [{ laneId: "worker-1", type: "worker", status: "running", label: "Verifier" }],
		});

		lane.updateCanonical("session", {
			laneRecords: [
				{
					laneId: "worker-1",
					type: "worker",
					status: "failed",
					label: "Verifier",
					completedAt: "T2",
				},
			],
		});

		expect(lane.getItems()).toEqual([
			expect.objectContaining({ kind: "worker", status: "failure", label: "failed · Verifier" }),
		]);
		vi.advanceTimersByTime(2_000);
		expect(lane.getItems()).toEqual([]);
		lane.dispose();
	});
});
