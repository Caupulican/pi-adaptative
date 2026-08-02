export const DEFAULT_TEXT_PREVIEW_CHARS = 220;
const WHITESPACE_CHARACTER = /\s/;

/** Collapse whitespace and retain only the bounded prefix needed to render a preview. */
export function boundedTextPreview(text: string, maxChars = DEFAULT_TEXT_PREVIEW_CHARS): string {
	const limit = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : DEFAULT_TEXT_PREVIEW_CHARS;
	if (limit === 0) return "";

	const parts: string[] = [];
	let compactLength = 0;
	let pendingSpace = false;
	for (let index = 0; index < text.length; index++) {
		const character = text.charAt(index);
		if (WHITESPACE_CHARACTER.test(character)) {
			if (compactLength > 0) pendingSpace = true;
			continue;
		}

		if (pendingSpace) {
			parts.push(" ");
			compactLength++;
			if (compactLength > limit) break;
			pendingSpace = false;
		}

		parts.push(character);
		compactLength++;
		if (compactLength > limit) break;
	}

	const compact = parts.join("");
	return compactLength > limit ? `${compact.slice(0, limit - 1)}…` : compact;
}
