/**
 * The turn-economics B6 fix: task_steps state must be visible on an internal (continuation) turn
 * the same way B1 made goal state visible without a get_goal round trip -- by projecting it
 * directly instead of gating it out and hoping the model calls a tool to fetch it itself. Before
 * this fix, agent-session.ts built `task_steps_context` only when `!options?.internalContextType`,
 * so a goal-continuation-triggered prompt (the only caller that ever sets internalContextType, see
 * goal-loop-controller.ts) never saw its own current step. See compact-goal-context.ts's doc
 * comment for the retired hydration-instruction mechanism this replaced.
 *
 * Asserts against `session.agent.state.messages` (the durable, coding-agent-native history) rather
 * than the faux provider's captured wire context: `task_steps_context`/`memory_context`/
 * `pipeline_context` are injected as `role: "custom"` messages by `_promptUnserialized` itself, and
 * that injection is exactly what the internalContextType gate controlled -- this is the layer the
 * B6 defect (and fix) actually lives at. Existing coverage of these same custom messages
 * (agent-session-auto-compaction-queue.test.ts's `admitProviderPlan` helper) uses the same
 * convention of asserting on agent-native state rather than the faux stream function's `contexts`
 * capture.
 *
 * That last point was verified empirically, not assumed: `harness.faux.contexts` never showed
 * task_steps_context in this file's scenarios, with state seeded before `prompt()` both as a single
 * prompt and as a second prompt in a two-prompt run (the structure that reaches the provider
 * correctly in real, `PI_REQUEST_DUMP_DIR`-captured production sessions -- confirmed live by a
 * second reviewer during the B6 investigation). It is a limitation of the faux stream function's
 * request capture, not of the fix: `session.agent.state.messages` and production dumps both show
 * the page landing exactly where the design intends.
 */
import { describe, expect, it } from "vitest";
import { addTaskStep, createTaskStepsState } from "../src/core/tasks/task-state.ts";
import { createHarness } from "./test-harness.ts";

describe("task_steps_context on continuation (internalContextType) turns", () => {
	it("is injected on a goal-continuation-triggered prompt, unlike memory_context/pipeline_context", async () => {
		const harness = createHarness();
		try {
			const state = addTaskStep(
				createTaskStepsState("T0"),
				{ content: "Investigate root cause", status: "in_progress" },
				"T1",
			);
			harness.session.saveTaskStepsStateSnapshot(state);

			await harness.session.prompt("Continue active goal.", {
				internalContextType: "goal_continuation_trigger",
				expandPromptTemplates: false,
				processSlashCommands: false,
			});

			const messages = harness.session.agent.state.messages;
			const taskStepsMessage = messages.find(
				(message) => message.role === "custom" && message.customType === "task_steps_context",
			);
			expect(taskStepsMessage).toBeDefined();
			if (taskStepsMessage?.role !== "custom") throw new Error("Expected task_steps_context");
			expect(taskStepsMessage.content as string).toContain("Investigate root cause");

			// memory_context and pipeline_context stay gated on internalContextType -- this test would
			// also fail (for the wrong reason) if a future change accidentally widened the fix to them,
			// since that's real per-turn setup work an internal continuation should still skip.
			expect(messages.some((message) => message.role === "custom" && message.customType === "memory_context")).toBe(
				false,
			);
			expect(
				messages.some((message) => message.role === "custom" && message.customType === "pipeline_context"),
			).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});

	it("is also injected on an ordinary (non-internal) prompt, unchanged from before B6", async () => {
		const harness = createHarness();
		try {
			const state = addTaskStep(
				createTaskStepsState("T0"),
				{ content: "Write regression test", status: "in_progress" },
				"T1",
			);
			harness.session.saveTaskStepsStateSnapshot(state);

			await harness.session.prompt("Please continue.");

			const messages = harness.session.agent.state.messages;
			const taskStepsMessage = messages.find(
				(message) => message.role === "custom" && message.customType === "task_steps_context",
			);
			expect(taskStepsMessage).toBeDefined();
			if (taskStepsMessage?.role !== "custom") throw new Error("Expected task_steps_context");
			expect(taskStepsMessage.content as string).toContain("Write regression test");
		} finally {
			await harness.cleanup();
		}
	});

	it("stays empty (no task_steps_context at all) on a continuation turn when nothing is open", async () => {
		const harness = createHarness();
		try {
			// No saveTaskStepsStateSnapshot call: formatTaskStepsContext self-gates on "no open
			// steps" regardless of internalContextType, so absence here is not evidence the B6 gate
			// removal broke anything -- it is the pre-existing, still-correct behavior for an empty
			// checklist. Included so a regression that stops self-gating would be caught too.
			await harness.session.prompt("Continue active goal.", {
				internalContextType: "goal_continuation_trigger",
				expandPromptTemplates: false,
				processSlashCommands: false,
			});

			const messages = harness.session.agent.state.messages;
			expect(
				messages.some((message) => message.role === "custom" && message.customType === "task_steps_context"),
			).toBe(false);
		} finally {
			await harness.cleanup();
		}
	});
});
