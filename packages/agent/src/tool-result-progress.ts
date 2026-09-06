import type { ToolResultMessage } from "@caupulican/pi-ai/types";
import { getToolExecutionKey, normalizeToolSignature, stableToolFailureEnvelopeText } from "./tool-failure-memory.ts";
import type { AgentToolCall } from "./types.ts";

/** Execution IDs and ledger occurrence stamps do not change observable tool output. */
export function toolResultBatchSignature(toolResults: readonly ToolResultMessage[]): string {
	return getToolExecutionKey(
		"tool_result_batch",
		toolResults.map((result) => ({
			toolName: result.toolName,
			content: result.content.map((block) =>
				block.type === "text" ? { ...block, text: stableToolFailureEnvelopeText(block.text) } : block,
			),
			isError: result.isError,
		})),
	);
}

const MAX_RETAINED_OPERATIONS = 256;
const RESULT_HISTORY_TURNS = 12;

/** Bounded evidence of repeated observable work, independent of batch size and order. */
export class ToolResultProgressTracker {
	private readonly lastSeen = new Map<string, number>();
	private turn = 0;
	private repeats = 0;
	private reset(): number {
		this.lastSeen.clear();
		this.repeats = 0;
		return 0;
	}

	observe(calls: readonly AgentToolCall[], results: readonly ToolResultMessage[]): number {
		this.turn++;
		for (const [key, turn] of this.lastSeen) {
			if (this.turn - turn > RESULT_HISTORY_TURNS) this.lastSeen.delete(key);
		}
		if (calls.length === 0 || calls.length > MAX_RETAINED_OPERATIONS || results.length !== calls.length) {
			return this.reset();
		}
		const byId = new Map(results.map((result) => [result.toolCallId, result]));
		if (byId.size !== calls.length) return this.reset();
		const keys: string[] = [];
		for (const call of calls) {
			const result = byId.get(call.id);
			if (!result || result.toolName !== call.name) return this.reset();
			byId.delete(call.id);
			keys.push(`${normalizeToolSignature([[call.name, call.arguments]])}:${toolResultBatchSignature([result])}`);
		}
		this.repeats = keys.every((key) => this.lastSeen.has(key)) ? this.repeats + 1 : 0;
		for (const key of keys) {
			this.lastSeen.delete(key);
			this.lastSeen.set(key, this.turn);
		}
		while (this.lastSeen.size > MAX_RETAINED_OPERATIONS) {
			const oldest = this.lastSeen.keys().next().value;
			if (oldest === undefined) break;
			this.lastSeen.delete(oldest);
		}
		return this.repeats;
	}
}
