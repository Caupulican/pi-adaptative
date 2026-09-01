import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { MAX_PIPELINE_STAGE_ID_LENGTH } from "../src/core/pipelines/types.ts";
import { MAX_TASK_STEP_PIPELINE_RUN_ID_LENGTH, type TaskStepsState } from "../src/core/tasks/task-state.ts";
import { createTaskStepsToolDefinition } from "../src/core/tools/task-steps.ts";

function createHarness(activePipelineScope?: { runId: string; stageIds: readonly string[] }) {
	let state: TaskStepsState | undefined;
	let tick = 0;
	const tool = createTaskStepsToolDefinition({
		getTaskStepsState: () => state,
		saveTaskStepsState: (next) => {
			state = next;
		},
		now: () => `T${tick++}`,
		...(activePipelineScope ? { getActivePipelineScope: () => activePipelineScope } : {}),
	});
	return { tool, getState: () => state };
}

async function execute(tool: ReturnType<typeof createTaskStepsToolDefinition>, input: Record<string, unknown>) {
	return tool.execute("call-1", input, new AbortController().signal, undefined, undefined as never);
}

describe("task_steps tool", () => {
	it("sets, updates, and lists session steps", async () => {
		const harness = createHarness();
		const setResult = await execute(harness.tool, {
			action: "set",
			steps: [{ content: "Inspect", status: "in_progress", requirementIds: ["req-1"] }, { content: "Implement" }],
		});
		expect(setResult.details).toMatchObject({ action: "set", applied: true, stepCount: 2, openStepCount: 2 });

		const updateResult = await execute(harness.tool, {
			action: "update",
			id: "step-1",
			status: "completed",
			evidence: ["focused test passed"],
		});
		expect(updateResult.details).toMatchObject({ action: "update", applied: true });
		expect(harness.getState()?.steps[0]).toMatchObject({
			status: "completed",
			requirementIds: ["req-1"],
			evidence: ["focused test passed"],
		});

		const listResult = await execute(harness.tool, { action: "list" });
		const listContent = listResult.content[0];
		if (listContent?.type !== "text") throw new Error("Expected text task_steps result");
		expect(listContent.text).toContain("Implement");
		expect(listContent.text).not.toContain("focused test passed");
		const allResult = await execute(harness.tool, { action: "list", showCompleted: true });
		const allContent = allResult.content[0];
		if (allContent?.type !== "text") throw new Error("Expected text task_steps result");
		expect(allContent.text).toContain("focused test passed");
	});

	it("supports add, compact, and clear", async () => {
		const harness = createHarness();
		await execute(harness.tool, { action: "add", content: "One", status: "completed" });
		await execute(harness.tool, { action: "add", content: "Two", status: "blocked", note: "waiting" });

		const compactResult = await execute(harness.tool, { action: "compact" });
		expect(compactResult.details).toMatchObject({ action: "compact", applied: true, stepCount: 1 });
		expect(harness.getState()?.archive.completed).toBe(1);

		const clearResult = await execute(harness.tool, { action: "clear" });
		expect(clearResult.details).toMatchObject({ action: "clear", applied: true, stepCount: 0 });
	});

	it("preserves intake items supplied as complete steps", async () => {
		const harness = createHarness();
		await execute(harness.tool, {
			action: "intake",
			steps: [{ content: "Raw idea A" }, { content: "Raw idea A repeated" }, { content: "Raw idea B" }],
		});
		expect(harness.getState()?.steps.map((step) => step.content)).toEqual([
			"Raw idea A",
			"Raw idea A repeated",
			"Raw idea B",
		]);
	});

	it("uses an action-discriminated schema with no runtime contract drift", async () => {
		const harness = createHarness();
		const parameters = harness.tool.parameters;

		expect(Value.Check(parameters, { action: "add" })).toBe(false);
		expect(Value.Check(parameters, { action: "add", content: "Add a step", steps: [] })).toBe(false);
		expect(Value.Check(parameters, { action: "add", content: "Add a step" })).toBe(true);

		expect(Value.Check(parameters, { action: "set" })).toBe(false);
		expect(Value.Check(parameters, { action: "set", steps: [], content: "not applicable" })).toBe(false);
		expect(Value.Check(parameters, { action: "set", steps: [{ content: "Replace list" }] })).toBe(true);
		expect(Value.Check(parameters, { action: "intake" })).toBe(false);
		expect(Value.Check(parameters, { action: "intake", steps: [{ content: "Incoming" }] })).toBe(true);

		// id is optional (omitting it now targets the active step; see the dedicated no-id tests below).
		expect(Value.Check(parameters, { action: "update", content: "Targets the active step" })).toBe(true);
		expect(Value.Check(parameters, { action: "update", id: "", content: "Empty id still rejected" })).toBe(false);
		expect(Value.Check(parameters, { action: "update", id: "step-1", steps: [] })).toBe(false);
		expect(Value.Check(parameters, { action: "update", id: "step-1", content: "Updated" })).toBe(true);
		// Negative controls: all of the non-mutating and lifecycle actions retain their existing legal shape.
		expect(Value.Check(parameters, { action: "list", showCompleted: true, maxItems: 1 })).toBe(true);
		expect(Value.Check(parameters, { action: "clear" })).toBe(true);
		expect(Value.Check(parameters, { action: "compact" })).toBe(true);
		expect(Value.Check(parameters, { action: "advance" })).toBe(true);

		const result = await execute(harness.tool, { action: "add", content: "Add a step" });
		expect(result.details).toMatchObject({ action: "add", applied: true, stepCount: 1 });
	});

	it("returns bounded validation errors without persisting a mutation", async () => {
		const harness = createHarness();
		const result = await execute(harness.tool, { action: "update", id: "missing", status: "completed" });
		expect(result.details).toMatchObject({ action: "update", applied: false });
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text task_steps result");
		expect(content.text).toMatch(/not found/i);
		expect(harness.getState()).toBeUndefined();
	});

	it("targets the active step when update omits id -- the harness resolves it, no lookup round-trip needed", async () => {
		const harness = createHarness();
		await execute(harness.tool, {
			action: "set",
			steps: [{ content: "First", status: "in_progress" }, { content: "Second" }],
		});

		const result = await execute(harness.tool, { action: "update", note: "progress noted", evidence: ["ran it"] });

		expect(result.details).toMatchObject({ action: "update", applied: true });
		expect(harness.getState()?.steps[0]).toMatchObject({
			status: "in_progress",
			notes: ["progress noted"],
			evidence: ["ran it"],
		});
		expect(harness.getState()?.steps[1].status).toBe("pending");
	});

	it("errors informatively -- naming the open steps -- when update omits id and no step is active", async () => {
		const harness = createHarness();
		await execute(harness.tool, {
			action: "set",
			steps: [{ content: "First" }, { content: "Second" }],
		});

		const result = await execute(harness.tool, { action: "update", note: "which one?" });

		expect(result.details).toMatchObject({ action: "update", applied: false });
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text task_steps result");
		// Names both open steps rather than silently picking the first pending one.
		expect(content.text).toMatch(
			/No in_progress task step was found\. Open steps: step-1 \(pending\), step-2 \(pending\)/,
		);
		// The failed lookup did not mutate anything.
		expect(harness.getState()?.steps.map((step) => step.status)).toEqual(["pending", "pending"]);
	});

	it("auto-advances the cursor when completing the active step, without a separate advance call", async () => {
		const harness = createHarness();
		await execute(harness.tool, {
			action: "set",
			steps: [{ content: "First", status: "in_progress" }, { content: "Second" }, { content: "Third" }],
		});

		// No id: omitted id resolves to the active step (step-1).
		const result = await execute(harness.tool, {
			action: "update",
			status: "completed",
			evidence: ["done"],
		});

		expect(result.details).toMatchObject({ action: "update", applied: true, autoPromotedStepId: "step-2" });
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text task_steps result");
		expect(content.text).toMatch(/Auto-started next pending step: step-2/);
		expect(harness.getState()?.steps.map((step) => step.status)).toEqual(["completed", "in_progress", "pending"]);
	});

	it("does not auto-advance when completing a step that was not the active one", async () => {
		const harness = createHarness();
		await execute(harness.tool, {
			action: "set",
			steps: [{ content: "First", status: "in_progress" }, { content: "Second" }, { content: "Third" }],
		});

		// step-2 ("Second") was pending, not active: completing it explicitly must not disturb step-1's cursor.
		const result = await execute(harness.tool, { action: "update", id: "step-2", status: "completed" });

		expect(result.details).toMatchObject({ action: "update", applied: true, autoPromotedStepId: undefined });
		expect(harness.getState()?.steps.map((step) => step.status)).toEqual(["in_progress", "completed", "pending"]);
	});

	it("does not auto-advance a completed active step when there is no pending step left", async () => {
		const harness = createHarness();
		await execute(harness.tool, { action: "add", content: "Only step", status: "in_progress" });

		const result = await execute(harness.tool, { action: "update", status: "completed" });

		expect(result.details).toMatchObject({ action: "update", applied: true, autoPromotedStepId: undefined });
		expect(harness.getState()?.steps[0].status).toBe("completed");
	});

	it("dedupes a duplicate open add, names the existing step, and skips persistence", async () => {
		let state: TaskStepsState | undefined;
		let saveCount = 0;
		const tool = createTaskStepsToolDefinition({
			getTaskStepsState: () => state,
			saveTaskStepsState: (next) => {
				saveCount++;
				state = next;
			},
			now: () => "T",
		});

		await execute(tool, { action: "add", content: "Inspect behavior" });
		expect(saveCount).toBe(1);

		const dupResult = await execute(tool, { action: "add", content: "inspect behavior" });
		expect(saveCount).toBe(1);
		expect(dupResult.details).toMatchObject({ action: "add", applied: true, duplicateOfStepId: "step-1" });
		const dupContent = dupResult.content[0];
		if (dupContent?.type !== "text") throw new Error("Expected text task_steps result");
		expect(dupContent.text).toMatch(/duplicate open step ignored.*step-1/i);
		expect(state?.steps).toHaveLength(1);
	});

	it("still creates a new step when re-adding terminal (completed) content", async () => {
		const harness = createHarness();
		await execute(harness.tool, {
			action: "add",
			content: "Ship release",
			status: "completed",
			evidence: ["shipped"],
		});
		const reAdd = await execute(harness.tool, { action: "add", content: "Ship release" });
		expect(reAdd.details).toMatchObject({ action: "add", applied: true, duplicateOfStepId: undefined });
		expect(harness.getState()?.steps).toHaveLength(2);
	});

	it("surfaces a verification nudge when a completed step has no evidence", async () => {
		const harness = createHarness();
		await execute(harness.tool, { action: "add", content: "Do work", status: "completed" });
		const listResult = await execute(harness.tool, { action: "list" });
		expect(listResult.details).toMatchObject({ verificationNudgeNeeded: true });
		const content = listResult.content[0];
		if (content?.type !== "text") throw new Error("Expected text task_steps result");
		expect(content.text).toMatch(/no evidence attached/i);
	});

	it("names steps silently demoted to pending by a multi-in_progress set", async () => {
		const harness = createHarness();
		await execute(harness.tool, {
			action: "set",
			steps: [{ content: "First", status: "in_progress" }, { content: "Second" }],
		});
		const setResult = await execute(harness.tool, {
			action: "set",
			steps: [{ content: "First" }, { content: "Second", status: "in_progress" }],
		});
		expect(setResult.details).toMatchObject({ action: "set", demotedStepIds: ["step-1"] });
		const content = setResult.content[0];
		if (content?.type !== "text") throw new Error("Expected text task_steps result");
		expect(content.text).toMatch(/demoted to pending because another step became active: step-1/i);
	});

	it("does not report an explicitly updated step as a silent demotion", async () => {
		const harness = createHarness();
		await execute(harness.tool, { action: "add", content: "Active work", status: "in_progress" });
		const updateResult = await execute(harness.tool, { action: "update", id: "step-1", status: "pending" });
		expect(updateResult.details).toMatchObject({ demotedStepIds: undefined });
		const content = updateResult.content[0];
		if (content?.type !== "text") throw new Error("Expected text task_steps result");
		expect(content.text).not.toMatch(/demoted to pending/i);
	});

	it("persists and renders validated pipeline linkage through add and update", async () => {
		const harness = createHarness({ runId: "run-1", stageIds: ["01_research", "02_draft"] });
		const added = await execute(harness.tool, {
			action: "add",
			content: "Research",
			pipelineRunId: "run-1",
			pipelineStageId: "01_research",
		});
		expect(added.details).toMatchObject({ action: "add", applied: true });
		expect(harness.getState()?.steps[0]).toMatchObject({
			pipelineRunId: "run-1",
			pipelineStageId: "01_research",
		});

		const updated = await execute(harness.tool, {
			action: "update",
			id: "step-1",
			pipelineStageId: "02_draft",
		});
		expect(updated.details).toMatchObject({ action: "update", applied: true });
		expect(harness.getState()?.steps[0]).toMatchObject({
			pipelineRunId: "run-1",
			pipelineStageId: "02_draft",
		});
		const content = updated.content[0];
		if (content?.type !== "text") throw new Error("Expected text task_steps result");
		expect(content.text).toContain("pipeline: run-1/02_draft");

		const unlinked = await execute(harness.tool, {
			action: "update",
			id: "step-1",
			clearPipelineLink: true,
		});
		expect(unlinked.details).toMatchObject({ action: "update", applied: true });
		expect(harness.getState()?.steps[0]).not.toHaveProperty("pipelineRunId");
		expect(harness.getState()?.steps[0]).not.toHaveProperty("pipelineStageId");
	});

	it("accepts the pipeline owner's longest valid stage id in its schema and state", async () => {
		const stageId = `01_${"a".repeat(63)}`;
		const runId = "r".repeat(MAX_TASK_STEP_PIPELINE_RUN_ID_LENGTH);
		const input = {
			action: "add",
			content: "Longest valid stage",
			pipelineRunId: runId,
			pipelineStageId: stageId,
		};
		const harness = createHarness({ runId, stageIds: [stageId] });
		expect(stageId).toHaveLength(MAX_PIPELINE_STAGE_ID_LENGTH);
		expect(runId).toHaveLength(MAX_TASK_STEP_PIPELINE_RUN_ID_LENGTH);
		expect(Value.Check(harness.tool.parameters, input)).toBe(true);
		const result = await execute(harness.tool, input);
		expect(result.details).toMatchObject({ action: "add", applied: true });
		expect(harness.getState()?.steps[0]?.pipelineStageId).toBe(stageId);
		expect(Value.Check(harness.tool.parameters, { ...input, pipelineStageId: `${stageId}a` })).toBe(false);
		expect(Value.Check(harness.tool.parameters, { ...input, pipelineRunId: `${runId}a` })).toBe(false);
	});

	it("rejects partial, inactive-run, and unknown-stage pipeline links without persistence", async () => {
		const partial = createHarness({ runId: "run-1", stageIds: ["01_research"] });
		const partialResult = await execute(partial.tool, {
			action: "add",
			content: "Partial link",
			pipelineRunId: "run-1",
		});
		expect(partialResult).toMatchObject({ isError: true, details: { applied: false } });
		expect(partial.getState()).toBeUndefined();

		const wrongRun = createHarness({ runId: "run-1", stageIds: ["01_research"] });
		const wrongRunResult = await execute(wrongRun.tool, {
			action: "add",
			content: "Wrong run",
			pipelineRunId: "run-2",
			pipelineStageId: "01_research",
		});
		expect(wrongRunResult).toMatchObject({ isError: true, details: { applied: false } });
		expect(wrongRun.getState()).toBeUndefined();

		const wrongStage = createHarness({ runId: "run-1", stageIds: ["01_research"] });
		const wrongStageResult = await execute(wrongStage.tool, {
			action: "add",
			content: "Wrong stage",
			pipelineRunId: "run-1",
			pipelineStageId: "99_unknown",
		});
		expect(wrongStageResult).toMatchObject({ isError: true, details: { applied: false } });
		expect(wrongStage.getState()).toBeUndefined();
	});

	it("declares native orchestration guidelines", () => {
		// No barrier: see the removal comment at the `executionMode` declaration site in
		// task-steps.ts, and task-steps-tool-concurrency.test.ts for the correctness proof.
		expect(createHarness().tool.executionMode).toBeUndefined();
		expect(harnessGuidelines(createHarness().tool)).toContain("one in_progress step");
		expect(harnessGuidelines(createHarness().tool)).toContain("first open step");
		expect(harnessGuidelines(createHarness().tool)).toContain("Before final");
		expect(harnessGuidelines(createHarness().tool)).toContain("requirementIds");
		expect(harnessGuidelines(createHarness().tool)).not.toContain("pipelineRunId");
		expect(harnessGuidelines(createHarness().tool)).toContain("multi-step work");
		expect(harnessGuidelines(createHarness().tool)).toContain("Batch transitions");
	});
});

function harnessGuidelines(tool: ReturnType<typeof createTaskStepsToolDefinition>): string {
	return (tool.promptGuidelines ?? []).join("\n");
}
