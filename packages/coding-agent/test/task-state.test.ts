import { describe, expect, it } from "vitest";
import {
	addTaskStep,
	clearTaskSteps,
	compactTaskSteps,
	createTaskStepsState,
	formatTaskSteps,
	formatTaskStepsContext,
	parseTaskStepsState,
	resolveTaskStepSelector,
	setTaskSteps,
	updateTaskStep,
} from "../src/core/tasks/task-state.ts";

describe("task step state", () => {
	it("sets ordered steps and preserves at most one in-progress step", () => {
		const state = setTaskSteps(
			createTaskStepsState("T0"),
			[
				{ content: "Inspect behavior", status: "in_progress" },
				{ content: "Implement fix", status: "in_progress" },
				{ content: "Verify result" },
			],
			"T1",
		);

		expect(state.revision).toBe(1);
		expect(state.steps.map(({ id, content, status }) => ({ id, content, status }))).toEqual([
			{ id: "step-1", content: "Inspect behavior", status: "pending" },
			{ id: "step-2", content: "Implement fix", status: "in_progress" },
			{ id: "step-3", content: "Verify result", status: "pending" },
		]);
		expect(state.nextStepNumber).toBe(4);
	});

	it("adds a step and reuses stable content matches during set", () => {
		let state = addTaskStep(createTaskStepsState("T0"), { content: "Inspect behavior" }, "T1");
		state = addTaskStep(state, { content: "Implement fix" }, "T2");
		state = setTaskSteps(state, [{ content: "Implement fix" }, { content: "Verify result" }], "T3");

		expect(state.steps[0].id).toBe("step-2");
		expect(state.steps[0].createdAt).toBe("T2");
		expect(state.steps[1].id).toBe("step-3");
	});

	it("resolves current, exact IDs, unique prefixes, and content", () => {
		let state = setTaskSteps(
			createTaskStepsState("T0"),
			[{ content: "Inspect behavior", status: "in_progress" }, { content: "Implement native task steps" }],
			"T1",
		);
		state = addTaskStep(state, { content: "Verify migration" }, "T2");

		expect(resolveTaskStepSelector(state.steps, "current").id).toBe("step-1");
		expect(resolveTaskStepSelector(state.steps, "step-2").content).toBe("Implement native task steps");
		expect(resolveTaskStepSelector(state.steps, "step-3").content).toBe("Verify migration");
		expect(resolveTaskStepSelector(state.steps, "implement native").id).toBe("step-2");
	});

	it("rejects ambiguous and missing selectors", () => {
		const state = setTaskSteps(
			createTaskStepsState("T0"),
			[{ content: "Verify unit tests" }, { content: "Verify integration tests" }],
			"T1",
		);

		expect(() => resolveTaskStepSelector(state.steps, "verify")).toThrow(/ambiguous/i);
		expect(() => resolveTaskStepSelector(state.steps, "current")).toThrow(/No in_progress/i);
		expect(() => resolveTaskStepSelector(state.steps, "missing")).toThrow(/not found/i);
	});

	it("updates one step, appends bounded evidence, and demotes the prior active step", () => {
		let state = setTaskSteps(
			createTaskStepsState("T0"),
			[{ content: "Inspect", status: "in_progress" }, { content: "Implement" }],
			"T1",
		);
		state = updateTaskStep(
			state,
			"step-2",
			{ status: "in_progress", note: "Started after root cause", evidence: ["test reproduces", "test reproduces"] },
			"T2",
		);

		expect(state.steps[0].status).toBe("pending");
		expect(state.steps[1]).toMatchObject({
			status: "in_progress",
			notes: ["Started after root cause"],
			evidence: ["test reproduces"],
			updatedAt: "T2",
		});
	});

	it("retains blocked work in open listings and compacts terminal history", () => {
		let state = setTaskSteps(
			createTaskStepsState("T0"),
			[
				{ content: "Done", status: "completed", evidence: ["unit test passed"] },
				{ content: "Blocked", status: "blocked", note: "needs fixture" },
				{ content: "Cancelled", status: "cancelled" },
			],
			"T1",
		);

		expect(formatTaskSteps(state)).toContain("Blocked");
		expect(formatTaskSteps(state)).not.toContain("Done");
		expect(formatTaskSteps(state, { includeTerminal: true })).toContain("Done");

		state = compactTaskSteps(state, "T2");
		expect(state.steps.map((step) => step.content)).toEqual(["Blocked"]);
		expect(state.archive).toEqual({ completed: 1, cancelled: 1, compactedAt: "T2" });
	});

	it("builds a bounded hidden context reminder from open steps", () => {
		const state = setTaskSteps(
			createTaskStepsState("T0"),
			[
				{ content: "Completed history", status: "completed" },
				{ content: "Inspect context", activeForm: "Inspecting context", status: "in_progress" },
				{ content: "Implement context injection" },
			],
			"T1",
		);
		const context = formatTaskStepsContext(state);
		expect(context).toContain("Current native task_steps context for this session");
		expect(context).toContain("[in_progress] Inspecting context");
		expect(context).toContain("[pending] Implement context injection");
		expect(context).not.toContain("Completed history");
		expect(context).not.toContain("step-2");
		expect(context).toContain("Continue the in_progress step");
	});

	it("clears state while preserving the monotonic step number", () => {
		let state = addTaskStep(createTaskStepsState("T0"), { content: "First" }, "T1");
		state = clearTaskSteps(state, "T2");
		state = addTaskStep(state, { content: "Second" }, "T3");
		expect(state.steps[0].id).toBe("step-2");
	});

	it("rejects empty and over-limit input", () => {
		expect(() => addTaskStep(createTaskStepsState("T0"), { content: "   " }, "T1")).toThrow(/content is required/i);
		expect(() => addTaskStep(createTaskStepsState("T0"), { content: "x".repeat(2_001) }, "T1")).toThrow(
			/at most 2000/i,
		);
	});

	it("round-trips valid state and rejects malformed or future versions", () => {
		const state = addTaskStep(createTaskStepsState("T0"), { content: "Persist" }, "T1");
		expect(parseTaskStepsState(JSON.stringify(state))).toEqual(state);
		expect(parseTaskStepsState("not json")).toBeUndefined();
		expect(parseTaskStepsState(JSON.stringify({ ...state, version: 2 }))).toBeUndefined();
		expect(parseTaskStepsState(JSON.stringify({ ...state, steps: [{ id: 3 }] }))).toBeUndefined();
	});
});
