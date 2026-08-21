import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Active tool-call identity owner. Completed actions live only in the transcript. */
export class ActiveToolCallRegistry {
	private readonly activeByCallId = new Map<string, ToolExecutionComponent>();

	register(toolCallId: string, action: ToolExecutionComponent): void {
		this.activeByCallId.set(toolCallId, action);
	}

	hasActive(toolCallId: string): boolean {
		return this.activeByCallId.has(toolCallId);
	}

	getActive(toolCallId: string): ToolExecutionComponent | undefined {
		return this.activeByCallId.get(toolCallId);
	}

	activeEntries(): IterableIterator<[string, ToolExecutionComponent]> {
		return this.activeByCallId.entries();
	}

	finish(toolCallId: string): void {
		this.activeByCallId.delete(toolCallId);
	}

	clearActive(): void {
		this.activeByCallId.clear();
	}
}
