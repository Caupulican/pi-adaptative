import type { SessionEntry } from "@caupulican/pi-agent-core/node";
import { describe, expect, it } from "vitest";
import { countConversationEntries } from "../src/modes/interactive/conversation-entries.ts";

function message(role: "user" | "assistant" | "toolResult", extra: Record<string, unknown> = {}): SessionEntry {
	return {
		type: "message",
		id: role,
		parentId: null,
		timestamp: "",
		message: { role, content: [], ...extra },
	} as never;
}

describe("countConversationEntries", () => {
	it("counts only the turns a hidden-history placeholder can stand for", () => {
		const entries: SessionEntry[] = [
			{ type: "custom", customType: "reflection_turn_trigger", id: "c1", parentId: null, timestamp: "" } as never,
			{ type: "model_change", id: "m1", parentId: null, timestamp: "" } as never,
			message("user"),
			message("assistant"),
			message("toolResult", { toolName: "ask_question" }),
			message("toolResult", { toolName: "bash" }),
		];
		expect(countConversationEntries(entries)).toBe(3);
	});

	it("is zero for a fresh session that holds only control records", () => {
		const entries: SessionEntry[] = [
			{ type: "custom", customType: "goal_context", id: "c1", parentId: null, timestamp: "" } as never,
			{ type: "model_change", id: "m1", parentId: null, timestamp: "" } as never,
		];
		expect(countConversationEntries(entries)).toBe(0);
	});
});
