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

	it("answers a later question normally while the obligation stays active, and completes after the operator dismisses it", async () => {
		const verificationId = "session-inherited-check";
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
								content: [{ type: "text", text: "failed" }],
								details: { piVerification: { version: 1, id: verificationId, status: "failed" } },
								isError: true,
							};
						},
					}),
			],
		});
		appendGoalStateSnapshot(
			harness.sessionManager,
			createGoalState({ goalId: "inherited-goal", userGoal: "Repair and verify", now: new Date().toISOString() }),
		);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("verify", {})], { stopReason: "toolUse" }),
			fauxAssistantMessage("The check fails on this machine; the fixture is missing."),
		]);
		await harness.session.prompt("Run the focused check.");
		expect(harness.session.messages.at(-1)).toMatchObject({
			stopReason: "error",
			errorMessage: "verification_handoff_required",
		});
		expect(harness.session.getVerificationObligations().map((o) => o.id)).toEqual([verificationId]);

		// A later root turn that does not touch verification is an ordinary answer.
		harness.setResponses([fauxAssistantMessage("Here is the summary you asked for.")]);
		await harness.session.prompt("Summarize what you found.");
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
		expect(getAssistantTexts(harness)).toContain("Here is the summary you asked for.");
		expect(harness.session.getVerificationObligations().map((o) => o.id)).toEqual([verificationId]);

		// Completion still waits on the obligation until the operator resolves it.
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" }, { id: "blocked-completion" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Could not complete."),
		]);
		await harness.session.prompt("Mark it complete.");
		expect(
			harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "blocked-completion",
			),
		).toMatchObject({ isError: true });

		const dismissed = await harness.session.dismissVerificationObligations([verificationId], "fixture absent here");
		expect(dismissed).toEqual([verificationId]);
		expect(harness.session.getVerificationObligations()).toEqual([]);
		expect(
			harness.session.messages.find(
				(message) => message.role === "custom" && message.customType === "pi_verification_dismissal",
			),
		).toMatchObject({ display: true });
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("update_goal", { status: "complete" }, { id: "dismissed-completion" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("Completed."),
		]);
		await harness.session.prompt("Mark it complete now.");
		expect(
			harness.session.messages.find(
				(message) => message.role === "toolResult" && message.toolCallId === "dismissed-completion",
			),
		).toMatchObject({ isError: false });
	});
});
