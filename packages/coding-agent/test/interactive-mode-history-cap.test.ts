import type { AgentMessage } from "@caupulican/pi-agent-core";
import { describe, expect, test } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

function makeUserMessage(text: string): AgentMessage {
	return {
		role: "user",
		content: [{ type: "text", text }],
	} as AgentMessage;
}

function getText(message: AgentMessage): string {
	const content = (message as { content?: string | Array<{ text?: string }> }).content;
	if (typeof content === "string") return content;
	return content?.map((part) => part.text ?? "").join("") ?? "";
}

function callHistorySelector(messages: AgentMessage[]): {
	messages: AgentMessage[];
	omittedMessages: number;
	estimatedLines: number;
} {
	const ctx = Object.create((InteractiveMode as any).prototype);
	return (InteractiveMode as any).prototype.messagesForTuiHistoryReload.call(ctx, messages);
}

describe("InteractiveMode TUI reload history cap", () => {
	test("keeps only the tail of long reload history", () => {
		const messages = Array.from({ length: 140 }, (_, index) =>
			makeUserMessage(Array.from({ length: 10 }, (__, line) => `message-${index}-line-${line}`).join("\n")),
		);

		const selected = callHistorySelector(messages);

		expect(selected.omittedMessages).toBeGreaterThan(0);
		expect(selected.estimatedLines).toBeLessThanOrEqual(1000);
		expect(getText(selected.messages[0])).not.toContain("message-0-line-0");
		expect(getText(selected.messages.at(-1)!)).toContain("message-139-line-9");
	});

	test("trims a single huge latest message below the reload cap", () => {
		const message = makeUserMessage(Array.from({ length: 1500 }, (_, line) => `huge-line-${line}`).join("\n"));

		const selected = callHistorySelector([message]);
		const renderedText = getText(selected.messages[0]);

		expect(selected.estimatedLines).toBeLessThanOrEqual(1000);
		expect(renderedText).toContain("omitted from TUI reload history");
		expect(renderedText).not.toContain("huge-line-0");
		expect(renderedText).toContain("huge-line-1499");
	});
});
