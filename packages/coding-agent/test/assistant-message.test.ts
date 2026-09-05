import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, test } from "vitest";
import { AssistantMessageComponent } from "../src/modes/interactive/components/assistant-message.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

const OSC133_ZONE_START = "\x1b]133;A\x07";
const OSC133_ZONE_END = "\x1b]133;B\x07";
const OSC133_ZONE_FINAL = "\x1b]133;C\x07";

function createAssistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "gpt-4o-mini",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("AssistantMessageComponent", () => {
	test("Workbench shows prose commentary while filtering control payloads and invalidates streamed rows", () => {
		initTheme("dark");
		const message = createAssistantMessage([
			{ type: "text", text: "Inspecting the renderer", textSignature: '{"phase":"commentary"}' },
			{ type: "text", text: '{"action":"advance"}', textSignature: '{"phase":"commentary"}' },
		]);
		const component = new AssistantMessageComponent(message, true, undefined, { showCommentary: true });
		const rendered = component.render(80).join("\n");
		expect(rendered).toContain("Inspecting the renderer");
		expect(rendered).not.toContain('"action"');
		const revision = component.renderRevision;
		component.updateContent(createAssistantMessage([{ type: "text", text: "Now complete" }]));
		expect(component.renderRevision).not.toBe(revision);
	});
	test("adds OSC 133 zone markers to assistant messages without tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(createAssistantMessage([{ type: "text", text: "hello" }]));
		const lines = component.render(40);

		expect(lines).not.toHaveLength(0);
		expect(lines[0]).toContain(OSC133_ZONE_START);
		expect(lines[lines.length - 1].startsWith(OSC133_ZONE_END + OSC133_ZONE_FINAL)).toBe(true);
	});

	test("does not add OSC 133 zone markers when assistant message contains tool calls", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "text", text: "calling tool" },
				{ type: "toolCall", id: "tool-1", name: "read", arguments: { path: "file.txt" } },
			]),
		);
		const rendered = component.render(60).join("\n");

		expect(rendered.includes(OSC133_ZONE_START)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_END)).toBe(false);
		expect(rendered.includes(OSC133_ZONE_FINAL)).toBe(false);
	});

	test("does not add hidden thinking to the assistant transcript", () => {
		initTheme("dark");

		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{ type: "thinking", thinking: "first thought" },
				{ type: "thinking", thinking: "" },
				{ type: "thinking", thinking: "second thought" },
				{ type: "text", text: "answer" },
			]),
			true,
		);
		const rendered = component.render(80).join("\n");

		expect(rendered).not.toContain("Thinking...");
		expect(rendered).toContain("answer");
	});

	test("keeps signed commentary and orchestration payloads out of the transcript", () => {
		initTheme("dark");
		const commentarySignature = JSON.stringify({ v: 1, id: "commentary", phase: "commentary" });
		const finalSignature = JSON.stringify({ v: 1, id: "final", phase: "final_answer" });
		const component = new AssistantMessageComponent(
			createAssistantMessage([
				{
					type: "text",
					text: '{"action":"advance","id":"step-3","evidence":["internal"]}',
					textSignature: commentarySignature,
				},
				{ type: "text", text: "Continuing verification", textSignature: commentarySignature },
				{ type: "text", text: "Verified result", textSignature: finalSignature },
			]),
		);
		const rendered = component.render(100).join("\n");

		expect(rendered).toContain("Verified result");
		expect(rendered).not.toContain('"action"');
		expect(rendered).not.toContain("Continuing verification");
	});
});
