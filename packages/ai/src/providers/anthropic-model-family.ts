/** Recognize native IDs, gateway IDs and display names for Claude Haiku 5.5. */
export function isAnthropicHaiku55(value: string): boolean {
	const normalized = value.toLowerCase().replace(/[\s_.:]+/g, "-");
	return /haiku-5-5(?:[-/]|$)/.test(normalized);
}
