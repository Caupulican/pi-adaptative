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

/**
 * Bounds a guideline list to MAX_PROVIDER_TOOL_GUIDELINES_CHARS, preserving caller order (callers
 * that must survive budget pressure — e.g. a MANDATORY directive — should list those first).
 *
 * Guidelines that do not fit the remaining budget are dropped WHOLE, never truncated mid-word: a
 * half-sentence directive silently missing its second half is worse than the directive being absent.
 * Truncation only ever applies to the pathological case of a single guideline that alone exceeds the
 * *entire* budget — dropping it would erase it forever, so it is truncated to what's left instead
 * (and never down to a bare ellipsis with no real content).
 *
 * `onBounded`, when provided, receives one diagnostic message per dropped or truncated guideline —
 * this bounding is silent otherwise, which is itself a defect this parameter exists to let a caller
 * close (see delegate.ts, the only current caller that wires it to a warning channel).
 */
export function normalizeProviderPromptGuidelines(
	guidelines: string[] | undefined,
	onBounded?: (message: string) => void,
): string[] {
	if (!guidelines || guidelines.length === 0) return [];
	const unique = new Set<string>();
	let total = 0;
	for (const guideline of guidelines) {
		const normalized = oneLine(guideline);
		if (normalized.length === 0) continue;
		const bounded = truncateWithEllipsis(normalized, MAX_PROVIDER_TOOL_GUIDELINE_CHARS);
		if (unique.has(bounded)) continue;

		const remaining = MAX_PROVIDER_TOOL_GUIDELINES_CHARS - total;
		if (remaining <= 0) {
			onBounded?.(`Provider tool guideline dropped: guidelines budget exhausted: "${bounded.slice(0, 48)}"`);
			continue;
		}

		if (bounded.length > MAX_PROVIDER_TOOL_GUIDELINES_CHARS) {
			// Defensive: unreachable while MAX_PROVIDER_TOOL_GUIDELINE_CHARS <= MAX_PROVIDER_TOOL_GUIDELINES_CHARS
			// (a single guideline is already per-guideline-capped below the total budget), but guards
			// the invariant if those constants are ever changed. This is the one case where dropping
			// the guideline would erase it forever, so truncation to whatever remains is preferred —
			// except a bare "…" with zero real content, which is strictly worse than omitting it.
			const admitted = truncateWithEllipsis(bounded, remaining);
			if (admitted.length > 1) {
				unique.add(admitted);
				total += admitted.length;
				onBounded?.(
					`Provider tool guideline truncated to fit the ${MAX_PROVIDER_TOOL_GUIDELINES_CHARS}-char guidelines budget: "${bounded.slice(0, 48)}"`,
				);
			} else {
				onBounded?.(`Provider tool guideline dropped: guidelines budget exhausted: "${bounded.slice(0, 48)}"`);
			}
			continue;
		}

		if (bounded.length > remaining) {
			onBounded?.(`Provider tool guideline dropped: guidelines budget exhausted: "${bounded.slice(0, 48)}"`);
			continue;
		}

		unique.add(bounded);
		total += bounded.length;
	}
	return Array.from(unique);
}
