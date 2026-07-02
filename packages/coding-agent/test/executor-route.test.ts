import { describe, expect, it } from "vitest";
import { classifyExecutorTurn } from "../src/core/model-router/executor-route.ts";
import type { ToolkitScript } from "../src/core/toolkit/script-registry.ts";

const SCRIPTS: ToolkitScript[] = [
	{ name: "status-report", description: "Print the service status report", runner: "bash", path: "s.sh" },
	{
		name: "restore-db",
		description: "Restore a database environment from backup",
		runner: "bash",
		path: "r.sh",
		danger: true,
	},
	{ name: "update-db", description: "Apply pending migrations to the database schema", runner: "bash", path: "u.sh" },
];

describe("classifyExecutorTurn", () => {
	it("routes exact/direct Level-0 hits on command-shaped prompts", () => {
		expect(classifyExecutorTurn("status-report", SCRIPTS)).toMatchObject({
			execute: true,
			scriptName: "status-report",
		});
	});

	it("never routes ambiguity — that stays with the big model and the reflex brain", () => {
		expect(classifyExecutorTurn("do something about the db please", SCRIPTS).execute).toBe(false);
	});

	it("never routes non-command-shaped prompts even when they mention a script", () => {
		const essay = `please carefully review the following plan and then maybe run status-report if it all looks reasonable to you overall today, thanks a lot friend`;
		expect(classifyExecutorTurn(essay, SCRIPTS)).toMatchObject({ execute: false, reason: "not_command_shaped" });
		expect(classifyExecutorTurn("line one\nstatus-report", SCRIPTS).execute).toBe(false);
	});

	it("no scripts registered -> never routes", () => {
		expect(classifyExecutorTurn("status-report", [])).toMatchObject({ execute: false, reason: "no_toolkit_scripts" });
	});
});

describe("executor turns and the escalation gate", () => {
	it("run_toolkit_script is exempt ONLY on executor_direct routes; other mutating tools still escalate", async () => {
		const { shouldEscalateModelRouterTool } = await import("../src/core/model-router/tool-escalation.ts");
		expect(
			shouldEscalateModelRouterTool({
				tier: "cheap",
				toolName: "run_toolkit_script",
				reasonCode: "executor_direct",
			}),
		).toBe(false);
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "run_toolkit_script" })).toBe(true);
		expect(shouldEscalateModelRouterTool({ tier: "cheap", toolName: "write", reasonCode: "executor_direct" })).toBe(
			true,
		);
	});
});
