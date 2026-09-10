import { VerificationObligationTracker } from "@caupulican/pi-agent-core/verification-obligations";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { createHarness } from "../harness.ts";

describe("setup verification compaction", () => {
	it.each(["setup_failed", "executed"] as const)("preserves the repair authority of a %s result", async (outcome) => {
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.registerTool({
						name: "verify",
						label: "Verify",
						description: "Deterministic verification receipt",
						parameters: Type.Object({ repair: Type.Boolean() }),
						async execute(_id, { repair }) {
							return {
								content: [
									{ type: "text", text: repair ? "Tests 1 passed (1)" : "Initial verification failed" },
								],
								isError: !repair,
								details: {
									piVerification: {
										version: 1,
										id: repair ? "corrected" : "initial",
										status: repair ? "passed" : "failed",
										outcome: repair ? "executed" : outcome,
										repairGroup: "workspace-check",
										...(repair ? { repairOf: "initial" } : {}),
									},
								},
							};
						},
					});
					pi.on("session_before_compact", async (event) => {
						const lastAnswer = event.branchEntries.findLast(
							(entry) => entry.type === "message" && entry.message.role === "assistant",
						);
						if (!lastAnswer) throw new Error("Expected an assistant handoff before compaction");
						return {
							compaction: {
								summary: "Verification remains unresolved.",
								firstKeptEntryId: lastAnswer.id,
								tokensBefore: event.preparation.tokensBefore,
								details: { source: "fixture" },
							},
						};
					});
				},
			],
		});
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("verify", { repair: false })], { stopReason: "toolUse" }),
			fauxAssistantMessage("The check needs repair."),
		]);
		await harness.session.prompt("Run the check.", { autoContinueGoal: false });
		const compacted = await harness.session.compact();
		expect(compacted.details).toEqual({
			source: "fixture",
			piVerificationObligations: {
				version: 1,
				activeIds: ["initial"],
				...(outcome === "setup_failed"
					? { setupFailures: [{ id: "initial", repairGroup: "workspace-check" }] }
					: {}),
			},
		});
		expect(harness.session.messages.some((message) => message.role === "toolResult")).toBe(false);
		await harness.session.reload();
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("verify", { repair: true })], { stopReason: "toolUse" }),
			fauxAssistantMessage("The corrected invocation passed."),
		]);
		await harness.session.prompt("Run the corrected check.", { autoContinueGoal: false });
		expect(new VerificationObligationTracker(harness.session.messages).getActiveIds()).toEqual(
			outcome === "setup_failed" ? [] : ["initial"],
		);
		// The executed failure stays active across compaction (asserted above) and blocks goal
		// completion; it was opened in an earlier run, so this run's answer is an ordinary answer.
		expect(harness.session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
	});
});
