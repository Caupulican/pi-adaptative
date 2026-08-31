import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createRepeatedToolFailureResult, rememberToolFailure } from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import type { AgentTool } from "../src/types.ts";

/**
 * Origin: session 01a058a5 (2026-08-31). `tool_task` rejected `timeoutMs` as a forbidden property,
 * printed "Fix timeoutMs: expected forbidden, received number", and then blocked the corrected call
 * ten consecutive times — because `timeoutMs` is a resource-envelope name, stripped from operation
 * identity before hashing, so the repair hashed identically to the call it repaired.
 */
function toolTaskTool(): AgentTool<any> {
	return {
		name: "tool_task",
		label: "tool_task",
		description: "tool_task",
		parameters: Type.Object({ action: Type.String() }),
		async execute() {
			throw new Error("must not execute during admission testing");
		},
	};
}

function bashTool(): AgentTool<any> {
	return {
		name: "bash",
		label: "bash",
		description: "bash",
		parameters: Type.Object({ command: Type.String() }),
		async execute() {
			throw new Error("must not execute during admission testing");
		},
	};
}

describe("validation repair admission", () => {
	it("admits the corrected call after a forbidden envelope field is rejected", () => {
		const tool = toolTaskTool();
		const tracker = new Map();
		const gate = new ToolFailureRecoveryGate();
		const rejected = { action: "wait", taskId: "tool-task-2", timeoutMs: 300_000 };
		const repaired = { action: "wait", taskId: "tool-task-2" };

		gate.apply({
			kind: "unproductive",
			tool,
			args: rejected,
			record: rememberToolFailure(
				tracker,
				"tool_task",
				rejected,
				"rejected",
				"invalid_arguments",
				"Match tool_task arguments to its current schema. Fix timeoutMs: expected forbidden, received number.",
				undefined,
				"validation",
			),
		});

		// Resending the call that was rejected is still refused: nothing about it changed.
		expect(gate.admit(tool, rejected, undefined, [])).toMatchObject({ kind: "blocked" });
		// The call the harness asked for executes, on its first attempt, with no intervening success.
		expect(gate.admit(tool, repaired, undefined, [])).toEqual({ kind: "allowed" });
	});

	it("admits the repair for any resource-envelope name, not just timeoutMs", () => {
		const tool = toolTaskTool();
		const tracker = new Map();
		const gate = new ToolFailureRecoveryGate();
		const rejected = { action: "wait", taskId: "t", wait_ms: 1_000 };

		gate.apply({
			kind: "unproductive",
			tool,
			args: rejected,
			record: rememberToolFailure(
				tracker,
				"tool_task",
				rejected,
				"rejected",
				"invalid_arguments",
				"Fix wait_ms: expected forbidden, received number.",
				undefined,
				"validation",
			),
		});

		expect(gate.admit(tool, rejected, undefined, [])).toMatchObject({ kind: "blocked" });
		expect(gate.admit(tool, { action: "wait", taskId: "t" }, undefined, [])).toEqual({ kind: "allowed" });
	});

	it("keeps execution identity envelope-insensitive so a bound tweak cannot replay a failed command", () => {
		const tool = bashTool();
		const tracker = new Map();
		const gate = new ToolFailureRecoveryGate();
		const args = { command: "npm test", timeout: 60 };

		gate.apply({
			kind: "unproductive",
			tool,
			args,
			record: rememberToolFailure(
				tracker,
				"bash",
				args,
				"failed",
				"exit_1",
				"Repair the workspace before retrying.",
				undefined,
				"execution",
			),
		});

		// The command exited non-zero. Growing its timeout is not a repair, and must not mint a new
		// identity — this is the guarantee the envelope-stripping rule exists to provide.
		const admission = gate.admit(tool, { command: "npm test", timeout: 600 }, undefined, []);
		expect(admission).toMatchObject({ kind: "blocked", envelopeOnlyChange: true });
	});
});

describe("timeout bound escalation", () => {
	const failedAt = (gate: ToolFailureRecoveryGate, tool: AgentTool<any>, tracker: Map<string, any>, timeout: number) =>
		gate.apply({
			kind: "unproductive",
			tool,
			args: { command: "rclone lsjson work:", timeout },
			record: rememberToolFailure(
				tracker,
				"bash",
				{ command: "rclone lsjson work:", timeout },
				"failed",
				"timeout",
				"Operation timed out. Narrow/split work.",
				undefined,
				"timeout",
			),
		});

	it("admits a doubled bound a bounded number of times and then refuses", () => {
		const tool = bashTool();
		const tracker = new Map();
		const gate = new ToolFailureRecoveryGate();
		failedAt(gate, tool, tracker, 60);

		// The timeout class allows one immediate unchanged retry; spend it so the escalation rule is
		// what the rest of this test observes.
		expect(gate.admit(tool, { command: "rclone lsjson work:", timeout: 60 }, undefined, [])).toEqual({
			kind: "allowed",
		});
		expect(gate.admit(tool, { command: "rclone lsjson work:", timeout: 60 }, undefined, [])).toMatchObject({
			kind: "blocked",
		});

		// Raising the bound is the canonical repair for a timeout, and now counts as one.
		expect(gate.admit(tool, { command: "rclone lsjson work:", timeout: 120 }, undefined, [])).toEqual({
			kind: "allowed",
		});
		expect(gate.admit(tool, { command: "rclone lsjson work:", timeout: 240 }, undefined, [])).toEqual({
			kind: "allowed",
		});
		// Two doublings is the cap: past 4x the operation needs narrowing, not more time.
		expect(gate.admit(tool, { command: "rclone lsjson work:", timeout: 480 }, undefined, [])).toMatchObject({
			kind: "blocked",
		});
	});

	it("refuses a bound increase that is not material", () => {
		const tool = bashTool();
		const tracker = new Map();
		const gate = new ToolFailureRecoveryGate();
		failedAt(gate, tool, tracker, 60);

		expect(gate.admit(tool, { command: "rclone lsjson work:", timeout: 60 }, undefined, [])).toEqual({
			kind: "allowed",
		});
		// +1 buys nothing: incrementing its own bound must never bankroll an unbounded replay.
		expect(gate.admit(tool, { command: "rclone lsjson work:", timeout: 61 }, undefined, [])).toMatchObject({
			kind: "blocked",
		});
	});
});

describe("blocked replay notice", () => {
	it("never claims the arguments were unchanged when only the envelope differed", () => {
		const tracker = new Map();
		const record = rememberToolFailure(
			tracker,
			"bash",
			{ command: "npm test", timeout: 60 },
			"failed",
			"exit_1",
			"Repair the workspace before retrying.",
			"1 test failed",
			"execution",
		);

		const envelopeOnly = createRepeatedToolFailureResult(record, true);
		const text = envelopeOnly.content.map((block) => (block.type === "text" ? block.text : "")).join("");
		expect(text).not.toContain("Not executed: unchanged.");
		expect(text).toContain("resource-envelope");

		const genuinelyUnchanged = createRepeatedToolFailureResult(record, false);
		const unchangedText = genuinelyUnchanged.content
			.map((block) => (block.type === "text" ? block.text : ""))
			.join("");
		expect(unchangedText).toContain("Not executed: unchanged.");
	});
});
