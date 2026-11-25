import type { AssistantMessage } from "@caupulican/pi-ai";
import type { SessionEntry } from "../../../kernel/session/session-entries.ts";
import type { SessionManager } from "../../../kernel/session/session-manager.ts";
import type { ToolExecutionState } from "./tool-execution.ts";

/** Tool-call identity owner through the matching result receipt. */
export class ActiveToolCallRegistry {
	private readonly activeByCallId = new Map<string, ToolExecutionState>();
	private readonly pendingResults = new Map<string, ToolExecutionState[]>();
	private readonly sources = new WeakMap<ToolExecutionState, WeakRef<AssistantMessage>>();
	private latestAssistant?: { message: WeakRef<AssistantMessage>; toolIds: ReadonlySet<string> };
	private readonly onCountChange?: () => void;

	constructor(onCountChange?: () => void) {
		this.onCountChange = onCountChange;
	}

	register(toolCallId: string, state: ToolExecutionState): void {
		const existed = this.activeByCallId.has(toolCallId);
		this.activeByCallId.set(toolCallId, state);
		if (this.latestAssistant?.toolIds.has(toolCallId)) this.sources.set(state, this.latestAssistant.message);
		if (!existed) this.onCountChange?.();
	}

	recordAssistant(message: AssistantMessage): void {
		const source = new WeakRef(message);
		const toolIds = new Set<string>();
		for (const call of message.content) {
			if (call.type !== "toolCall") continue;
			toolIds.add(call.id);
			const state = this.activeByCallId.get(call.id);
			if (state) this.sources.set(state, source);
		}
		this.latestAssistant = { message: source, toolIds };
	}

	findForEntry(
		toolCallId: string,
		entryId: string | undefined,
		manager: Pick<SessionManager, "getMessageEntryId">,
	): ToolExecutionState | undefined {
		if (entryId === undefined) return undefined;
		const active = this.activeByCallId.get(toolCallId);
		for (const state of [active, ...(this.pendingResults.get(toolCallId) ?? [])]) {
			if (!state) continue;
			const source = this.sources.get(state)?.deref();
			if (source && manager.getMessageEntryId(source) === entryId) return state;
		}
		return undefined;
	}

	hasActive(toolCallId: string): boolean {
		return this.activeByCallId.has(toolCallId);
	}

	getActive(toolCallId: string): ToolExecutionState | undefined {
		return this.activeByCallId.get(toolCallId);
	}

	activeEntries(): IterableIterator<[string, ToolExecutionState]> {
		return this.activeByCallId.entries();
	}

	finish(toolCallId: string, awaitPersistence = false): void {
		const state = this.activeByCallId.get(toolCallId);
		if (!state) return;
		this.activeByCallId.delete(toolCallId);
		if (awaitPersistence) {
			const earlier = this.pendingResults.get(toolCallId);
			if (earlier) earlier.push(state);
			else this.pendingResults.set(toolCallId, [state]);
		}
		this.onCountChange?.();
	}

	settlePersistedResults(ids: readonly string[], getEntry: (id: string) => SessionEntry | undefined): void {
		if (this.pendingResults.size === 0) return;
		for (const id of ids) {
			const entry = getEntry(id);
			if (entry?.type !== "message" || entry.message.role !== "toolResult") continue;
			const callId = entry.message.toolCallId;
			const records = this.pendingResults.get(callId);
			records?.shift();
			if (records?.length === 0) this.pendingResults.delete(callId);
		}
	}

	clearActive(keepPendingResults = false): void {
		this.latestAssistant = undefined;
		if (!keepPendingResults) this.pendingResults.clear();
		if (this.activeByCallId.size === 0) return;
		this.activeByCallId.clear();
		this.onCountChange?.();
	}

	get size(): number {
		return this.activeByCallId.size;
	}
}
