import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { describeOperationOutcome } from "../src/tool-failure-memory.ts";
import { ToolFailureRecoveryGate } from "../src/tool-failure-recovery-gate.ts";
import type { AgentTool } from "../src/types.ts";

const parameters = Type.Object({ command: Type.String(), timeout: Type.Number() });
const tool: AgentTool<typeof parameters> = {
	name: "reservation_fixture",
	label: "Reservation fixture",
	description: "Retry reservation fixture",
	parameters,
	failureRecovery: { getTimeoutMs: ({ timeout }) => timeout * 1000 },
	async execute() {
		throw new Error("Gate-only fixture must not execute");
	},
};
const args = { command: "fixture", timeout: 60 };

function fail(gate: ToolFailureRecoveryGate, command = args.command): void {
	const failedArgs = { ...args, command };
	gate.apply({
		kind: "unproductive",
		tool,
		args: failedArgs,
		record: describeOperationOutcome(tool.name, failedArgs, "timeout", "Timed out"),
	});
}

function reserve(gate: ToolFailureRecoveryGate, timeout = args.timeout) {
	const admission = gate.reserve(tool, { ...args, timeout }, undefined);
	expect(admission.kind).toBe("allowed");
	if (admission.kind !== "allowed") throw new Error("Expected a retry reservation");
	return admission.reservation;
}

describe("retry credit reservation", () => {
	it("refunds an unstarted retry once and prevents concurrent double spending", () => {
		const gate = new ToolFailureRecoveryGate();
		fail(gate);
		const pending = reserve(gate);
		expect(gate.reserve(tool, args, undefined).kind).toBe("blocked");
		pending.cancel();
		pending.cancel();
		pending.commit();
		const retry = reserve(gate);
		retry.commit();
		retry.cancel();
		expect(gate.reserve(tool, args, undefined).kind).toBe("blocked");
	});

	it.each([false, true])(
		"removes canceled bound reservations without a fictitious baseline, reverse=%s",
		(reverse) => {
			const gate = new ToolFailureRecoveryGate();
			fail(gate);
			gate.admit(tool, args, undefined);
			const first = reserve(gate, 120);
			const second = reserve(gate, 240);
			expect(gate.reserve(tool, { ...args, timeout: 480 }, undefined).kind).toBe("blocked");
			for (const lease of reverse ? [second, first] : [first, second]) lease.cancel();
			reserve(gate, 120).commit();
			reserve(gate, 240).commit();
			expect(gate.reserve(tool, { ...args, timeout: 480 }, undefined).kind).toBe("blocked");
		},
	);

	it("retains a committed sibling's bound when an earlier reservation is canceled", () => {
		const gate = new ToolFailureRecoveryGate();
		fail(gate);
		gate.admit(tool, args, undefined);
		const first = reserve(gate, 120);
		const second = reserve(gate, 240);
		second.commit();
		first.cancel();
		expect(gate.reserve(tool, { ...args, timeout: 240 }, undefined).kind).toBe("blocked");
		reserve(gate, 480).commit();
		expect(gate.reserve(tool, { ...args, timeout: 960 }, undefined).kind).toBe("blocked");
	});

	it("does not refund an older reservation into a new failure episode", () => {
		const gate = new ToolFailureRecoveryGate();
		fail(gate);
		const old = reserve(gate);
		gate.noteWorldAdvance();
		fail(gate);
		old.cancel();
		reserve(gate).commit();
		expect(gate.reserve(tool, args, undefined).kind).toBe("blocked");
	});

	it("retains pending debt across cache pressure and same-episode observations", () => {
		const gate = new ToolFailureRecoveryGate();
		fail(gate);
		const pending = reserve(gate);
		for (let index = 0; index < 70; index++) fail(gate, `other-${index}`);
		expect(gate.reserve(tool, args, undefined).kind).toBe("blocked");
		fail(gate);
		pending.cancel();
		reserve(gate).commit();
		expect(gate.reserve(tool, args, undefined).kind).toBe("blocked");
	});
});
