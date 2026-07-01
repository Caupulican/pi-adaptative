/**
 * First enforcement pilot slice: proves the live AgentSession context transform can stub
 * stale artifact-backed grep/find results in the provider-visible message array, opt-in and
 * default-disabled, without ever touching the transcript/session history or artifact
 * references, and without changing default (disabled) behavior or legacy context-gc's own
 * behavior.
 */

import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { Context } from "@caupulican/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { createFileArtifactStore } from "../../src/core/context/context-artifacts.ts";
import { createHarness, type Harness } from "./harness.ts";

function bigGrepFile(harness: Harness): void {
	const lines: string[] = [];
	for (let i = 0; i < 3000; i++) lines.push(`needle occurrence number ${i} padded with extra text to add bytes`);
	writeFileSync(join(harness.tempDir, "big.txt"), lines.join("\n"));
}

function toolResultContextText(context: Context, toolCallId: string): string | undefined {
	const message = context.messages.find(
		(m): m is Extract<Context["messages"][number], { role: "toolResult" }> =>
			m.role === "toolResult" && m.toolCallId === toolCallId,
	);
	if (!message) return undefined;
	const part = message.content.find((c): c is { type: "text"; text: string } => c.type === "text");
	return part?.text;
}

function firstToolResultToolCallId(harness: Harness): string | undefined {
	const toolResult = harness.session.messages.find(
		(message): message is Extract<AgentMessage, { role: "toolResult" }> => message.role === "toolResult",
	);
	return toolResult?.toolCallId;
}

function sessionArtifactDir(harness: Harness): string {
	return join(harness.tempDir, "context-artifacts", harness.sessionManager.getSessionId());
}

describe("AgentSession live prompt-policy enforcement (opt-in, default disabled)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("does nothing under default settings: no enforcement actions, provider-visible content unaffected by this pass", async () => {
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

		const toolCallId = firstToolResultToolCallId(harness);
		expect(toolCallId).toBeDefined();

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("continue");

		expect(harness.session.getPromptEnforcementReport().items).toEqual([]);
		const text = toolResultContextText(captured as Context, toolCallId as string);
		expect(text).toBeDefined();
		expect(text).not.toContain("content replaced by prompt-policy");
	});

	it("stubs a stale artifact-backed result in provider-visible messages when enabled, leaving the transcript byte-identical", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
			settings: {
				// Keep legacy context-gc's own window wide so it does not act on this message in
				// this test -- isolates enforcement's own, independently configured window.
				contextGc: { preserveRecentMessages: 100 },
				contextPolicy: { enforcement: { enabled: true, preserveRecentMessages: 2, minChars: 10 } },
			},
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

		const toolCallId = firstToolResultToolCallId(harness);
		expect(toolCallId).toBeDefined();

		const messagesBefore = harness.session.messages.slice();
		const messagesBeforeJson = JSON.stringify(messagesBefore);

		harness.setResponses([fauxAssistantMessage("ok 1"), fauxAssistantMessage("ok 2")]);
		await harness.session.prompt("continue 1");

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok 3");
			},
		]);
		await harness.session.prompt("continue 2");

		const text = toolResultContextText(captured as Context, toolCallId as string);
		expect(text).toContain("content replaced by prompt-policy");
		expect(text).toContain("artifact_retrieve");

		const report = harness.session.getPromptEnforcementReport();
		expect(report.items.some((item) => item.enforced && item.toolCallId === toolCallId)).toBe(true);

		// The transcript/session history is never touched by enforcement: the prefix of
		// session.messages captured before enforcement ever ran must remain byte-identical,
		// even though the provider-visible content for that same tool result was stubbed.
		expect(JSON.stringify(harness.session.messages.slice(0, messagesBefore.length))).toBe(messagesBeforeJson);
	});

	it("still records legacy context-gc packs and the prompt-policy correlation exactly as before, with enforcement wired in", async () => {
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
		const correlation = harness.session.getPromptPolicyGcCorrelation();
		expect(correlation.entries.some((entry) => entry.actuallyPackedByLegacyGc)).toBe(true);
	});

	it("does not stub when artifact_retrieve is not active this turn (active tools changed after packing)", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
			settings: {
				contextGc: { preserveRecentMessages: 100 },
				contextPolicy: { enforcement: { enabled: true, preserveRecentMessages: 2, minChars: 10 } },
			},
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

		const toolCallId = firstToolResultToolCallId(harness);
		expect(toolCallId).toBeDefined();
		// Sanity: companion activation put artifact_retrieve into the active set alongside grep.
		expect(harness.session.getActiveToolNames()).toContain("artifact_retrieve");

		// Simulate active tools changing later in the session (e.g. a profile/allowlist
		// change) so grep and its artifact_retrieve companion are no longer active.
		harness.session.setActiveToolsByName(["read", "bash", "edit", "write", "context_audit", "goal"]);
		expect(harness.session.getActiveToolNames()).not.toContain("artifact_retrieve");

		harness.setResponses([fauxAssistantMessage("ok 1"), fauxAssistantMessage("ok 2")]);
		await harness.session.prompt("continue 1");

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok 3");
			},
		]);
		await harness.session.prompt("continue 2");

		const text = toolResultContextText(captured as Context, toolCallId as string);
		expect(text).not.toContain("content replaced by prompt-policy");

		const report = harness.session.getPromptEnforcementReport();
		const entry = report.items.find((item) => item.toolCallId === toolCallId);
		expect(entry?.skipReason).toBe("retrieval_tool_unavailable");
	});

	it("skips a real legacy-context-gc-packed result (not just a synthetic details marker) instead of double-stubbing it", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
			settings: {
				// Default context-gc window (8) left untouched so gc packs the stale result
				// itself, first -- exactly the same 6-plain-turn scenario the lifecycle/gc
				// tests use. Enforcement is enabled with its own small window so it WOULD
				// otherwise consider this item eligible too, if gc had not already acted.
				contextPolicy: { enforcement: { enabled: true, preserveRecentMessages: 2, minChars: 10 } },
			},
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

		const toolCallId = firstToolResultToolCallId(harness);
		expect(toolCallId).toBeDefined();

		const plainResponses = Array.from({ length: 5 }, (_, i) => fauxAssistantMessage(`ok ${i}`));
		harness.setResponses(plainResponses);
		for (let i = 0; i < plainResponses.length; i++) {
			await harness.session.prompt(`continue ${i}`);
		}

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("final");
			},
		]);
		await harness.session.prompt("continue final");

		// Legacy context-gc actually packed it this turn (confirmed the same way the
		// existing gc/lifecycle tests do).
		expect(harness.session.getContextGcReport().packedCount).toBeGreaterThan(0);

		const text = toolResultContextText(captured as Context, toolCallId as string);
		expect(text).toContain("[Context GC packed stale tool result]");
		expect(text).not.toContain("content replaced by prompt-policy");

		const report = harness.session.getPromptEnforcementReport();
		const entry = report.items.find((item) => item.toolCallId === toolCallId);
		expect(entry?.skipReason).toBe("already_stubbed_or_packed");
	});

	it("does not release/reclaim artifact references from the read-only enforcement getter", async () => {
		const harness = await createHarness({
			initialActiveToolNames: ["read", "bash", "edit", "write", "context_audit", "goal", "grep"],
			settings: {
				contextGc: { preserveRecentMessages: 100 },
				contextPolicy: { enforcement: { enabled: true, preserveRecentMessages: 2, minChars: 10 } },
			},
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

		harness.setResponses([fauxAssistantMessage("ok 1"), fauxAssistantMessage("ok 2")]);
		await harness.session.prompt("continue 1");
		await harness.session.prompt("continue 2");

		harness.session.getPromptEnforcementReport();
		harness.session.getPromptEnforcementReport();

		const artifactDir = sessionArtifactDir(harness);
		expect(existsSync(artifactDir)).toBe(true);
		const store = createFileArtifactStore({ baseDir: artifactDir });
		expect(store.has(artifactId as string)).toBe(true);
	});
});
