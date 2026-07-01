/**
 * Observe-first prompt-policy planning slice: proves the live AgentSession context
 * transform runs the new shadow/planning layer (context-prompt-policy.ts) after the audit
 * pass and before/around context-gc, without changing provider-visible messages, the
 * transcript, or artifact references, and without changing legacy context-gc's own
 * behavior. The planner's `appliedAction` is always "keep_raw" -- nothing here enforces.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "./harness.ts";

function bigGrepFile(harness: Harness): void {
	const lines: string[] = [];
	for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
	writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));
}

describe("AgentSession live prompt-policy planning (observe-first, no enforcement)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("gives a large artifact-backed grep result an available retrieval path with no missing_retrieval_path", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);
		bigGrepFile(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");

		const plan = harness.session.getPromptPolicyReport();
		expect(plan.items).toHaveLength(1);
		const [item] = plan.items;
		expect(item.hasAvailableRetrievalPath).toBe(true);
		expect(item.hardConstraints.dropFromPrompt).not.toContain("missing_retrieval_path");
		expect(item.appliedAction).toBe("keep_raw");
	});

	it("keeps a small, non-artifact tool result conservative (missing_retrieval_path on drop)", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);
		writeFileSync(join(harness.tempDir, "small.txt"), "one needle here\n");

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "small.txt", limit: 10, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search small file");

		const plan = harness.session.getPromptPolicyReport();
		const [item] = plan.items;
		expect(item.hasAvailableRetrievalPath).toBe(false);
		expect(item.hardConstraints.dropFromPrompt).toContain("missing_retrieval_path");
		expect(item.appliedAction).toBe("keep_raw");
	});

	it("leaves provider-visible messages and the transcript unchanged (observe-only)", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);
		bigGrepFile(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");

		const messagesBefore = JSON.stringify(harness.session.messages);
		const branchBefore = JSON.stringify(harness.sessionManager.getBranch());

		harness.session.getPromptPolicyReport(harness.session.messages);
		harness.session.getPromptPolicyGcCorrelation();

		expect(JSON.stringify(harness.session.messages)).toBe(messagesBefore);
		expect(JSON.stringify(harness.sessionManager.getBranch())).toBe(branchBefore);
	});

	it("does not release/reclaim artifact references when the read-only getters are called repeatedly", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);
		bigGrepFile(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");

		const toolResult = harness.session.messages.find(
			(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
		);
		const artifactId = (toolResult?.details as { artifactId?: string } | undefined)?.artifactId;
		expect(artifactId).toBeDefined();

		harness.session.getPromptPolicyReport(harness.session.messages);
		harness.session.getPromptPolicyReport(harness.session.messages);
		harness.session.getPromptPolicyGcCorrelation();

		// The artifact must still be present with the plan reporting an available retrieval
		// path -- repeated read-only calls must never register/release references or
		// trigger cleanup.
		const plan = harness.session.getPromptPolicyReport();
		expect(plan.items[0]?.hasAvailableRetrievalPath).toBe(true);
	});

	it("runs after the audit pass and before context-gc, and context-gc still packs/evicts as before", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
		});
		harnesses.push(harness);
		bigGrepFile(harness);

		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("grep", { pattern: "needle", path: "big.txt", limit: 3000, context: 0 })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("search for needle occurrences");

		const plainResponses = Array.from({ length: 6 }, (_, i) => fauxAssistantMessage(`ok ${i}`));
		harness.setResponses(plainResponses);
		for (let i = 0; i < plainResponses.length; i++) {
			await harness.session.prompt(`continue ${i}`);
		}

		// Legacy context-gc still evicted/packed the result exactly as it did before this
		// slice existed (same behavior as the pre-existing lifecycle test).
		expect(harness.session.getContextGcReport().packedCount).toBeGreaterThan(0);

		// The correlation from the turn that packed it proves the planner ran (it captured
		// the item) and that legacy gc's actual pack decision is visible in the shadow
		// report's own terms -- ordering (audit/plan before gc) is what makes this
		// correlation possible at all.
		const correlation = harness.session.getPromptPolicyGcCorrelation();
		expect(correlation.entries.some((entry) => entry.actuallyPackedByLegacyGc)).toBe(true);
	});
});
