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

export function normalizeProviderPromptSnippet(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const normalized = oneLine(text);
	if (normalized.length === 0) return undefined;
	if (normalized.length > MAX_PROVIDER_TOOL_SNIPPET_CHARS) {
		throw new Error(
			`Provider tool snippet exceeds ${MAX_PROVIDER_TOOL_SNIPPET_CHARS} characters (${normalized.length}): ${normalized.slice(0, 48)}`,
		);
	}
	return normalized;
}

export function normalizeProviderPromptGuidelines(guidelines: string[] | undefined): string[] {
	if (!guidelines || guidelines.length === 0) return [];
	const unique = new Set<string>();
	let total = 0;
	for (const guideline of guidelines) {
		const normalized = oneLine(guideline);
		if (normalized.length === 0 || unique.has(normalized)) continue;
		if (normalized.length > MAX_PROVIDER_TOOL_GUIDELINE_CHARS) {
			throw new Error(
				`Provider tool guideline exceeds ${MAX_PROVIDER_TOOL_GUIDELINE_CHARS} characters (${normalized.length}): ${normalized.slice(0, 48)}`,
			);
		}
		total += normalized.length;
		if (total > MAX_PROVIDER_TOOL_GUIDELINES_CHARS) {
			throw new Error(
				`Provider tool guidelines exceed ${MAX_PROVIDER_TOOL_GUIDELINES_CHARS} characters (${total}).`,
			);
		}
		unique.add(normalized);
	}
	return Array.from(unique);
}
