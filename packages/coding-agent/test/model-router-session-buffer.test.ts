import type { AgentMessage } from "@caupulican/pi-agent-core";
import type { Message } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import {
	bufferModelRouterSessionCustomMessage,
	bufferModelRouterSessionMessage,
	createModelRouterSessionBuffer,
	flushModelRouterSessionBuffer,
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
		flushModelRouterSessionBuffer(
			buffer,
			(message) => appendedMessages.push(message),
			(customType, content, display, details) => appendedCustom.push({ customType, content, display, details }),
		);

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
});
