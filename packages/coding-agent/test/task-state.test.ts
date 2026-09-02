import { describe, expect, it } from "vitest";
import { advanceTaskSteps } from "../src/core/pipelines/increment.ts";
import { MAX_PIPELINE_STAGE_ID_LENGTH } from "../src/core/pipelines/types.ts";
import {
	addTaskStep,
	clearTaskSteps,
	compactTaskSteps,
	createTaskStepsState,
	formatTaskSteps,
	formatTaskStepsContext,
	MAX_TASK_STEP_PIPELINE_RUN_ID_LENGTH,
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
		// Ordinal spellings of an id are unambiguous and resolve; a refusal names what can be selected.
		expect(resolveTaskStepSelector(state.steps, "s2").id).toBe("step-2");
		expect(resolveTaskStepSelector(state.steps, "2").id).toBe("step-2");
		expect(resolveTaskStepSelector(state.steps, "step 3").id).toBe("step-3");
		expect(resolveTaskStepSelector(state.steps, "#1").id).toBe("step-1");
		expect(() => resolveTaskStepSelector(state.steps, "s1-1?")).toThrow(
			/not found for selector: s1-1\?\. Open steps: step-1 \(in_progress\)/,
		);
		expect(() => resolveTaskStepSelector(state.steps, "s9")).toThrow(
			/Use an id, a unique id prefix, an ordinal like 2, or current/,
		);
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

	it("names the open steps when 'current' has no in_progress step, instead of silently picking one", () => {
		const state = setTaskSteps(
			createTaskStepsState("T0"),
			[{ content: "Verify unit tests" }, { content: "Verify integration tests", status: "blocked" }],
			"T1",
		);

		expect(() => resolveTaskStepSelector(state.steps, "current")).toThrow(
			/No in_progress task step was found\. Open steps: step-1 \(pending\), step-2 \(blocked\)\./,
		);
	});

	it("reports no open steps at all when 'current' is selected on an empty or fully-terminal checklist", () => {
		const empty = createTaskStepsState("T0");
		expect(() => resolveTaskStepSelector(empty.steps, "current")).toThrow(/no open steps to select/i);

		const allDone = setTaskSteps(empty, [{ content: "Done", status: "completed" }], "T1");
		expect(() => resolveTaskStepSelector(allDone.steps, "current")).toThrow(/no open steps to select/i);
	});

	it("advances by completing the current step and starting the next pending step", () => {
		const state = setTaskSteps(
			createTaskStepsState("T0"),
			[{ content: "Inspect", status: "in_progress" }, { content: "Implement" }, { content: "Verify" }],
			"T1",
		);
		const first = advanceTaskSteps(state, "T2");
		expect(first.result).toMatchObject({ surface: "task_steps", from: "step-1", to: "step-2", completed: false });
		expect(first.state.steps.map((step) => step.status)).toEqual(["completed", "in_progress", "pending"]);
		const last = advanceTaskSteps(advanceTaskSteps(first.state, "T3").state, "T4");
		expect(last.result.completed).toBe(true);
		expect(last.state.steps.every((step) => step.status === "completed")).toBe(true);
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
		expect(context).toContain("TASK STEPS");
		// Every open step's line carries its resolvable id (the fix under test): the model can
		// target any listed step directly, active or not, with no separate lookup.
		expect(context).toContain("[in_progress] step-2 Inspecting context");
		expect(context).toContain("[pending] step-3 Implement context injection");
		expect(context).not.toContain("Completed history");
		expect(context).toContain("continue in_progress step");
	});

	it("resolves an id read straight from the injected context back through resolveTaskStepSelector (round-trip)", () => {
		const state = setTaskSteps(
			createTaskStepsState("T0"),
			[
				{ content: "Inspect context", activeForm: "Inspecting context", status: "in_progress" },
				{ content: "Implement context injection" },
			],
			"T1",
		);
		const context = formatTaskStepsContext(state)!;
		const pendingLine = context.split("\n").find((line) => line.includes("Implement context injection"));
		const [, extractedId] = pendingLine?.match(/^- \[\w+\] (\S+) /) ?? [];
		expect(extractedId).toBe("step-2");

		// The exact id the model just read off the context page resolves without any lookup.
		expect(resolveTaskStepSelector(state.steps, extractedId!).content).toBe("Implement context injection");
	});

	it("surfaces goal requirement and tool_task evidence links on the injected checklist", () => {
		const state = setTaskSteps(
			createTaskStepsState("T0"),
			[
				{
					content: "Wait for compile",
					status: "in_progress",
					requirementIds: ["req-1"],
					evidence: ["tool-task-1"],
				},
			],
			"T1",
		);
		const context = formatTaskStepsContext(state);
		expect(context).toContain("requirements=req-1");
		expect(context).toContain("evidence=tool-task-1");
	});

	it("surfaces exact pipeline run and stage linkage in list and injected context", () => {
		let state = addTaskStep(
			createTaskStepsState("T0"),
			{
				content: "Research",
				pipelineRunId: "run-1",
				pipelineStageId: "01_research",
			},
			"T1",
		);
		expect(formatTaskSteps(state)).toContain("pipeline: run-1/01_research");
		expect(formatTaskStepsContext(state)).toContain("pipeline=run-1/01_research");
		state = updateTaskStep(state, "step-1", { clearPipelineLink: true }, "T2");
		expect(state.steps[0]).not.toHaveProperty("pipelineRunId");
		expect(state.steps[0]).not.toHaveProperty("pipelineStageId");
	});

	it("dedupes a duplicate open add but still allows a terminal same-content re-add", () => {
		const state = addTaskStep(createTaskStepsState("T0"), { content: "Inspect behavior" }, "T1");

		const duplicate = addTaskStep(state, { content: "inspect behavior" }, "T2");
		expect(duplicate).toBe(state);
		expect(duplicate.revision).toBe(state.revision);
		expect(duplicate.steps).toHaveLength(1);

		const completed = updateTaskStep(state, "step-1", { status: "completed", evidence: ["done"] }, "T3");
		const readded = addTaskStep(completed, { content: "Inspect behavior" }, "T4");
		expect(readded.steps.map((step) => step.id)).toEqual(["step-1", "step-2"]);
	});

	it("surfaces a verification nudge in the injected context for a completed step with no evidence", () => {
		let state = setTaskSteps(
			createTaskStepsState("T0"),
			[
				{ content: "Completed without evidence", status: "completed" },
				{ content: "Open work", status: "in_progress" },
			],
			"T1",
		);
		expect(formatTaskStepsContext(state)).toContain(
			"Completed step lacks evidence; attach via task_steps before verified.",
		);

		state = updateTaskStep(state, "step-1", { evidence: ["verified"] }, "T2");
		expect(formatTaskStepsContext(state)).not.toContain("lacks evidence");
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
		const state = addTaskStep(
			createTaskStepsState("T0"),
			{
				content: "Persist",
				requirementIds: ["req-1", "req-1", " req-2 "],
				pipelineRunId: "run-1",
				pipelineStageId: "01_research",
			},
			"T1",
		);
		expect(state.steps[0].requirementIds).toEqual(["req-1", "req-2"]);
		expect(parseTaskStepsState(JSON.stringify(state))).toEqual(state);
		const legacy = JSON.parse(JSON.stringify(state)) as { steps: Array<{ requirementIds?: string[] }> };
		delete legacy.steps[0].requirementIds;
		expect(parseTaskStepsState(JSON.stringify(legacy))?.steps[0].requirementIds).toEqual([]);
		expect(parseTaskStepsState("not json")).toBeUndefined();
		expect(parseTaskStepsState(JSON.stringify({ ...state, version: 2 }))).toBeUndefined();
		expect(parseTaskStepsState(JSON.stringify({ ...state, steps: [{ id: 3 }] }))).toBeUndefined();
	});

	it("requires bounded pipeline run and stage ids as one atomic pair", () => {
		const longestValidStageId = `01_${"a".repeat(63)}`;
		expect(longestValidStageId).toHaveLength(MAX_PIPELINE_STAGE_ID_LENGTH);
		const longestLinked = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Longest valid stage", pipelineRunId: "run-1", pipelineStageId: longestValidStageId },
			"T1",
		);
		expect(longestLinked.steps[0]?.pipelineStageId).toBe(longestValidStageId);
		expect(parseTaskStepsState(JSON.stringify(longestLinked))).toEqual(longestLinked);
		expect(() =>
			addTaskStep(
				createTaskStepsState("T0"),
				{ content: "Oversized stage", pipelineRunId: "run-1", pipelineStageId: `${longestValidStageId}a` },
				"T1",
			),
		).toThrow(new RegExp(`pipeline stage id must be at most ${MAX_PIPELINE_STAGE_ID_LENGTH}`, "i"));
		expect(() =>
			addTaskStep(createTaskStepsState("T0"), { content: "Partial", pipelineRunId: "run-1" }, "T1"),
		).toThrow(/must be supplied together/i);
		expect(() =>
			addTaskStep(
				createTaskStepsState("T0"),
				{
					content: "Oversized",
					pipelineRunId: "r".repeat(MAX_TASK_STEP_PIPELINE_RUN_ID_LENGTH + 1),
					pipelineStageId: "01_research",
				},
				"T1",
			),
		).toThrow(new RegExp(`pipeline run id must be at most ${MAX_TASK_STEP_PIPELINE_RUN_ID_LENGTH}`, "i"));
		expect(() =>
			addTaskStep(
				createTaskStepsState("T0"),
				{
					content: "Conflicting clear",
					pipelineRunId: "run-1",
					pipelineStageId: "01_research",
					clearPipelineLink: true,
				},
				"T1",
			),
		).toThrow(/cannot supply pipeline ids/i);

		const valid = addTaskStep(
			createTaskStepsState("T0"),
			{ content: "Persist", pipelineRunId: "run-1", pipelineStageId: "01_research" },
			"T1",
		);
		const partial = JSON.parse(JSON.stringify(valid)) as { steps: Array<{ pipelineStageId?: string }> };
		delete partial.steps[0].pipelineStageId;
		expect(parseTaskStepsState(JSON.stringify(partial))).toBeUndefined();
		const wrongType = JSON.parse(JSON.stringify(valid)) as { steps: Array<{ pipelineRunId: unknown }> };
		wrongType.steps[0].pipelineRunId = 42;
		expect(parseTaskStepsState(JSON.stringify(wrongType))).toBeUndefined();
	});

	it("replaces and clears explicit goal requirement links", () => {
		let state = addTaskStep(createTaskStepsState("T0"), { content: "Implement", requirementIds: ["req-1"] }, "T1");
		state = updateTaskStep(state, "step-1", { requirementIds: ["req-2"] }, "T2");
		expect(state.steps[0].requirementIds).toEqual(["req-2"]);
		state = updateTaskStep(state, "step-1", { requirementIds: [] }, "T3");
		expect(state.steps[0].requirementIds).toEqual([]);
	});
});
