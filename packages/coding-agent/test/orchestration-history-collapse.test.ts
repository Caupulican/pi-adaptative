import type { TUI } from "@caupulican/pi-tui";
import { beforeAll, describe, expect, it } from "vitest";
import { createTaskStepsState } from "../src/core/tasks/task-state.ts";
import { createTaskStepsToolDefinition } from "../src/core/tools/task-steps.ts";
import { ToolExecutionComponent } from "../src/modes/interactive/components/tool-execution.ts";
import { ToolGroupComponent } from "../src/modes/interactive/components/tool-group.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function fakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

describe("orchestration history collapse", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	it("keeps successful task bookkeeping out of collapsed history and available on expansion", () => {
		const state = createTaskStepsState("T0");
		const definition = createTaskStepsToolDefinition({
			getTaskStepsState: () => state,
			saveTaskStepsState: () => {},
		});
		const component = new ToolExecutionComponent(
			"task_steps",
			"task-call-1",
			{ action: "list" },
			{},
			definition,
			fakeTui(),
			process.cwd(),
		);
		component.updateResult({
			content: [{ type: "text", text: "No tracked steps." }],
			details: { action: "list", applied: true, state },
			isError: false,
		});

		expect(component.render(100)).toEqual([]);
		const group = new ToolGroupComponent("task_steps", [component]);
		expect(group.render(100)).toEqual([]);

		group.setExpanded(true);
		expect(stripAnsi(group.render(100).join("\n"))).toContain("[task steps] list");
	});
});
