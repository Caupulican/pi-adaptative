import { VerificationObligationTracker } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createGoalState } from "../../../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot } from "../../../src/core/goals/session-goal-state.ts";
import { createHarness, getAssistantTexts, getMessageText } from "../harness.ts";

describe("unresolved verification session handoff", () => {
	it("stops goal continuation after one preserved handoff and allows an explicit passing repair", async () => {
		const verificationId = "session-focused-check";
		let verificationPassed = false;
		const harness = await createHarness({
			extensionFactories: [
				(pi) =>
					pi.registerTool({
						name: "verify",
						label: "Verify",
						description: "Run the focused check",
						parameters: Type.Object({}),
						async execute() {
							return {
								content: [{ type: "text", text: verificationPassed ? "passed" : "failed" }],
								details: {
									piVerification: {
										version: 1,
										id: verificationId,
										status: verificationPassed ? "passed" : "failed",
									},
								},
								isError: !verificationPassed,
							};
						},
					}),
			],
		});
		appendGoalStateSnapshot(
			harness.sessionManager,
			createGoalState({
				goalId: "handoff-goal",
				userGoal: "Repair and verify the regression",
				now: new Date().toISOString(),
			}),
		);
		const handoff = "The focused check still fails. The partial repair is retained for the next turn.";
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("verify", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" }, { id: "premature-completion" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(handoff),
			fauxAssistantMessage("Unexpected automatic retry"),
		]);

		const result = await harness.session.continueGoalLoop({ maxTurns: 3, maxStallTurns: 3 });
		expect(result.turnsSubmitted, JSON.stringify(result)).toBe(1);
		expect(harness.faux.state.callCount).toBe(3);
		expect(harness.getPendingResponseCount()).toBe(1);
		expect(getAssistantTexts(harness)).toContain(handoff);
		expect(harness.session.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "verification_handoff_required",
		});
		expect(new VerificationObligationTracker(harness.session.messages).getActiveIds()).toEqual([verificationId]);
		expect(result.finalSnapshot.goalState?.status).not.toBe("completed");
		const rejectedCompletion = harness.session.messages.find(
			(message) => message.role === "toolResult" && message.toolCallId === "premature-completion",
		);
		expect(rejectedCompletion).toMatchObject({ isError: true });
		expect(getMessageText(rejectedCompletion)).toContain("active verification obligation(s) remain");

		verificationPassed = true;
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("verify", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" }, { id: "verified-completion" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("The focused check now passes."),
		]);
		await harness.session.prompt("The repair is ready; rerun the same check.");
		expect(new VerificationObligationTracker(harness.session.messages).getActiveIds()).toEqual([]);
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		expect(
			harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "verified-completion",
			),
		).toMatchObject({ isError: false });
	});
});
