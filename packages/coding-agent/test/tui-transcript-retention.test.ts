import { type AssistantMessage, createEmptyUsage } from "@caupulican/pi-ai";
import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, expect, it } from "vitest";
import type { AgentMessage } from "../src/kernel/types.ts";
import { ActiveToolCallRegistry } from "../src/modes/interactive/components/active-tool-call-registry.ts";
import {
	ConversationSnapshotBuilder,
	ConversationWindow,
} from "../src/modes/interactive/components/conversation-window.ts";
import { ToolExecutionState } from "../src/modes/interactive/components/tool-execution.ts";
import {
	messagesForTuiHistoryReload,
	TUI_HISTORY_RELOAD_MAX_LINES,
} from "../src/modes/interactive/history-reload-math.ts";
import {
	LiveTranscriptRetention,
	TUI_LIVE_HISTORY_MAX_COMPONENTS,
	TUI_LIVE_HISTORY_TRIM_TO_COMPONENTS,
	WithdrawableUserEchoRetention,
} from "../src/modes/interactive/live-transcript-retention.ts";
import { initTheme } from "../src/presentation/theme/theme.ts";

beforeAll(() => initTheme("dark"));

function retentionFor(root: Container, streaming?: Text): LiveTranscriptRetention {
	return new LiveTranscriptRetention({
		root,
		streaming: () => streaming,
		withdrawableEchoes: () => [],
		requestRender: () => undefined,
	});
}

it("checks child changes in a plain Container before reusing a conversation frame", () => {
	const root = new Container();
	const nested = new Container();
	const text = new Text("old", 0, 0);
	nested.addChild(text);
	root.addChild(nested);
	const source = new ConversationSnapshotBuilder({ getRoot: () => root, getActive: () => root });
	const viewport = new ConversationWindow(() => source.getSnapshot());

	expect(viewport.render(12, 1)[0]).toContain("old");
	text.setText("new");
	expect(viewport.render(12, 1)[0]).toContain("new");
});

it("appends the first root status after construction and reset", () => {
	const root = new Container();
	const retention = retentionFor(root);

	retention.appendStatus(root, "first", false);
	expect(root.children).toHaveLength(2);
	retention.reset();
	root.clear();
	retention.appendStatus(root, "after reset", false);
	expect(root.children).toHaveLength(2);
});

it("retains an undelivered echo for withdrawal and releases its association only after durable delivery", () => {
	const root = new Container();
	const echoes = new WithdrawableUserEchoRetention();
	const pending = { role: "user", content: "pending", timestamp: 1 } as const;
	const pendingComponent = new Text("pending");
	root.addChild(pendingComponent);
	echoes.remember(pending, [pendingComponent]);
	const references = (echoes as unknown as { references: Set<WeakRef<object>> }).references;
	expect([...references][0]).toBeInstanceOf(WeakRef);
	echoes.reconcile(() => false);
	echoes.withdraw(pending, root);
	expect(root.children).not.toContain(pendingComponent);

	const delivered = { role: "user", content: "delivered", timestamp: 2 } as const;
	const deliveredComponent = new Text("delivered");
	root.addChild(deliveredComponent);
	echoes.remember(delivered, [deliveredComponent]);
	echoes.reconcile((message) => message === delivered);
	echoes.withdraw(delivered, root);
	expect(root.children).toContain(deliveredComponent);
});

it("bounds live transcript components without discarding an early streaming reply", () => {
	const root = new Container();
	const streaming = new Text("streaming");
	root.addChild(streaming);
	for (let index = 0; index < TUI_LIVE_HISTORY_MAX_COMPONENTS; index++) {
		root.addChild(new Text(`settled-${index}`));
	}
	const retention = retentionFor(root, streaming);

	retention.trim();

	expect(root.children).toContain(streaming);
	expect(root.children.length).toBe(TUI_LIVE_HISTORY_TRIM_TO_COMPONENTS + 1);
});

it("hands off a contiguous Workbench prefix at the next durable turn", () => {
	const root = new Container();
	const evicted: Text[] = [];
	const nextTurn = new Text("next owner turn");
	for (let index = 0; index < TUI_LIVE_HISTORY_MAX_COMPONENTS; index++) {
		const child = new Text(`tool output ${index}`);
		root.addChild(child);
		evicted.push(child);
	}
	root.addChild(nextTurn);
	const boundaries: { id: string; components: readonly unknown[] }[] = [];
	const retention = new LiveTranscriptRetention({
		root,
		streaming: () => undefined,
		withdrawableEchoes: () => [],
		pagesHistory: () => true,
		previousEntryId: () => "last-result",
		historyBoundary: (id, components) => {
			boundaries.push({ id, components });
			return true;
		},
		requestRender: () => undefined,
	});
	retention.rememberTurnStart(nextTurn, "next-turn");
	retention.trim();

	expect(root.children).toEqual([nextTurn]);
	expect(boundaries).toEqual([{ id: "last-result", components: evicted }]);
});

it("pages settled exchanges within one turn while a detached tool still receives its terminal result", () => {
	const root = new Container();
	const activeView = new Text("early action");
	const execution = new ToolExecutionState("read", {}, {});
	root.addChild(activeView);
	let next = 0;
	let previous: string | undefined;
	const savedParents = new Map<string, string>();
	let handedOffActiveView = false;
	const retention = new LiveTranscriptRetention({
		root,
		streaming: () => undefined,
		withdrawableEchoes: () => [],
		pagesHistory: () => true,
		previousEntryId: (id) => savedParents.get(id),
		historyBoundary: (_id, evicted) => {
			if (evicted.includes(activeView)) handedOffActiveView = true;
			return true;
		},
		requestRender: () => undefined,
	});
	for (let exchange = 0; exchange < TUI_LIVE_HISTORY_MAX_COMPONENTS * 3; exchange++) {
		const id = `assistant-${next++}`;
		const component = new Text(id);
		root.addChild(component);
		retention.rememberTurnStart(component, id);
		if (previous) savedParents.set(id, previous);
		previous = id;
		retention.trim();
		expect(root.children.length).toBeLessThanOrEqual(TUI_LIVE_HISTORY_MAX_COMPONENTS);
	}
	expect(handedOffActiveView).toBe(true);
	expect(root.children).not.toContain(activeView);
	execution.updateResult({ content: [{ type: "text", text: "late result" }], isError: false });
	expect(execution.result?.content[0]?.text).toBe("late result");
});

it("rebinds archived tool rows only to their own assistant exchange, including during a pending result commit", () => {
	const calls = new ActiveToolCallRegistry();
	const callId = "reused-call-id";
	const first = new ToolExecutionState("read", { path: "first" }, {});
	const second = new ToolExecutionState("read", { path: "second" }, {});
	const firstReply: AssistantMessage = {
		role: "assistant",
		content: [{ type: "toolCall", id: callId, name: "read", arguments: { path: "first" } }],
		api: "openai-completions",
		provider: "openai",
		model: "fixture",
		usage: createEmptyUsage(),
		stopReason: "toolUse",
		timestamp: 1,
	};
	const secondReply = { ...firstReply, timestamp: 2 };
	const entries = new Map<object, string>([
		[firstReply, "earlier"],
		[secondReply, "later"],
	]);
	const manager = { getMessageEntryId: (message: object) => entries.get(message) };

	calls.register(callId, first);
	calls.recordAssistant(firstReply);
	calls.finish(callId, true);
	calls.clearActive(true);
	calls.register(callId, second);
	calls.recordAssistant(secondReply);

	expect(calls.findForEntry(callId, "earlier", manager)).toBe(first);
	expect(calls.findForEntry(callId, "later", manager)).toBe(second);
	expect(calls.findForEntry(callId, "unrelated", manager)).toBeUndefined();
});

it("selects the bounded reload tail without materializing an omitted cold prefix", () => {
	const messages: AgentMessage[] = [];
	const cold = { role: "user", timestamp: 0 } as unknown as AgentMessage;
	Object.defineProperty(cold, "content", {
		enumerable: true,
		get: () => {
			throw new Error("omitted cold prefix was materialized");
		},
	});
	messages.push(cold);
	for (let timestamp = 1; timestamp <= TUI_HISTORY_RELOAD_MAX_LINES; timestamp++) {
		messages.push({ role: "user", content: `tail-${timestamp}`, timestamp });
	}

	const selected = messagesForTuiHistoryReload(messages);

	expect(selected.omittedMessages).toBeGreaterThan(0);
	expect(selected.estimatedLines).toBeLessThanOrEqual(TUI_HISTORY_RELOAD_MAX_LINES);
});
