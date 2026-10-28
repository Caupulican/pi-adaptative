import type { Usage } from "@caupulican/pi-ai/types";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import type { SessionEntry } from "./session/session-entries.ts";

export { createEmptyUsage };

function hasTokens(usage: Usage): boolean {
	return usage.input > 0 || usage.output > 0 || usage.cacheRead > 0 || usage.cacheWrite > 0 || usage.totalTokens > 0;
}

export function addUsage(target: Usage, usage: Usage): void {
	// Report a complete reasoning subtotal only when every contributing usage supplies it.
	if (hasTokens(usage)) {
		const previous = target.details?.reasoningTokens;
		const reasoning = usage.details?.reasoningTokens;
		if (reasoning !== undefined && (!hasTokens(target) || previous !== undefined)) {
			target.details = { ...target.details, reasoningTokens: (previous ?? 0) + reasoning };
		} else if (target.details !== undefined) {
			delete target.details.reasoningTokens;
		}
	}
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
	if (usage.cost.estimate === "base-rates") target.cost.estimate = "base-rates";
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
