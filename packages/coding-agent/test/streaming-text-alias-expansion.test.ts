/**
 * Alias expansion in the streamed assistant TEXT path (prose + thinking) must run on every
 * update, computed fresh from the raw accumulated message, and must never write the expanded
 * copy back into the message. `message_start`/`message_update` events carry a shallow copy of the
 * message whose `.content` array is SHARED by reference with the live history object, and
 * `message_end` hands over that exact live object — so `applyStreamingMessageUpdate` must never
 * mutate or reassign `this.streamingMessage`; only a freshly-computed display copy may be handed
 * to rendering. See path-alias-table.ts's rewriteAgentMessagesWith and this file's sibling,
 * streaming-tool-args-expansion.test.ts, which pins the (separate, already-fixed) tool-argument
 * expansion path this one must not regress.
 */

import type { AssistantMessage } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { expandMessageForDisplay } from "../src/core/context/path-alias-display.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";

const TABLE = {
	cwd: "/repo",
	entries: [{ id: "p/module02.ts", path: "src/core/module02.ts" }],
	reservedIds: [] as string[],
};

function textMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function thinkingMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "thinking", thinking: text }],
		timestamp: 1,
	} as unknown as AssistantMessage;
}

function visibleText(message: AssistantMessage): string {
	const parts = message.content as unknown as Array<{ type: string; text?: string; thinking?: string }>;
	return parts
		.filter((part) => part.type === "text" || part.type === "thinking")
		.map((part) => (part.type === "text" ? part.text : part.thinking))
		.join("\n");
}

function createHost() {
	const rendered: AssistantMessage[] = [];
	const toolActionCalls: Array<{ message: AssistantMessage; argumentsComplete: boolean }> = [];
	const host = {
		session: { peekPathAliasTable: () => TABLE },
		streamingMessage: undefined as AssistantMessage | undefined,
		streamingComponent: {
			updateContent: (message: AssistantMessage) => rendered.push(message),
		},
		lastStreamingUiUpdateAt: 0,
		ui: { requestRender: () => {} },
		updateRuntimeStatus: () => {},
		clearPendingStreamingUiUpdate: () => {},
		// A recording stub, not the real (private) implementation: this suite only pins that
		// applyStreamingMessageUpdate hands the SAME expanded copy to both consumers. The real
		// method's own argumentsComplete gating is already pinned by streaming-tool-args-expansion.test.ts.
		attachStreamingToolActions: (message: AssistantMessage, argumentsComplete: boolean) => {
			toolActionCalls.push({ message, argumentsComplete });
		},
	};
	return { host, rendered, toolActionCalls };
}

function apply(host: unknown, message: AssistantMessage, options: { force?: boolean } = {}): void {
	(
		InteractiveMode.prototype as unknown as {
			applyStreamingMessageUpdate(this: unknown, message: AssistantMessage, options?: { force?: boolean }): void;
		}
	).applyStreamingMessageUpdate.call(host, message, options);
}

describe("streaming assistant text alias expansion", () => {
	it("renders a split alias literally, then self-heals once the token completes, without writing back to the raw message", () => {
		const { host, rendered } = createHost();

		const chunk1 = textMessage("Reading p/mod");
		apply(host, chunk1, { force: true });
		expect((rendered.at(-1)?.content[0] as { text: string }).text).toBe("Reading p/mod");

		const chunk2 = textMessage("Reading p/module02.ts now");
		apply(host, chunk2, { force: true });
		expect((rendered.at(-1)?.content[0] as { text: string }).text).toBe("Reading src/core/module02.ts now");

		// No-writeback pin: `this.streamingMessage` is the exact object message_end would also hand
		// to session history, and it still carries the literal, unexpanded alias.
		expect(host.streamingMessage).toBe(chunk2);
		expect((chunk2.content[0] as { text: string }).text).toBe("Reading p/module02.ts now");
	});

	it("expands a thinking block in the render while the raw message keeps the alias", () => {
		const { host, rendered } = createHost();
		const message = thinkingMessage("checking p/module02.ts");

		apply(host, message, { force: true });

		expect((rendered.at(-1)?.content[0] as { thinking: string }).thinking).toBe("checking src/core/module02.ts");
		expect((message.content[0] as { thinking: string }).thinking).toBe("checking p/module02.ts");
	});

	it("hands attachStreamingToolActions the same expanded copy updateContent received", () => {
		const { host, rendered, toolActionCalls } = createHost();

		apply(host, textMessage("Reading p/module02.ts"), { force: true });

		expect(toolActionCalls).toHaveLength(1);
		expect(toolActionCalls[0]?.message).toBe(rendered.at(-1));
		expect(toolActionCalls[0]?.argumentsComplete).toBe(true);
	});

	it("renders identical visible text live and via history rebuild for the same final message", () => {
		const finalMessage: AssistantMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "check p/module02.ts" },
				{ type: "text", text: "Found it in p/module02.ts." },
				{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "p/module02.ts" } },
			],
			timestamp: 1,
		} as unknown as AssistantMessage;

		const { host, rendered } = createHost();
		apply(host, finalMessage, { force: true });
		const live = visibleText(rendered.at(-1) as AssistantMessage);

		// addMessageToChat's path: full expandMessageForDisplay on the raw, complete message.
		const historyRebuild = visibleText(expandMessageForDisplay(TABLE, finalMessage));

		expect(live).toBe(historyRebuild);
		expect(live).toBe("check src/core/module02.ts\nFound it in src/core/module02.ts.");
	});
});
