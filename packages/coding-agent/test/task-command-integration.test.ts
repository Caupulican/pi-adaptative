import { describe, expect, it } from "vitest";
import type { TaskStepsState } from "../src/core/tasks/task-state.ts";
import { handleTaskCommand } from "../src/modes/interactive/session-flow-commands.ts";

function createHost() {
	let state: TaskStepsState | undefined;
	const statuses: string[] = [];
	const errors: string[] = [];
	return {
		host: {
			session: {
				getTaskStepsStateSnapshot: () => state,
				saveTaskStepsStateSnapshot: (next: TaskStepsState) => {
					state = next;
					return `snapshot-${next.revision}`;
				},
			},
			showStatus: (message: string) => statuses.push(message),
			showError: (message: string) => errors.push(message),
		},
		getState: () => state,
		statuses,
		errors,
	};
}

describe("native /task command integration", () => {
	it("mutates the same native session state used by task_steps", () => {
		const harness = createHost();
		handleTaskCommand(harness.host, "/task add Inspect native state");
		handleTaskCommand(harness.host, "/task start step-1");
		handleTaskCommand(harness.host, "/task done current -- command test passed");

		expect(harness.errors).toEqual([]);
		expect(harness.getState()?.steps[0]).toMatchObject({
			content: "Inspect native state",
			status: "completed",
			evidence: ["command test passed"],
		});
	});

	it("lists without creating an empty persisted snapshot", () => {
		const harness = createHost();
		handleTaskCommand(harness.host, "/steps");
		expect(harness.getState()).toBeUndefined();
		expect(harness.statuses.at(-1)).toContain("0 tracked");
	});

	it("reports selector errors and native delegation migration guidance", () => {
		const harness = createHost();
		handleTaskCommand(harness.host, "/task done missing");
		expect(harness.errors.at(-1)).toMatch(/not found/i);

		handleTaskCommand(harness.host, "/task run current");
		expect(harness.statuses.at(-1)).toContain("native delegate/delegate_status");
		expect(harness.getState()).toBeUndefined();
	});
});
