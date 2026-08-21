import type { AgentMessage } from "@caupulican/pi-agent-core";
import { fauxAssistantMessage, type Message } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	bufferModelRouterSessionCustomMessage,
	bufferModelRouterSessionMessage,
	createModelRouterSessionBuffer,
	flushModelRouterSessionBuffer,
	flushModelRouterSessionBufferPrefix,
} from "../src/core/model-router/session-buffer.ts";

describe("model router session buffer", () => {
	it("flushes regular and custom messages through their matching session appenders", () => {
		const buffer = createModelRouterSessionBuffer();
		const regular: Message = { role: "user", content: [{ type: "text", text: "hello" }], timestamp: 1 };
		const custom: Extract<AgentMessage, { role: "custom" }> = {
			role: "custom",
			customType: "memory_context",
			content: [{ type: "text", text: "memory" }],
			display: false,
			details: { source: "test" },
			timestamp: 1,
		};
		const appendedMessages: Message[] = [];
		const appendedCustom: unknown[] = [];

		bufferModelRouterSessionMessage(buffer, regular);
		bufferModelRouterSessionCustomMessage(buffer, custom);
		flushModelRouterSessionBuffer(buffer, (entries) => {
			for (const entry of entries) {
				if (entry.kind === "message") appendedMessages.push(entry.message);
				else
					appendedCustom.push({
						customType: entry.message.customType,
						content: entry.message.content,
						display: entry.message.display,
						details: entry.message.details,
					});
			}
			return entries.map((_, index) => `entry-${index}`);
		});

		expect(appendedMessages).toEqual([regular]);
		expect(appendedCustom).toEqual([
			{
				customType: "memory_context",
				content: [{ type: "text", text: "memory" }],
				display: false,
				details: { source: "test" },
			},
		]);
	});

	it("commits the prompt prefix separately from the assistant suffix", () => {
		const buffer = createModelRouterSessionBuffer();
		const user: Message = { role: "user", content: [{ type: "text", text: "prompt" }], timestamp: 1 };
		const assistant = fauxAssistantMessage([{ type: "text", text: "reply" }]);
		const custom: Extract<AgentMessage, { role: "custom" }> = {
			role: "custom",
			customType: "prefix",
			content: "context",
			display: false,
			timestamp: 1,
		};
		const persisted: Message[] = [];
		bufferModelRouterSessionCustomMessage(buffer, custom);
		bufferModelRouterSessionMessage(buffer, user);
		expect(
			flushModelRouterSessionBufferPrefix(buffer, (entries) => {
				for (const entry of entries) if (entry.kind === "message") persisted.push(entry.message);
				return ["custom-entry", "user-entry"];
			}),
		).toEqual(
			new Map<AgentMessage, string>([
				[custom, "custom-entry"],
				[user, "user-entry"],
			]),
		);
		expect(buffer.prefixCommitted).toBe(true);
		expect(buffer.committed).toBe(false);
		expect(buffer.prefixMessageCount).toBe(2);

		bufferModelRouterSessionMessage(buffer, assistant);
		flushModelRouterSessionBuffer(buffer, (entries) => {
			const entry = entries[0]!;
			if (entry.kind !== "message") throw new Error("Expected an assistant message entry.");
			persisted.push(entry.message);
			return ["assistant-entry"];
		});
		expect(persisted).toEqual([user, assistant]);
		expect(buffer.committed).toBe(true);
	});
});
