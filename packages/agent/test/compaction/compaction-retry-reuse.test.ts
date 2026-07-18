import type { AssistantMessage } from "@caupulican/pi-ai";
import { createAssistantMessageEventStream, getModel } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "../../src/compaction/index.ts";
import type { AgentMessage, StreamFn } from "../../src/types.ts";

// Regression coverage: the structurally-broken-summary retry in `compact()` used to
// re-serialize and re-preDigest the entire raw conversation span on every attempt, even though the
// span and preDigest callback are identical across attempts. It must now compute the (serialized +
// pre-digested) conversation text ONCE and reuse it for every attempt.

function createUserMessage(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: Date.now() };
}

function createAssistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		usage: {
			input: 10,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 20,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
	};
}

function createDoneStream(message: AssistantMessage): ReturnType<typeof createAssistantMessageEventStream> {
	const stream = createAssistantMessageEventStream();
	stream.push({ type: "done", reason: "stop", message });
	return stream;
}

const facts = {
	files: [{ path: "src/widget.ts", kind: "modified" as const, note: "EDIT" }],
	workingSet: [{ path: "src/widget.ts", kind: "modified" as const, note: "EDIT" }],
	actions: ["EDIT src/widget.ts"],
	errorFacts: [],
	prohibitions: [],
	cancelledText: "",
	activeTaskSource: "Fix the widget",
};

const VALID_CHECKPOINT = `## Active Task
Fix the widget

### Mandatory Rules
(none)

## Working Set
- src/widget.ts — EDIT

## Files
- src/widget.ts

## Open Problems
(none)

## Done
1. EDIT src/widget.ts`;

function createPreparation(): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [createUserMessage("Fix the widget"), createUserMessage("Please handle it end to end")],
		turnPrefixMessages: [],
		isSplitTurn: false,
		tokensBefore: 1200,
		fileOps: { read: new Set(), written: new Set(), edited: new Set() },
		settings: { ...DEFAULT_COMPACTION_SETTINGS, reserveTokens: 4000, keepRecentTokens: 100 },
		facts,
	};
}

describe("compact() structurally-broken-summary retry", () => {
	it("reuses the pre-digested conversation text and skips a second preDigest call on retry", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const preDigestCalls: string[] = [];
		const preDigest = vi.fn(async (conversationText: string) => {
			preDigestCalls.push(conversationText);
			return `[DIGESTED]:${conversationText}`;
		});

		const promptsSeen: string[] = [];
		let call = 0;
		const streamFn: StreamFn = async (_model, context) => {
			call++;
			const userMessage = context.messages[0];
			const text = Array.isArray(userMessage.content)
				? userMessage.content
						.filter((part): part is { type: "text"; text: string } => part.type === "text")
						.map((part) => part.text)
						.join("\n")
				: userMessage.content;
			promptsSeen.push(text);
			// Attempt 0: structurally broken (no recognizable sections) -> forces the retry ladder.
			// Attempt 1: a valid checkpoint that satisfies the verification gate.
			return createDoneStream(createAssistantMessage(call === 1 ? "not a checkpoint" : VALID_CHECKPOINT));
		};

		const result = await compact(
			createPreparation(),
			model,
			"test-key",
			undefined,
			undefined,
			undefined,
			undefined,
			streamFn,
			preDigest,
		);

		expect(call).toBe(2);
		// The retry must NOT re-run the pre-digest LLM pass over the unchanged span.
		expect(preDigest).toHaveBeenCalledTimes(1);
		// Both attempts must send the SAME pre-digested <conversation> block (not a re-serialized/raw
		// resend) — only the retry instructions appended after it may differ.
		const extractConversation = (prompt: string) => /<conversation>\n([\s\S]*?)\n<\/conversation>/.exec(prompt)?.[1];
		const conversation0 = extractConversation(promptsSeen[0]);
		const conversation1 = extractConversation(promptsSeen[1]);
		expect(conversation0).toContain("[DIGESTED]:");
		expect(conversation1).toBe(conversation0);
		expect(result.verification).toEqual({ ok: true, failures: [] });
	});

	it("sets cacheRetention explicitly on the summarization request options", async () => {
		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const seenOptions: Array<{ cacheRetention?: string }> = [];
		const streamFn: StreamFn = async (_model, _context, options) => {
			seenOptions.push({ cacheRetention: options?.cacheRetention });
			return createDoneStream(createAssistantMessage(VALID_CHECKPOINT));
		};

		await compact(createPreparation(), model, "test-key", undefined, undefined, undefined, undefined, streamFn);

		expect(seenOptions).toHaveLength(1);
		expect(seenOptions[0].cacheRetention).toBe("short");
	});
});
