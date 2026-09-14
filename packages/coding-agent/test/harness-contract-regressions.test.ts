import { VerificationObligationTracker } from "@caupulican/pi-agent-core/verification-obligations";
import { Value } from "typebox/value";
import { describe, expect, it } from "vitest";
import { EDGE_CLASSES } from "../src/core/autonomy/edge-policy.ts";
import { checkTaskStepsContract, INITIAL_TASK_CONTRACT_STREAK } from "../src/core/tasks/task-contract-monitor.ts";
import { createTaskStepsState, formatTaskStepsContext, setTaskSteps } from "../src/core/tasks/task-state.ts";
import { createBashTool } from "../src/core/tools/bash.ts";
import { createGoalToolDefinition } from "../src/core/tools/goal.ts";
import { classifyShellVerificationCommand } from "../src/core/tools/shell-test-command.ts";

describe("harness execution contracts", () => {
	it("advertises exactly the domain edge vocabulary", () => {
		const tool = createGoalToolDefinition({ getGoalState: () => undefined, saveGoalState: () => {} });
		for (const edgeClass of [...EDGE_CLASSES, "push", "tag", "release", "destructive"]) {
			expect(Value.Check(tool.parameters, { action: "grant_edge", edgeClass, quote: "publish" })).toBe(
				EDGE_CLASSES.some((allowed) => allowed === edgeClass),
			);
		}
	});

	it("keeps blocked work visible without asking it to start, and chooses a pending step", () => {
		const blocked = setTaskSteps(
			createTaskStepsState("T0"),
			[{ content: "Wait for access", status: "blocked" }],
			"T1",
		);
		let streak = INITIAL_TASK_CONTRACT_STREAK;
		for (let turn = 0; turn < 5; turn++) {
			const result = checkTaskStepsContract(blocked, streak);
			expect(result.note).toBeUndefined();
			streak = result.streak;
		}
		expect(formatTaskStepsContext(blocked)).toContain("[blocked]");
		expect(formatTaskStepsContext(blocked)).not.toContain("Start first:");
		const mixed = setTaskSteps(
			blocked,
			[
				{ content: "Wait for access", status: "blocked" },
				{ content: "Run independent check", status: "pending" },
			],
			"T2",
		);
		expect(formatTaskStepsContext(mixed)).toContain("Start first: Run independent check");
	});

	it.each(["NODE_ENV=test ", "env NODE_ENV=test "])(
		"observes tests with prefix %s without erasing environment identity",
		(prefix) => {
			const context = { cwd: "/workspace", workspaceRoot: "/workspace", flavor: "posix" as const };
			const direct = classifyShellVerificationCommand("vitest run test/a.test.ts", context);
			const prefixed = classifyShellVerificationCommand(`${prefix}vitest run test/a.test.ts`, context);
			expect(prefixed?.runners).toEqual(["vitest"]);
			expect(prefixed?.id).not.toBe(direct?.id);
			expect(prefixed?.repairGroup).not.toBe(direct?.repairGroup);
		},
	);

	it.each([
		["Test Files 1 failed (1)\nTests no tests\n", true],
		["Tests 1 failed (1)\n", false],
		["runner interrupted\n", false],
	] as const)(
		"reconciles setup repair only with collection evidence and matching environment: %s",
		async (output, clears) => {
			let executions = 0;
			const tool = createBashTool("/workspace", {
				platform: "linux",
				pathFlavor: "posix",
				operations: {
					exec: async (_command, _cwd, options) => {
						const first = executions++ === 0;
						options.onData(Buffer.from(first ? output : "Tests 1 passed (1)\n"));
						return { exitCode: first ? 1 : 0, initialCwd: "/workspace", cwd: "/workspace" };
					},
				},
			});
			const failed = await tool.execute("failed", { command: "vitest run test/a.test.ts" });
			const repaired = await tool.execute("repaired", {
				command: "env vitest run test/a.test.ts",
				repairOf: failed.details?.piVerification?.id,
			});
			expect(repaired.details?.piVerification).toMatchObject({ status: "passed", outcome: "executed" });
			const tracker = new VerificationObligationTracker(
				[failed, repaired].map((result, index) => ({
					role: "toolResult",
					toolCallId: `check-${index}`,
					toolName: "bash",
					timestamp: index,
					content: result.content,
					details: result.details,
					isError: result.isError === true,
				})),
			);
			expect(tracker.getActiveIds()).toEqual(clears ? [] : [failed.details?.piVerification?.id]);
		},
	);
});
