/**
 * Proves `task_steps` executes correctly when scheduled in the SAME parallel batch as another
 * tool call -- the scenario `executionMode: "sequential"` used to prevent by giving `task_steps`
 * its own barrier group (see `packages/agent/src/agent-loop.ts`'s `partitionToolCalls`).
 *
 * That barrier is not required for correctness: `task_steps`'s entire read-modify-write against
 * `TaskStepsState` (`getTaskStepsState` -> reducer -> `saveTaskStepsState`) is fully synchronous,
 * with no `await` anywhere in the chain, so it is already atomic with respect to any other code in
 * the single-threaded JS event loop -- concurrent JS here means cooperative interleaving at await
 * boundaries, and `task_steps` never offers one mid-mutation. See the removal comment at
 * `src/core/tools/task-steps.ts`'s `executionMode` declaration site for the full argument.
 */
import type { AgentTool } from "@caupulican/pi-agent-core";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createTaskStepsToolDefinition } from "../src/core/tools/task-steps.ts";
import { wrapToolDefinition } from "../src/core/tools/tool-definition-wrapper.ts";
import { createHarness, type Harness } from "./test-harness.ts";

describe("task_steps tool concurrency", () => {
	it("commits its read-modify-write correctly alongside a sibling tool call in the same parallel batch", async () => {
		const otherCalls: string[] = [];
		// Declared before the harness that provides its state -- the tool's deps are lazy closures,
		// only invoked once the session actually runs a turn, well after `harness` is assigned below.
		let harness!: Harness;

		const otherTool: AgentTool<any> = {
			name: "other",
			label: "other",
			description: "A sibling tool that yields mid-execution, to force real interleaving.",
			parameters: Type.Object({}),
			// No executionMode: joins the same parallel group task_steps falls into once its own
			// "sequential" barrier is removed.
			execute: async () => {
				// A real yield point mid-execution -- exactly the interleaving window that would expose
				// a torn task_steps read-modify-write if `task_steps.execute()` were not fully atomic.
				await new Promise((resolve) => setTimeout(resolve, 5));
				otherCalls.push("ran");
				return { content: [{ type: "text", text: "other done" }], details: {} };
			},
		};
		const taskStepsTool = wrapToolDefinition(
			createTaskStepsToolDefinition({
				getTaskStepsState: () => harness.session.getTaskStepsStateSnapshot(),
				saveTaskStepsState: (state) => {
					harness.session.saveTaskStepsStateSnapshot(state);
				},
			}),
		);

		harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ id: "call-task-steps", name: "task_steps", args: { action: "add", content: "Ship the fix" } },
						{ id: "call-other", name: "other", args: {} },
					],
				},
				"done",
			],
			baseToolsOverride: { task_steps: taskStepsTool, other: otherTool },
		});

		harness.session.setActiveToolsByName(["task_steps", "other"]);
		await harness.session.prompt("run task_steps and other together");

		expect(otherCalls).toEqual(["ran"]);
		const state = harness.session.getTaskStepsStateSnapshot();
		expect(state?.steps).toHaveLength(1);
		expect(state?.steps[0]).toMatchObject({ content: "Ship the fix" });

		const terminalEntries = harness.sessionManager
			.getBranch()
			.filter((entry) => entry.type === "foreground_tool_terminal");
		expect(terminalEntries).toHaveLength(2);
		expect(
			terminalEntries.every((entry) => entry.type === "foreground_tool_terminal" && entry.outcome === "success"),
		).toBe(true);

		await harness.cleanup();
	});

	it("commits both writes correctly when two task_steps calls land in the same parallel batch", async () => {
		let harness!: Harness;
		const taskStepsTool = wrapToolDefinition(
			createTaskStepsToolDefinition({
				getTaskStepsState: () => harness.session.getTaskStepsStateSnapshot(),
				saveTaskStepsState: (state) => {
					harness.session.saveTaskStepsStateSnapshot(state);
				},
			}),
		);

		harness = createHarness({
			responses: [
				{
					toolCalls: [
						{ id: "call-1", name: "task_steps", args: { action: "add", content: "First step" } },
						{ id: "call-2", name: "task_steps", args: { action: "add", content: "Second step" } },
					],
				},
				"done",
			],
			baseToolsOverride: { task_steps: taskStepsTool },
		});

		harness.session.setActiveToolsByName(["task_steps"]);
		await harness.session.prompt("add two steps in one turn");

		// Neither add call may be lost to a read-modify-write race: both steps must be present, in
		// emission order, with no corruption from the sibling call's own read/write.
		const state = harness.session.getTaskStepsStateSnapshot();
		expect(state?.steps.map((step) => step.content)).toEqual(["First step", "Second step"]);

		await harness.cleanup();
	});
});
