/** Provider-bound tool prose budgets. Structural schemas remain separate and exact. */
export const MAX_PROVIDER_TOOL_SNIPPET_CHARS = 120;
export const MAX_PROVIDER_TOOL_GUIDELINE_CHARS = 140;
export const MAX_PROVIDER_TOOL_GUIDELINES_CHARS = 1_200;

function oneLine(text: string): string {
	return text
		.replace(/[\r\n]+/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function truncateWithEllipsis(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	if (maxChars <= 0) return "";
	if (maxChars === 1) return "…";

	let end = maxChars - 1;
	const finalCodeUnit = text.charCodeAt(end - 1);
	if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) {
		end -= 1;
	}
	return `${text.slice(0, end).trimEnd()}…`;
}

export function normalizeProviderPromptSnippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const normalized = oneLine(text);
	if (normalized.length === 0) return undefined;
	return truncateWithEllipsis(normalized, MAX_PROVIDER_TOOL_SNIPPET_CHARS);
}

export function normalizeProviderPromptGuidelines(guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) return [];
	const unique = new Set<string>();
	let total = 0;
	for (const guideline of guidelines) {
		const normalized = oneLine(guideline);
		if (normalized.length === 0) continue;
		const bounded = truncateWithEllipsis(normalized, MAX_PROVIDER_TOOL_GUIDELINE_CHARS);
		if (unique.has(bounded)) continue;

		const remaining = MAX_PROVIDER_TOOL_GUIDELINES_CHARS - total;
		if (remaining <= 0) break;
		const admitted = truncateWithEllipsis(bounded, remaining);
		if (admitted.length === 0) break;
		unique.add(admitted);
		total += admitted.length;
		if (admitted.length < bounded.length) break;
	}
	return Array.from(unique);
}
