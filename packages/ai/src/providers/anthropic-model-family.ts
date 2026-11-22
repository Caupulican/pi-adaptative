import type { Model, SimpleStreamOptions } from "../types.ts";
import { mapStandardThinkingEffort } from "./provider-runtime.ts";

export type AnthropicEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type AnthropicThinkingDisplay = "summarized" | "omitted";

/** Recognize native IDs, gateway IDs and display names for Claude Haiku 5.5. */
export function isAnthropicHaiku55(value: string): boolean {
	const normalized = normalizeAnthropicModelName(value);
	return /haiku-5-5(?:[-/]|$)/.test(normalized);
}

/** Claude Opus 5.5 always reasons, including when the thinking field is omitted. */
export function isAnthropicOpus55(value: string): boolean {
	const normalized = normalizeAnthropicModelName(value);
	return /opus-5-5(?:[-/]|$)/.test(normalized);
}

function normalizeAnthropicModelName(value: string): string {
	return value.toLowerCase().replace(/[\s_.:]+/g, "-");
}

/** Mandatory reasoning follows model identity even when a custom catalog omits compatibility metadata. */
export function requiresAnthropicThinking(model: Model<"anthropic-messages">): boolean {
	return isAnthropicOpus55(model.id) || isAnthropicOpus55(model.name);
}

export function usesAdaptiveAnthropicThinking(model: Model<"anthropic-messages">): boolean {
	return model.compat?.forceAdaptiveThinking === true || requiresAnthropicThinking(model);
}

/**
 * Map ThinkingLevel to Anthropic effort levels for adaptive thinking.
 * The catalog defines which effort levels each model supports.
 */
export function mapAnthropicThinkingEffort(
	model: Model<"anthropic-messages">,
	level: SimpleStreamOptions["reasoning"],
): AnthropicEffort {
	return mapStandardThinkingEffort(model, level) as AnthropicEffort;
}
