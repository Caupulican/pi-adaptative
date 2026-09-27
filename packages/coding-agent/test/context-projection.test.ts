import type { AgentMessage } from "@caupulican/pi-agent-core";
import { describe, expect, it } from "vitest";
import { buildContextProjection, CONTEXT_PROJECTION_SCHEMA_VERSION } from "../src/core/context/context-projection.ts";

function userMessage(content: string, timestamp = 100): AgentMessage {
	return { role: "user", content, timestamp };
}

function assistantMessage(content: string, timestamp = 200): AgentMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: content }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

function toolResultMessage(content: string, timestamp = 300): AgentMessage {
	return {
		role: "toolResult",
		toolCallId: "call-1",
		toolName: "read",
		content: [{ type: "text", text: content }],
		isError: false,
		timestamp,
	};
}

describe("context projection", () => {
	it("keeps immutable entry identities and content revisions separate from capture freshness", () => {
		const messages = [userMessage("inspect"), assistantMessage("working"), toolResultMessage("result")];
		const options = {
			turnIndex: 3,
			sessionEntryIdForToolCallId: (toolCallId: string) => (toolCallId === "call-1" ? "session-entry-1" : undefined),
		};
		const first = buildContextProjection(messages, options);
		const second = buildContextProjection(messages, { ...options, turnIndex: 4 });

		expect(first.schemaVersion).toBe(CONTEXT_PROJECTION_SCHEMA_VERSION);
		expect(first.revision).toBe(second.revision);
		expect(first.entries.map((entry) => entry.id)).toEqual(second.entries.map((entry) => entry.id));
		expect(first.entries.map((entry) => entry.revision)).toEqual(second.entries.map((entry) => entry.revision));
		expect(first.entries.map((entry) => entry.freshness.observedAtTurn)).toEqual([3, 3, 3]);
		expect(second.entries.map((entry) => entry.freshness.observedAtTurn)).toEqual([4, 4, 4]);
		expect(first.entries.map((entry) => [entry.role, entry.kind, entry.source])).toEqual([
			["user", "conversation_tail", "user"],
			["assistant", "conversation_tail", "assistant"],
			["toolResult", "tool_output", "tool"],
		]);
		expect(first.entries[2]?.provenance).toEqual({
			kind: "session_entry",
			sourceId: "session-entry-1",
		});
		expect(first.entries[0]?.provenance.kind).toBe("request_derived");
	});

	it("changes the entry revision for mutated content without changing its logical identity", () => {
		const original = buildContextProjection([userMessage("before")], { turnIndex: 1 });
		const mutated = buildContextProjection([userMessage("after")], { turnIndex: 1 });

		expect(mutated.entries[0]?.id).toBe(original.entries[0]?.id);
		expect(mutated.entries[0]?.revision).not.toBe(original.entries[0]?.revision);
		expect(mutated.revision).not.toBe(original.revision);
	});

	it("changes the ordered projection revision when stable entries are reordered", () => {
		const firstMessage = userMessage("first", 100);
		const secondMessage = userMessage("second", 200);
		const original = buildContextProjection([firstMessage, secondMessage], { turnIndex: 1 });
		const reordered = buildContextProjection([secondMessage, firstMessage], { turnIndex: 1 });

		expect(new Set(reordered.entries.map((entry) => entry.id))).toEqual(
			new Set(original.entries.map((entry) => entry.id)),
		);
		expect(reordered.revision).not.toBe(original.revision);
	});

	it("defers complete projection work until a consumer reads the accepted snapshot", () => {
		let provenanceLookups = 0;
		const projection = buildContextProjection([toolResultMessage("result")], {
			turnIndex: 1,
			sessionEntryIdForToolCallId: () => {
				provenanceLookups++;
				return "session-entry-1";
			},
		});

		expect(provenanceLookups).toBe(0);
		expect(projection.observedAtTurn).toBe(1);
		expect(projection.revision).toHaveLength(64);
		expect(projection.entries[0]?.provenance).toEqual({
			kind: "session_entry",
			sourceId: "session-entry-1",
		});
		expect(provenanceLookups).toBe(1);
	});
});
