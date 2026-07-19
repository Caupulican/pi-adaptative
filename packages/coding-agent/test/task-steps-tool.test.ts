import { describe, expect, it } from "vitest";
import type { TaskStepsState } from "../src/core/tasks/task-state.ts";
import { createTaskStepsToolDefinition } from "../src/core/tools/task-steps.ts";

function createHarness() {
	let state: TaskStepsState | undefined;
	let tick = 0;
	const tool = createTaskStepsToolDefinition({
		getTaskStepsState: () => state,
		saveTaskStepsState: (next) => {
			state = next;
		},
		now: () => `T${tick++}`,
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
			steps: [{ content: "Inspect", status: "in_progress" }, { content: "Implement" }],
		});
		expect(setResult.details).toMatchObject({ action: "set", applied: true, stepCount: 2, openStepCount: 2 });

		const updateResult = await execute(harness.tool, {
			action: "update",
			id: "step-1",
			status: "completed",
			evidence: ["focused test passed"],
		});
		expect(updateResult.details).toMatchObject({ action: "update", applied: true });
		expect(harness.getState()?.steps[0]).toMatchObject({ status: "completed", evidence: ["focused test passed"] });

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

	it("returns bounded validation errors without persisting a mutation", async () => {
		const harness = createHarness();
		const result = await execute(harness.tool, { action: "update", id: "missing", status: "completed" });
		expect(result.details).toMatchObject({ action: "update", applied: false });
		const content = result.content[0];
		if (content?.type !== "text") throw new Error("Expected text task_steps result");
		expect(content.text).toMatch(/not found/i);
		expect(harness.getState()).toBeUndefined();
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

	it("declares native orchestration guidelines", () => {
		expect(harnessGuidelines(createHarness().tool)).toContain("exactly one step in_progress");
		expect(harnessGuidelines(createHarness().tool)).toContain("first open task step");
		expect(harnessGuidelines(createHarness().tool)).toContain("Drain task_steps");
	});
});

function harnessGuidelines(tool: ReturnType<typeof createTaskStepsToolDefinition>): string {
	return (tool.promptGuidelines ?? []).join("\n");
}
