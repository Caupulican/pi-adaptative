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
		// Workers aggregate into counts instead of consuming plan-slot width.
		expect(text).toContain("1 agent");
		// The task owns the plan slot; the goal yields to it.
		expect(text).not.toContain("Stabilize the harness");
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

describe("activity lane slots", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	const runtimeTurn = (label: string) => ({
		id: "runtime:turn",
		kind: "runtime" as const,
		label,
		status: "active" as const,
	});
	const tool = (id: string, tag: string) => ({
		id: `background-tool:${id}`,
		kind: "tool" as const,
		label: `${tag} work ${id}`,
		status: "active" as const,
		tag,
	});
	const render = (items: Parameters<typeof renderActivityLaneLine>[1], width: number) =>
		stripAnsi(renderActivityLaneLine(theme, items, width).join("\n"));

	it("anchors the turn slot as 'working' and gives the plan slot to the task step", () => {
		const taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Audit reconcile flow", activeForm: "Auditing reconcile flow", status: "in_progress" },
			"T1",
		);
		const items = [
			runtimeTurn("Confirming duplicate charge risk"),
			...projectActivityLane({ taskState, laneRecords: [] }).active,
		];
		const text = render(items, 100);

		expect(text).toMatch(/^\s*● working\s+Step 1\/1 · Auditing reconcile flow/);
		// The streamed working message never competes with the plan slot.
		expect(text).not.toContain("Confirming duplicate charge risk");
	});

	it("falls back to the working message in the plan slot when no task exists", () => {
		const text = render([runtimeTurn("Confirming duplicate charge risk")], 80);
		expect(text).toMatch(/^\s*● working\s+Confirming duplicate charge risk\s*$/);
	});

	it("aggregates concurrent tools by tag with a bounded group count", () => {
		const items = [
			runtimeTurn("Working..."),
			tool("1", "bash"),
			tool("2", "bash"),
			tool("3", "python"),
			tool("4", "ruby"),
			tool("5", "node"),
		];
		const text = render(items, 100);
		expect(text).toContain("2 bash");
		expect(text).toContain("1 python");
		expect(text).toContain("+1");
		expect(text).not.toContain("tool-task");
	});

	it("normalizes equivalent foreground and background tool tags through one aggregation path", () => {
		const items = [
			{ ...tool("foreground", " Read__File "), id: "tool:foreground" },
			tool("background", "read--file"),
			tool("spaced", "READ  FILE"),
		];
		const text = render(items, 100);

		expect(text).toContain("3 read file");
		expect(text).not.toContain("read_file");
	});

	it("falls back to the activity kind when tag normalization is empty", () => {
		const text = render([tool("empty", " _--_ ")], 100);

		expect(text).toContain("1 tool");
	});

	it("shows only the newest terminal event and keeps load-bearing runtime labels in the turn slot", () => {
		const items = [
			{ id: "e1", kind: "tool" as const, label: "Old finish", status: "success" as const },
			{ id: "e2", kind: "tool" as const, label: "New finish", status: "failure" as const },
			{ id: "runtime:retry", kind: "runtime" as const, label: "Retry 2/5 in 3s", status: "waiting" as const },
		];
		const text = render(items, 90);
		expect(text).toContain("Retry 2/5 in 3s");
		expect(text).toContain("New finish");
		expect(text).not.toContain("Old finish");
	});

	it("drops right slots before squeezing the plan slot, and never exceeds the width", () => {
		const taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "A fairly long step description that needs room", status: "in_progress" },
			"T1",
		);
		const items = [
			runtimeTurn("Working..."),
			tool("1", "bash"),
			tool("2", "python"),
			{ id: "e", kind: "tool" as const, label: "Bash finished", status: "success" as const },
			...projectActivityLane({ taskState, laneRecords: [] }).active,
		];
		for (const width of [24, 32, 40, 56, 72, 120]) {
			const lines = renderActivityLaneLine(theme, items, width);
			expect(lines.length).toBeLessThanOrEqual(1);
			for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
		const narrow = render(items, 40);
		expect(narrow).toContain("Step 1/1");
		expect(narrow).not.toContain("Bash finished");
	});

	it("keeps the queued-messages label visible in the right block", () => {
		const items = [
			runtimeTurn("Working..."),
			{ id: "queue:messages", kind: "queue" as const, label: "Queued 2 · 1 steering", status: "waiting" as const },
		];
		const text = render(items, 80);
		expect(text).toContain("Queued 2 · 1 steering");
	});

	it("keeps queued-message state visible beside an active plan at narrow widths", () => {
		const taskState = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "A fairly long authoritative task description", status: "in_progress" },
			"T1",
		);
		const items = [
			runtimeTurn("Working..."),
			{
				id: "queue:messages",
				kind: "queue" as const,
				label: "Queued 2 · 1 steering · Alt+Up edit",
				status: "waiting" as const,
			},
			...projectActivityLane({ taskState, laneRecords: [] }).active,
		];
		const lines = renderActivityLaneLine(theme, items, 69);
		const text = stripAnsi(lines.join("\n"));

		expect(text).toContain("Step 1/1");
		expect(text).toContain("Queued 2");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(69);
	});
});
