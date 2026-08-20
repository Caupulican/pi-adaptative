import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import type { AgentSessionEvent } from "../src/core/agent-session-contracts.ts";
import { projectSessionEventForJson } from "../src/modes/json-event-projection.ts";

function assistant(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "xai",
		model: "grok-4.6",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

describe("JSON session-event projection", () => {
	it("does not repeat accumulated assistant content on every streaming delta", () => {
		const partial = assistant("x".repeat(100_000));
		const event: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "next", partial },
		};

		const projected = projectSessionEventForJson(event) as {
			message: AssistantMessage;
			assistantMessageEvent: Record<string, unknown>;
		};

		expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThan(50 * 1024);
		expect(projected.message).toMatchObject({ provider: "xai", model: "grok-4.6", content: [] });
		expect(projected.assistantMessageEvent).toEqual({ type: "text_delta", contentIndex: 0, delta: "next" });
	});

	it("omits accumulated end-event content while preserving block identity", () => {
		const partial = assistant("x".repeat(100_000));
		const event: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "x".repeat(100_000), partial },
		};

		expect(projectSessionEventForJson(event)).toMatchObject({
			type: "message_update",
			message: { content: [] },
			assistantMessageEvent: { type: "text_end", contentIndex: 0 },
		});
	});

	it("bounds one adversarial escaped delta below the 50 KiB wire ceiling", () => {
		const partial = assistant("partial");
		const event: AgentSessionEvent = {
			type: "message_update",
			message: partial,
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: "\u0000".repeat(100_000), partial },
		};

		const projected = projectSessionEventForJson(event) as {
			assistantMessageEvent: { delta: string; deltaBytes: number; deltaTruncated: boolean };
		};
		expect(Buffer.byteLength(JSON.stringify(projected), "utf8")).toBeLessThan(50 * 1024);
		expect(projected.assistantMessageEvent).toMatchObject({ deltaBytes: 100_000, deltaTruncated: true });
		expect(projected.assistantMessageEvent.delta.length).toBeLessThan(100_000);
	});

	it("leaves terminal and non-streaming events authoritative", () => {
		const message = assistant("complete");
		const event: AgentSessionEvent = { type: "message_end", message };
		expect(projectSessionEventForJson(event)).toBe(event);
	});
});
