/**
 * Observe-only Phase 1 audit wiring: proves the live AgentSession context transform builds
 * a deterministic ContextItem/policy audit report from real toolResult messages (via
 * getContextAuditReport), without changing provider-visible messages, the transcript, or
 * artifact references. No dropping/packing/reordering happens because of this pass --
 * context-gc (already wired) remains the only thing that changes prompt content.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import type { ContextAuditReport } from "../../src/core/context/context-audit.ts";
import { createHarness, type Harness } from "./harness.ts";

function bigGrepFile(harness: Harness): void {
	const lines: string[] = [];
	for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
	writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));
}

function toolOutputItems(report: ContextAuditReport) {
	return report.items.filter((entry) => entry.item.kind === "tool_output");
}

describe("AgentSession live context audit (observe-only, Phase 1)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("gives a large artifact-backed grep result an item with resolved artifact evidence and no missing_retrieval_path", async () => {
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

		const report = harness.session.getContextAuditReport();
		const items = toolOutputItems(report);
		expect(items).toHaveLength(1);
		const [entry] = items;
		expect(entry.item.primaryRef?.type).toBe("artifact");
		expect(entry.dropFromPromptHardConstraints).not.toContain("missing_retrieval_path");
		expect(entry.packToArtifactHardConstraints).not.toContain("missing_retrieval_path");
	});

	it("gives a small, non-artifact tool result conservative treatment (missing_retrieval_path on drop)", async () => {
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

		const report = harness.session.getContextAuditReport();
		const items = toolOutputItems(report);
		expect(items).toHaveLength(1);
		const [entry] = items;
		expect(entry.item.primaryRef?.type).not.toBe("artifact");
		expect(entry.dropFromPromptHardConstraints).toContain("missing_retrieval_path");
	});

	it("produces a deterministic report across repeated read-only calls with the same messages", async () => {
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

		const snapshot = harness.session.messages.slice();
		const first = harness.session.getContextAuditReport(snapshot);
		const second = harness.session.getContextAuditReport(snapshot);
		expect(second).toEqual(first);
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

		harness.session.getContextAuditReport(harness.session.messages);

		expect(JSON.stringify(harness.session.messages)).toBe(messagesBefore);
		expect(JSON.stringify(harness.sessionManager.getBranch())).toBe(branchBefore);
	});

	it("does not perform unsafe mutations (artifact reference counts unchanged) when inspecting read-only", async () => {
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

		harness.session.getContextAuditReport(harness.session.messages);
		harness.session.getContextAuditReport(harness.session.messages);

		// Reading the audit report repeatedly must never register/release artifact
		// references -- only pack-time (`packToolOutput`) and gc-eviction-time
		// (`_releaseGcPackedArtifactReferences`) are allowed to touch reference counts.
		const reportAfter = harness.session.getContextAuditReport();
		const artifactItem = toolOutputItems(reportAfter)[0];
		expect(artifactItem.item.primaryRef?.type).toBe("artifact");
	});

	it("still runs context-gc after the audit pass (audit does not block or replace eviction)", async () => {
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

		expect(harness.session.getContextGcReport().packedCount).toBeGreaterThan(0);
	});
});
