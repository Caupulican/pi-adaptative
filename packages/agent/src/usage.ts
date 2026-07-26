import type { Usage } from "@caupulican/pi-ai";
import type { SessionEntry } from "./session/session-manager.ts";

export function createEmptyUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

export function addUsage(target: Usage, usage: Usage): void {
	target.input += usage.input;
	target.output += usage.output;
	target.cacheRead += usage.cacheRead;
	target.cacheWrite += usage.cacheWrite;
	target.totalTokens += usage.totalTokens;
	target.cost.input += usage.cost.input;
	target.cost.output += usage.cost.output;
	target.cost.cacheRead += usage.cost.cacheRead;
	target.cost.cacheWrite += usage.cost.cacheWrite;
	target.cost.total += usage.cost.total;
}

export function combineUsage(...usages: Array<Usage | undefined>): Usage {
	const total = createEmptyUsage();
	for (const usage of usages) {
		if (usage) addUsage(total, usage);
	}
	return total;
}

/** Return usage billed directly by a durable session entry, excluding nested-session rollups. */
export function getSessionEntryUsage(entry: SessionEntry): Usage | undefined {
	if (entry.type === "message") {
		if (entry.message.role === "assistant" || entry.message.role === "toolResult") {
			return entry.message.usage;
		}
		return undefined;
	}
	if (entry.type === "compaction" || entry.type === "branch_summary") return entry.usage;
	return undefined;
}
