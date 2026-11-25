/** Shared transcript display state, reload notices, and formatted tool failures. */
import type { AssistantMessage } from "@caupulican/pi-ai";
import { type Component, type Container, Text } from "@caupulican/pi-tui";
import { interfaceText } from "../../core/language/interface-text.ts";
import { REPLY_ROUTE_CUSTOM_TYPE, type ReplyRouteRecord } from "../../core/reply-route.ts";
import { boundedRedactedDiagnosticText } from "../../core/security/secret-text.ts";
import { getUserMessageText } from "../../kernel/messages.ts";
import type { SessionManager } from "../../kernel/node.ts";
import type { SessionHistoryPage } from "../../kernel/session/session-history-page.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { theme } from "../../presentation/theme-model.ts";
import { ActionTranscriptComponent } from "./components/action-transcript.ts";
import { AssistantMessageComponent } from "./components/assistant-message.ts";
import { isExpandable } from "./components/expandable-text.ts";
import type { ToolExecutionComponent } from "./components/tool-execution.ts";
import { messagesForTuiHistoryReload, TUI_HISTORY_RELOAD_MAX_LINES } from "./history-reload-math.ts";

/** Restore historical routed-reply bylines only from the selected branch. */
export function readReplyRoutes(manager: SessionManager): Map<number, ReplyRouteRecord["route"]> {
	const routes = new Map<number, ReplyRouteRecord["route"]>();
	for (const entry of manager.getCustomEntriesOnBranch([REPLY_ROUTE_CUSTOM_TYPE])) {
		const record = entry.data as ReplyRouteRecord | undefined;
		if (record && typeof record.timestamp === "number") routes.set(record.timestamp, record.route);
	}
	return routes;
}

/** Restore prompt recall without reading assistant or tool payloads, with a separate editor memory budget. */
export async function readEditorHistory(manager: SessionManager, signal: AbortSignal) {
	const entries: { entryId: string; text: string }[] = [];
	let start = manager.getLeafId();
	let units = 0;
	while (start && entries.length < 100 && units < 512 * 1024) {
		const page = await manager.readHistoryPage(start, { signal, usersOnly: true });
		for (let index = page.records.length - 1; index >= 0 && entries.length < 100; index--) {
			const { id, message } = page.records[index]!;
			if (message?.role !== "user") continue;
			const text = getUserMessageText(message).trim();
			if (!text) continue;
			units += text.length;
			if (units > 512 * 1024) break;
			entries.push({ entryId: id, text });
		}
		start = page.older;
	}
	return entries.reverse();
}

/** An asynchronous tail cannot install over a live append or an already mounted turn. */
export async function readStableLiveHistory(
	manager: SessionManager,
	revision: () => number | undefined,
	signal: AbortSignal,
): Promise<{ page: SessionHistoryPage; leaf: string | null; revision: number } | undefined> {
	for (let attempt = 0; attempt < 2; attempt++) {
		const before = revision();
		if (before === undefined) return undefined;
		const leaf = manager.getLeafId();
		const page = await manager.readHistoryPage(leaf, { signal });
		if (leaf === manager.getLeafId() && revision() === before) return { page, leaf, revision: before };
	}
	return undefined;
}

export function renderSavedHistoryRows(
	page: SessionHistoryPage,
	container: Container,
	render: (message: AgentMessage, id: string) => void,
	rememberTurn?: (component: Component | undefined, id: string) => void,
): void {
	for (const { id, message, oversized } of page.records) {
		const start = container.children.length;
		if (oversized) {
			container.addChild(new Text(theme.fg("dim", interfaceText().interactive.historyRecordOversized), 1, 0));
		} else if (message) {
			render(message, id);
			if (message.role === "user" || message.role === "assistant") rememberTurn?.(container.children[start], id);
		}
	}
}

export function settleArchiveTools(tools: Iterable<ToolExecutionComponent>): void {
	const text = interfaceText().interactive.historyToolResultUnavailable;
	for (const tool of tools) {
		if (!tool.followsLiveExecution) tool.updateResult({ content: [{ type: "text", text }], isError: false });
	}
}

/** Display state an older row must adopt, because it was built after the operator changed a toggle. */
export interface HistoryDisplayState {
	showImages: boolean;
	imageWidthCells: number;
	toolsExpanded: boolean;
	actionsExpanded: boolean;
	hideThinkingBlock: boolean;
}

/** Selects the bounded reload tail and creates the one row that discloses its omitted prefix. */
export function tuiHistoryReloadWindow(
	messages: AgentMessage[],
	includeToolResultContent: boolean,
): { messages: AgentMessage[]; notice?: Component } {
	const selected = messagesForTuiHistoryReload(messages, { includeToolResultContent });
	const notice =
		selected.omittedMessages > 0
			? new Text(
					theme.fg(
						"dim",
						interfaceText().interactive.historyWindow(TUI_HISTORY_RELOAD_MAX_LINES, selected.omittedMessages),
					),
					1,
					0,
				)
			: undefined;
	return { messages: selected.messages, ...(notice ? { notice } : {}) };
}

/** Applies the operator's current toggles and image settings to rows that were rendered off-screen. */
export function applyHistoryDisplayState(children: readonly Component[], state: Partial<HistoryDisplayState>): void {
	for (const child of children) {
		if (child instanceof ActionTranscriptComponent) {
			if (state.showImages !== undefined) child.setShowImages(state.showImages);
			if (state.imageWidthCells !== undefined) child.setImageWidthCells(state.imageWidthCells);
			if (state.actionsExpanded !== undefined) child.setTranscriptExpanded(state.actionsExpanded);
			continue;
		}
		if (state.hideThinkingBlock !== undefined && child instanceof AssistantMessageComponent)
			child.setHideThinkingBlock(state.hideThinkingBlock);
		if (state.toolsExpanded !== undefined && isExpandable(child)) child.setExpanded(state.toolsExpanded);
	}
}

/** What a failed tool call says in the Root transcript. */
export function rootToolFailureText(message: AssistantMessage, retryAttempt: number): string {
	const text = interfaceText();
	if (message.stopReason === "aborted") {
		return retryAttempt > 0
			? text.conversation.abortedAfterRetries(retryAttempt)
			: text.conversation.operationAborted;
	}
	return message.errorMessage || text.notices.errorWord;
}

/**
 * What a failed tool call says in a bot or team transcript. A peer's provider error can echo credentials
 * and internal endpoints, so only one redacted line survives; Root keeps its full diagnostic.
 */
export function targetToolFailureText(message: AssistantMessage): string {
	const text = interfaceText();
	if (message.stopReason === "aborted") return text.conversation.operationAborted;
	const redacted = message.errorMessage ? boundedRedactedDiagnosticText(message.errorMessage) : undefined;
	return redacted || text.notices.errorWord;
}
