import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { applyGoalEvent, createGoalState } from "../src/core/goals/goal-state.ts";
import { createGoalToolDefinition } from "../src/core/tools/goal.ts";

describe("autonomous completion after an earlier refusal", () => {
	it.each([false, true])("rechecks current evidence with active verification=%s", async (activeVerification) => {
		const view = { objective: "Ship the verified fix" };
		let state = applyGoalEvent(createGoalState({ goalId: "goal", userGoal: "Ship the verified fix", now: "T0" }), {
			type: "completion_rejected",
			fingerprint: createHash("sha256").update(JSON.stringify(view)).digest("hex").slice(0, 16),
			reasons: ["Uncertain semantic scope judgment"],
			now: "T1",
		});
		const evaluate = vi.fn(async () => ({
			verdict: "complete" as const,
			failed_gates: [],
			advisories: [{ id: "scope", reason: "Scope uncertain", required_next_proof: "Inspect scope" }],
		}));
		const tool = createGoalToolDefinition({
			getGoalState: () => state,
			saveGoalState: (next) => {
				state = next;
			},
			requireVerifiedEvidenceForCompletion: () => false,
			getActiveVerificationIds: () => (activeVerification ? ["regression"] : []),
			getSystemOneController: () => ({
				completionView: () => ({ view, repositoryOutcome: true }),
				executeCompletionTransaction: evaluate,
			}),
		});
		const result = await tool.execute(
			"complete",
			{ action: "complete" },
			undefined,
			undefined,
			undefined as unknown as ExtensionContext,
		);
		expect(result.isError === true).toBe(activeVerification);
		expect(state.status).toBe(activeVerification ? "active" : "completed");
		expect(evaluate).toHaveBeenCalledTimes(activeVerification ? 0 : 1);
		if (!activeVerification)
			expect(result.content).toEqual([
				expect.objectContaining({ text: expect.stringContaining("Scope uncertain") }),
			]);
	});
});
