// @isolated: constructs session harnesses and registers faux providers
// @guards src/core/runtime-builder.ts
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "../src/core/extensions/types.ts";
import { createGoalState } from "../src/core/goals/goal-state.ts";
import { appendGoalStateSnapshot, getLatestGoalStateSnapshot } from "../src/core/goals/session-goal-state.ts";
import { TypeSafeEvidenceStore } from "../src/core/review/typesafe-evidence-store.ts";
import type { SystemOneController } from "../src/core/system-one/controller.ts";
import { createHarness } from "./suite/harness.ts";
import { tempDir } from "./temp-dir.ts";

describe("native completion evidence wiring", () => {
	it.each([false, true])(
		"retains paged originals only when retrieval is available (excluded: %s)",
		async (excluded) => {
			const agentDir = tempDir("pi-completion-evidence-");
			const decision = {
				verdict: "verify_more" as const,
				failed_gates: [
					{
						id: "JEV-proof",
						reason: "Reproduce stale completion",
						required_next_proof: "Run the stale result regression and current result control.",
					},
				],
				warnings: [],
			};
			const controller = {
				setVerificationHost: () => {},
				verification: { status: () => ({ obligations: [] }) },
				setEvaluationObserver: () => {},
				setEvaluationIdleListener: () => {},
				completionView: () => ({ view: { candidate: "current" }, repositoryOutcome: true }),
				executeCompletionTransaction: async () => decision,
			} as unknown as SystemOneController;
			const harness = await createHarness({
				agentDir,
				persistSession: true,
				systemOneController: controller,
				excludedToolNames: excluded ? ["systemone"] : undefined,
			});
			harness.sessionManager.appendMessage(fauxAssistantMessage("Work started."));
			appendGoalStateSnapshot(
				harness.sessionManager,
				createGoalState({ goalId: "goal", userGoal: "Fix stale completion", now: "T0" }),
			);
			const goal = harness.session.getToolDefinition("goal");
			if (!goal) throw new Error("Expected native goal tool");
			const result = await goal.execute(
				"completion",
				{ action: "complete" },
				undefined,
				undefined,
				undefined as unknown as ExtensionContext,
			);
			expect(result).toMatchObject({ isError: true });
			const rejection = getLatestGoalStateSnapshot(harness.sessionManager)?.lastCompletionRejection;
			expect(rejection?.findings).toMatchObject(decision.failed_gates);
			if (excluded) {
				expect(rejection?.evidence).toBeUndefined();
				expect(harness.session.getToolDefinition("systemone")).toBeUndefined();
			} else {
				expect(rejection?.evidence).toMatchObject({
					id: expect.any(String),
					sha256: expect.any(String),
					bytes: expect.any(Number),
				});
				const reference = rejection?.evidence;
				if (!reference) throw new Error("Expected retained native completion evidence");
				const review = harness.session.getToolDefinition("systemone");
				if (!review) throw new Error("Expected native evidence reader");
				const page = await review.execute(
					"read-proof",
					{ action: "evidence", id: reference.id },
					undefined,
					undefined,
					undefined as unknown as ExtensionContext,
				);
				expect(JSON.stringify(page.content)).toContain("required_next_proof");
				const reopened = TypeSafeEvidenceStore.file(agentDir, harness.sessionManager.getSessionId()).read(
					reference.id,
				);
				expect(JSON.parse(reopened.text).record.completionDecision).toEqual(decision);
				expect(reopened.sha256).toBe(reference.sha256);
			}
		},
	);
});
