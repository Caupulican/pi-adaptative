/**
 * Bounded prompt surfacing for retrieved local memory (follow-up to the observe-only
 * retrieval slice): opt-in via a SEPARATE `includeInPrompt` setting, default disabled, and
 * only ever takes effect when `enabled` (retrieval itself) is also true. Proves the
 * injected block is (a) additive-only (never mutates existing messages), (b) wrapped in
 * the existing untrusted-content boundary with a correct source label, (c) bounded by
 * memory-prompt-block.ts's character caps, and (d) never written to the transcript.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { Context } from "@caupulican/pi-ai";
import { fauxAssistantMessage } from "@caupulican/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { MEMORY_PROMPT_BLOCK_MAX_CHARS_PER_ITEM } from "../../src/core/context/memory-prompt-block.ts";
import { formatOkfMemoryDocument } from "../../src/core/context/okf-memory.ts";
import { createHarness, type Harness } from "./harness.ts";

function okfDocument(title: string, description: string, body: string): string {
	return formatOkfMemoryDocument({
		type: "Design Decision",
		title,
		description,
		scope: "project",
		body,
		evidenceRefs: ["transcript:accepted-review"],
		timestamp: "2026-06-30T00:00:00Z",
	});
}

function memoryDir(harness: Harness): string {
	return join(harness.tempDir, "okf-memory");
}

function writeOkfFile(harness: Harness, filename: string, content: string): void {
	mkdirSync(memoryDir(harness), { recursive: true });
	writeFileSync(join(memoryDir(harness), filename), content, "utf8");
}

function normalizeContext(context: Context, tempDir: string): unknown {
	return {
		systemPrompt: context.systemPrompt?.split(tempDir).join("<tempdir>"),
		toolNames: context.tools?.map((tool) => (tool as unknown as { name: string }).name).sort(),
		messages: context.messages.map((message) => {
			const { timestamp: _timestamp, ...rest } = message as unknown as Record<string, unknown>;
			return rest;
		}),
	};
}

function contextUserTexts(context: Context): string[] {
	return context.messages
		.filter((message): message is Extract<Context["messages"][number], { role: "user" }> => message.role === "user")
		.map((message) =>
			typeof message.content === "string"
				? message.content
				: message.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("\n"),
		);
}

function hasMemoryEvidenceBlock(context: Context): boolean {
	return contextUserTexts(context).some((text) => text.includes('source="memory:pi-okf"'));
}

describe("AgentSession live memory prompt inclusion (opt-in, default disabled)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) {
			harnesses.pop()?.cleanup();
		}
	});

	it("R1: default (includeInPrompt unset) is identical to the a9a65996 baseline, even with real retrieval results", async () => {
		const baselineHarness = await createHarness({});
		const retrievalHarness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5 } } },
		});
		harnesses.push(baselineHarness, retrievalHarness);

		const doc = okfDocument("Widget rollout", "Notes on widget rollout.", "Body text about widgets.");
		writeOkfFile(baselineHarness, "note.okf.md", doc);
		writeOkfFile(retrievalHarness, "note.okf.md", doc);

		let baselineCaptured: Context | undefined;
		baselineHarness.setResponses([
			(context) => {
				baselineCaptured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await baselineHarness.session.prompt("tell me about widgets");

		let retrievalCaptured: Context | undefined;
		retrievalHarness.setResponses([
			(context) => {
				retrievalCaptured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await retrievalHarness.session.prompt("tell me about widgets");

		expect(normalizeContext(retrievalCaptured as Context, retrievalHarness.tempDir)).toEqual(
			normalizeContext(baselineCaptured as Context, baselineHarness.tempDir),
		);
		expect(hasMemoryEvidenceBlock(retrievalCaptured as Context)).toBe(false);
		// Non-vacuous: retrieval really found something even though nothing was injected.
		expect(retrievalHarness.session.getMemoryRetrievalReport().contextItems.length).toBeGreaterThan(0);
	});

	it("R2: retrieval enabled + includeInPrompt explicitly false -> still no prompt change", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5, includeInPrompt: false } } },
		});
		harnesses.push(harness);
		writeOkfFile(
			harness,
			"note.okf.md",
			okfDocument("Widget rollout", "Notes on widget rollout.", "Body text about widgets."),
		);

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("tell me about widgets");

		expect(hasMemoryEvidenceBlock(captured as Context)).toBe(false);
		expect(harness.session.getMemoryRetrievalReport().contextItems.length).toBeGreaterThan(0);
	});

	it("R3: includeInPrompt true + retrieval disabled -> no provider constructed/queried and no block appended", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: false, includeInPrompt: true } } },
		});
		harnesses.push(harness);
		writeOkfFile(harness, "note.okf.md", okfDocument("Widget rollout", "Notes on widget rollout.", "Body."));

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("tell me about widgets");

		const report = harness.session.getMemoryRetrievalReport();
		expect(report.providerReports).toEqual([]); // provider never invoked
		expect(hasMemoryEvidenceBlock(captured as Context)).toBe(false);
	});

	it("R4: enabled + includeInPrompt true + non-empty results -> exactly one appended, wrapped, labeled message, last in the array, existing messages unchanged", async () => {
		const noInjectHarness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: false } } },
		});
		const injectHarness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5, includeInPrompt: true } } },
		});
		harnesses.push(noInjectHarness, injectHarness);

		const doc = okfDocument("Widget rollout plan", "Design decision about the widget rollout plan.", "Body.");
		writeOkfFile(noInjectHarness, "note.okf.md", doc);
		writeOkfFile(injectHarness, "note.okf.md", doc);

		let noInjectCaptured: Context | undefined;
		noInjectHarness.setResponses([
			(context) => {
				noInjectCaptured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await noInjectHarness.session.prompt("what was the widget rollout plan?");

		let injectCaptured: Context | undefined;
		injectHarness.setResponses([
			(context) => {
				injectCaptured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await injectHarness.session.prompt("what was the widget rollout plan?");

		const before = noInjectCaptured as Context;
		const after = injectCaptured as Context;

		expect(after.messages.length).toBe(before.messages.length + 1);
		// Every message except the appended one is byte-identical (modulo timestamps) to
		// the no-inject baseline -- proving this is a pure append, never a mutation.
		const beforeNormalized = normalizeContext(before, noInjectHarness.tempDir);
		const afterPrefixNormalized = normalizeContext(
			{ ...after, messages: after.messages.slice(0, -1) },
			injectHarness.tempDir,
		);
		expect(afterPrefixNormalized).toEqual(beforeNormalized);

		const lastMessage = after.messages.at(-1);
		expect(lastMessage?.role).toBe("user");
		const lastText = contextUserTexts(after).at(-1) ?? "";
		expect(lastText).toContain("<untrusted_content");
		expect(lastText).toContain('source="memory:pi-okf"');
		expect(lastText).toContain("pi-okf/project/design_decision");
		expect(lastText).toContain("Local memory evidence");
	});

	it("R5: an oversized OKF description is truncated in the actual injected block", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5, includeInPrompt: true } } },
		});
		harnesses.push(harness);
		const hugeDescription = `Widget rollout plan details: ${"x".repeat(MEMORY_PROMPT_BLOCK_MAX_CHARS_PER_ITEM * 3)}`;
		writeOkfFile(harness, "note.okf.md", okfDocument("Widget rollout plan", hugeDescription, "Body."));

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("what was the widget rollout plan?");

		const lastText = contextUserTexts(captured as Context).at(-1) ?? "";
		expect(lastText).toContain("…");
		expect(lastText.length).toBeLessThan(hugeDescription.length);
	});

	it("R6: maxResults caps the number of items surfaced in the injected block", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 1, includeInPrompt: true } } },
		});
		harnesses.push(harness);
		writeOkfFile(
			harness,
			"a.okf.md",
			okfDocument("Widget rollout A", "Design decision about widget rollout A.", "A"),
		);
		writeOkfFile(
			harness,
			"b.okf.md",
			okfDocument("Widget rollout B", "Design decision about widget rollout B.", "B"),
		);
		writeOkfFile(
			harness,
			"c.okf.md",
			okfDocument("Widget rollout C", "Design decision about widget rollout C.", "C"),
		);

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("what was the widget rollout plan?");

		expect(harness.session.getMemoryRetrievalReport().contextItems).toHaveLength(1);
		const lastText = contextUserTexts(captured as Context).at(-1) ?? "";
		expect(lastText).toContain("1. [pi-okf");
		expect(lastText).not.toContain("2. [pi-okf");
	});

	it("R9: a malformed OKF file with includeInPrompt true does not throw/block, and still surfaces a valid sibling", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5, includeInPrompt: true } } },
		});
		harnesses.push(harness);
		writeOkfFile(harness, "broken.okf.md", "---\ntype: [bad\n---\nbroken body");
		writeOkfFile(
			harness,
			"widget-rollout.okf.md",
			okfDocument("Widget rollout plan", "Design decision about the widget rollout plan.", "Body."),
		);

		let captured: Context | undefined;
		harness.setResponses([
			(context) => {
				captured = context;
				return fauxAssistantMessage("ok");
			},
		]);
		await harness.session.prompt("what was the widget rollout plan?"); // must not throw

		expect(hasMemoryEvidenceBlock(captured as Context)).toBe(true);
	});

	it("R9: with no latest user message, includeInPrompt true fails closed to no block (no throw)", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5, includeInPrompt: true } } },
		});
		harnesses.push(harness);
		writeOkfFile(harness, "note.okf.md", okfDocument("Widget rollout", "Notes on widget rollout.", "Body."));

		const toolResultOnly: AgentMessage[] = [
			{
				role: "toolResult",
				toolCallId: "tc-1",
				toolName: "bash",
				content: [{ type: "text", text: "some tool output, no user message anywhere" }],
				isError: false,
				timestamp: 0,
			},
		];

		const result = await harness.session.agent.transformContext?.(toolResultOnly);

		expect(result).toBeDefined();
		const messages = result ?? [];
		expect(messages.some((message) => message.role === "custom")).toBe(false);
	});

	it("R10: transcript/session.messages never contain a memory_evidence message after a turn with injection active", async () => {
		const harness = await createHarness({
			settings: { contextPolicy: { memory: { enabled: true, maxResults: 5, includeInPrompt: true } } },
		});
		harnesses.push(harness);
		writeOkfFile(
			harness,
			"widget-rollout.okf.md",
			okfDocument("Widget rollout plan", "Design decision about the widget rollout plan.", "Body."),
		);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("what was the widget rollout plan?");

		const hasMemoryEvidenceInMessages = (messages: readonly AgentMessage[]): boolean =>
			messages.some(
				(message) =>
					message.role === "custom" && (message as { customType?: string }).customType === "memory_evidence",
			);

		expect(hasMemoryEvidenceInMessages(harness.session.messages)).toBe(false);
		const branchMessages = harness.sessionManager
			.getBranch()
			.filter((entry): entry is Extract<typeof entry, { type: "message" }> => entry.type === "message")
			.map((entry) => entry.message);
		expect(hasMemoryEvidenceInMessages(branchMessages)).toBe(false);
	});

	it("no directory access when disabled (existing R2 behavior unaffected by this slice)", async () => {
		const harness = await createHarness({});
		harnesses.push(harness);
		expect(existsSync(memoryDir(harness))).toBe(false);

		harness.setResponses([fauxAssistantMessage("ok")]);
		await harness.session.prompt("hello");

		expect(existsSync(memoryDir(harness))).toBe(false);
	});
});
