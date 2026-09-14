import { describe, expect, it } from "vitest";
import { createTaskStepsState, formatTaskStepsContext, setTaskSteps } from "../src/core/tasks/task-state.ts";
import { classifyShellVerificationCommand, isProjectableTestCommand } from "../src/core/tools/shell-test-command.ts";
import { TestVerificationOutput } from "../src/core/tools/test-verification-output.ts";

describe("harness review regressions", () => {
	it.each(["env", "env.exe", "/usr/bin/env"])("recognizes the executing env wrapper %s", (wrapper) => {
		const command = `${wrapper} NODE_ENV=test vitest run test/a.test.ts`;
		expect(isProjectableTestCommand(command)).toBe(true);
		expect(classifyShellVerificationCommand(command, { cwd: "/workspace", flavor: "posix" })?.runners).toEqual([
			"vitest",
		]);
		expect(isProjectableTestCommand(`${wrapper} -C /elsewhere vitest run`)).toBe(false);
	});
	it("does not infer package identity from workspace containment", () => {
		const context = { cwd: "/workspace", workspaceRoot: "/workspace", flavor: "posix" as const };
		const commands = ["", "PI_PACKAGE_DIR=/workspace/packages/one ", "PI_PACKAGE_DIR=/workspace/packages/two "];
		const groups = commands.map(
			(prefix) => classifyShellVerificationCommand(`${prefix}vitest run`, context)?.repairGroup,
		);
		expect(groups.every(Boolean)).toBe(true);
		expect(new Set(groups).size).toBe(3);
	});
	it.each([
		"Test Files 1 passed (1)\nTest Files 1 failed (1)",
		"Test Files 1 failed (1)\nTest Files 1 passed (1)",
		"Test Files 1 failed | 1 passed (2)",
	])("aggregates contradictory collection evidence: %s", (summary) => {
		const output = new TestVerificationOutput(["vitest"]);
		output.append(Buffer.from(`${summary}\nTests no tests`));
		expect(output.finish(1)).toBe("failed");
		expect(output.executionOutcome).toBe("unconfirmed");
	});
	it.each(["pending", "in_progress"] as const)("keeps the selected %s step in a bounded context window", (status) => {
		const state = setTaskSteps(
			createTaskStepsState("T0"),
			[
				...Array.from({ length: 13 }, (_, index) => ({ content: `Wait ${index}`, status: "blocked" as const })),
				{ content: "Real work", status },
			],
			"T1",
		);
		for (const limit of [1, 12, 100]) {
			const context = formatTaskStepsContext(state, limit)!;
			expect(context).toContain(`[${status}] step-14 Real work`);
			expect(context.match(/^- \[/gm)?.length).toBeLessThanOrEqual(limit);
		}
	});
});
