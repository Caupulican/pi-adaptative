import type { Usage } from "@caupulican/pi-ai/types";
import { createEmptyUsage } from "@caupulican/pi-ai/usage";
import type { SessionEntry } from "./session/session-entries.ts";
import type { UsageComponent } from "./usage-components.ts";

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
	if (entry.type === "compaction" || entry.type === "branch_summary")
		return entry.usageReceiptOwned ? undefined : entry.usage;
	return undefined;
}

export type SessionEntryUsageComponent = Omit<UsageComponent, "provider" | "model"> & {
	readonly provider?: string;
	readonly model?: string;
};

/** Expand only conserved direct responses; callers never price a multi-model aggregate as one model. */
export function getSessionEntryUsageComponents(entry: SessionEntry): readonly SessionEntryUsageComponent[] {
	const usage = getSessionEntryUsage(entry);
	if (!usage) return [];
	if ((entry.type === "compaction" || entry.type === "branch_summary") && entry.usageComponents !== undefined) {
		return validateUsageComponents(usage, entry.usageComponents);
	}
	const message = entry.type === "message" && entry.message.role === "assistant" ? entry.message : undefined;
	return [
		{
			sourceId: entry.id,
			timestamp: entry.timestamp,
			usage,
			...(message ? { provider: message.provider, model: message.model } : {}),
		},
	];
}

export function validateUsageComponents(
	usage: Usage,
	components: readonly UsageComponent[],
): readonly UsageComponent[] {
	assertValidComponentUsage(usage);
	if (!Array.isArray(components)) throw new Error("Invalid maintenance usage components.");
	const total = createEmptyUsage();
	const ids = new Set<string>();
	for (const component of components) {
		if (
			!component ||
			typeof component !== "object" ||
			![component.sourceId, component.provider, component.model].every(
				(value) =>
					typeof value === "string" &&
					value.length > 0 &&
					value.length <= 4096 &&
					value.trim() === value &&
					!value.includes("\0"),
			) ||
			typeof component.timestamp !== "string" ||
			!Number.isFinite(Date.parse(component.timestamp)) ||
			ids.has(component.sourceId)
		)
			throw new Error("Invalid or repeated maintenance response identity.");
		const value = component.usage;
		assertValidComponentUsage(value);
		ids.add(component.sourceId);
		addUsage(total, value);
	}
	if (
		total.input !== usage.input ||
		total.output !== usage.output ||
		total.cacheRead !== usage.cacheRead ||
		total.cacheWrite !== usage.cacheWrite ||
		total.totalTokens !== usage.totalTokens ||
		Math.abs(total.cost.total - usage.cost.total) > Math.max(1e-9, Number.EPSILON * Math.abs(usage.cost.total))
	)
		throw new Error("Maintenance response components do not conserve recorded usage.");
	return components;
}

function assertValidComponentUsage(value: Usage): void {
	if (
		!value?.cost ||
		![
			value.input,
			value.output,
			value.cacheRead,
			value.cacheWrite,
			value.totalTokens,
			value.cost.input,
			value.cost.output,
			value.cost.cacheRead,
			value.cost.cacheWrite,
			value.cost.total,
		].every((number) => typeof number === "number" && Number.isFinite(number) && number >= 0)
	)
		throw new Error("Invalid maintenance response usage.");
}
