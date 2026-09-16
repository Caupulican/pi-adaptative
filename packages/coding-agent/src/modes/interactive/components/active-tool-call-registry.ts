import type { ToolExecutionComponent } from "./tool-execution.ts";

/** Active tool-call identity owner. Completed actions live only in the transcript. */
export class ActiveToolCallRegistry {
	private readonly activeByCallId = new Map<string, ToolExecutionComponent>();
	private readonly onCountChange?: () => void;

	constructor(onCountChange?: () => void) {
		this.onCountChange = onCountChange;
	}

	register(toolCallId: string, action: ToolExecutionComponent): void {
		const existed = this.activeByCallId.has(toolCallId);
		this.activeByCallId.set(toolCallId, action);
		if (!existed) this.onCountChange?.();
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
		if (this.activeByCallId.delete(toolCallId)) this.onCountChange?.();
	}

	clearActive(): void {
		if (this.activeByCallId.size === 0) return;
		this.activeByCallId.clear();
		this.onCountChange?.();
	}

	get size(): number {
		return this.activeByCallId.size;
	}
}
