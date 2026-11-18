import { type AssistantMessage, AssistantMessageEventStream, createEmptyUsage } from "@caupulican/pi-ai";
import { observeHistoryWork } from "@caupulican/pi-ai/history-work";
import { expect, it } from "vitest";
import { Agent } from "../src/kernel/agent.ts";
import {
	createVersionedMessageHistory,
	immutableHistoryMessage,
	type MessageHistoryVersion,
	messageHistoryVersion,
	messageSourceOf,
	unchangedMessagePrefix,
} from "../src/kernel/message-revision.ts";
import { ToolFailureRecoveryGate, ToolFailureRecoveryHistory } from "../src/kernel/tool-failure-recovery-gate.ts";
import type { AgentMessage } from "../src/kernel/types.ts";

const user = (content: string): AgentMessage => ({ role: "user", content, timestamp: 1 });

function reply(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-completions",
		provider: "fixture",
		model: "fixture",
		usage: createEmptyUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
}

it("proves an immutable common prefix across appends, edits and branch replacement", () => {
	const raw = user("old");
	const first = immutableHistoryMessage(raw)!;
	const second = immutableHistoryMessage(user("second"))!;
	const history = createVersionedMessageHistory([first, second]);
	const before = messageHistoryVersion(history)!;
	history.push(immutableHistoryMessage(user("third"))!);
	expect(unchangedMessagePrefix(before, messageHistoryVersion(history)!)).toBe(2);

	history[1] = immutableHistoryMessage(user("edited"))!;
	expect(unchangedMessagePrefix(before, messageHistoryVersion(history)!)).toBe(1);
	const otherBranch = createVersionedMessageHistory(history);
	expect(unchangedMessagePrefix(before, messageHistoryVersion(otherBranch)!)).toBe(0);

	history.push(raw);
	expect(messageHistoryVersion(history)).toBeUndefined();
	expect(unchangedMessagePrefix(before, messageHistoryVersion(history, 3)!)).toBe(1);
	expect(messageSourceOf(first)).toBe(raw);
	expect(Object.isFrozen(first)).toBe(true);
});

it("publishes direct Agent history appends and supported content edits to the next request", async () => {
	const opening = user("original");
	const sideInput = user("late input");
	const requests: { messages: AgentMessage[]; version: MessageHistoryVersion | undefined }[] = [];
	const agent = new Agent({
		initialState: {
			messages: [opening],
			model: {
				id: "fixture",
				name: "Fixture",
				api: "openai-completions",
				provider: "fixture",
				baseUrl: "https://unused.invalid",
				input: ["text"],
				reasoning: false,
				contextWindow: 32_000,
				maxTokens: 1_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		},
		planContext: async ({ messages }) => {
			requests.push({ messages: messages.slice(), version: messageHistoryVersion(messages) });
			return { messages };
		},
		streamFn: () => {
			const stream = new AssistantMessageEventStream();
			const message = reply([{ type: "text", text: "done" }]);
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	agent.useIsolatedRequestHistory(() => true);
	let appended = false;
	agent.subscribe(
		(event) => {
			if (event.type === "turn_start" && !appended) {
				appended = true;
				agent.appendMessage(sideInput);
			}
		},
		{ publishesMessageEdits: true },
	);
	await agent.prompt("first prompt");
	expect(agent.state.messages[0]).toBe(opening);
	expect(requests[0]?.messages.some((message) => messageSourceOf(message) === sideInput)).toBe(true);
	expect(requests[0]?.version).toBeDefined();

	agent.replaceMessageContents(opening, user("published edit"));
	await agent.prompt("second prompt");
	expect(requests[1]?.messages[0]).toMatchObject({ content: "published edit" });
	expect(unchangedMessagePrefix(requests[0]!.version!, requests[1]!.version!)).toBe(0);

	const unsubscribe = agent.subscribe((event) => {
		if (event.type === "turn_start" && opening.role === "user") opening.content = "unclassified callback";
	});
	await agent.prompt("third prompt");
	unsubscribe();
	expect(requests[2]?.messages[0]).toMatchObject({ content: "unclassified callback" });
	expect(requests[2]?.version).toBeUndefined();
});

it("extends recovery replay across a run boundary that splits tool call and result", () => {
	const owned = (message: AgentMessage): AgentMessage => immutableHistoryMessage(message)!;
	const call = (id: string): AgentMessage =>
		reply([{ type: "toolCall", id, name: "lookup", arguments: { path: "file.txt" } }]);
	const result = (id: string, isError: boolean): AgentMessage => ({
		role: "toolResult",
		toolCallId: id,
		toolName: "lookup",
		isError,
		content: [{ type: "text", text: isError ? "Permission denied" : "ok" }],
		timestamp: 3,
	});
	const history = createVersionedMessageHistory([
		...Array.from({ length: 128 }, (_, index) => owned(user(String(index)))),
		owned(call("first")),
	]);
	const recovery = new ToolFailureRecoveryHistory();
	const first = new ToolFailureRecoveryGate();
	first.restoreFromMessages(history, [], recovery);
	expect(first.isEmpty()).toBe(true);

	const work = observeHistoryWork(history);
	history.push(owned(result("first", true)));
	const failed = new ToolFailureRecoveryGate();
	failed.restoreFromMessages(history, [], recovery);
	expect(failed.isEmpty()).toBe(false);
	expect(work.oldRowsRead).toBe(0);

	history.push(owned(call("second")), owned(result("second", false)));
	const resolved = new ToolFailureRecoveryGate();
	resolved.restoreFromMessages(history, [], recovery);
	expect(resolved.isEmpty()).toBe(true);
	expect(work.oldRowsRead).toBe(0);
});
