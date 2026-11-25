import { Container, Text } from "@caupulican/pi-tui";
import { beforeAll, expect, it } from "vitest";
import type { AgentMessage } from "../src/kernel/types.ts";
import {
	ConversationSnapshotBuilder,
	ConversationWindow,
} from "../src/modes/interactive/components/conversation-window.ts";
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
		activeActions: () => [],
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
		activeActions: () => [],
		withdrawableEchoes: () => [],
		pagesHistory: () => true,
		previousEntryId: () => "last-result",
		historyBoundary: (id, components) => boundaries.push({ id, components }),
		requestRender: () => undefined,
	});
	retention.rememberTurnStart(nextTurn, "next-turn");
	retention.trim();

	expect(root.children).toEqual([nextTurn]);
	expect(boundaries).toEqual([{ id: "last-result", components: evicted }]);
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
