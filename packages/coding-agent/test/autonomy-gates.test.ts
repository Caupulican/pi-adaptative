import { describe, expect, it } from "vitest";
import type { GateOutcome, GateOutcomeKind } from "../src/core/autonomy/contracts.ts";
import { combineGateOutcomes, fallbackGateOutcome } from "../src/core/autonomy/gates.ts";

describe("Autonomy Gates", () => {
	describe("combineGateOutcomes", () => {
		it("uses most restrictive outcome", () => {
			const outcomes: readonly GateOutcome[] = [
				{ outcome: "allow", gate: "g1", reasonCode: "r1" },
				{ outcome: "downgrade", gate: "g2", reasonCode: "r2" },
				{ outcome: "escalate", gate: "g3", reasonCode: "r3" },
				{ outcome: "ask-user", gate: "g4", reasonCode: "r4" },
				{ outcome: "block", gate: "g5", reasonCode: "r5" },
			];
			const combined = combineGateOutcomes(outcomes);
			expect(combined.outcome).toBe("block");
			expect(combined.gate).toBe("g5");
			expect(combined.reasonCode).toBe("r5");
		});

		it("defaults empty input to ask-user with reasonCode no_gate_outcomes", () => {
			const combined = combineGateOutcomes([]);
			expect(combined.outcome).toBe("ask-user");
			expect(combined.gate).toBe("gate-combiner");
			expect(combined.reasonCode).toBe("no_gate_outcomes");
		});

		it("keeps deterministic first most-restrictive outcome on ties", () => {
			const outcomes: readonly GateOutcome[] = [
				{ outcome: "ask-user", gate: "g1", reasonCode: "r1" },
				{ outcome: "block", gate: "first-block", reasonCode: "r2" },
				{ outcome: "block", gate: "second-block", reasonCode: "r3" },
			];
			const combined = combineGateOutcomes(outcomes);
			expect(combined.outcome).toBe("block");
			expect(combined.gate).toBe("first-block");
			expect(combined.reasonCode).toBe("r2");
		});

		it("does not allow malformed outcome values", () => {
			const outcomes: readonly GateOutcome[] = [
				{ outcome: "allow", gate: "g1", reasonCode: "r1" },
				{ outcome: "malformed" as unknown as GateOutcomeKind, gate: "g2", reasonCode: "r2" },
			];
			const combined = combineGateOutcomes(outcomes);
			expect(combined.outcome).toBe("block");
			expect(combined.gate).toBe("g2");
			expect(combined.reasonCode).toBe("r2");
		});
	});

	describe("fallbackGateOutcome", () => {
		it("blocks irreversible operations", () => {
			const outcome = fallbackGateOutcome({
				gate: "test-gate",
				reversible: false,
				reasonCode: "test-reason",
			});
			expect(outcome.outcome).toBe("block");
			expect(outcome.gate).toBe("test-gate");
			expect(outcome.reasonCode).toBe("test-reason");
		});

		it("asks for reversible operations", () => {
			const outcome = fallbackGateOutcome({
				gate: "test-gate",
				reversible: true,
				reasonCode: "test-reason",
			});
			expect(outcome.outcome).toBe("ask-user");
			expect(outcome.gate).toBe("test-gate");
			expect(outcome.reasonCode).toBe("test-reason");
		});

		it("coerces empty gate and reasonCode to defaults", () => {
			const outcome = fallbackGateOutcome({
				gate: "",
				reversible: true,
				reasonCode: "",
			});
			expect(outcome.gate).toBe("unknown_gate");
			expect(outcome.reasonCode).toBe("unknown_reason");
		});
	});
});
