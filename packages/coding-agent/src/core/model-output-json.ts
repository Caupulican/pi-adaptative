/**
 * Recover one JSON object from the response shapes commonly produced by tool-less model calls.
 *
 * Work stays linear in the input size: there is no growing prefix, candidate array, or repeated
 * trimming. At most three bounded parse attempts are made (whole response, first fenced block,
 * then the span from the first opening brace to the last closing brace). Schema and trust checks
 * remain the caller's responsibility.
 */
export function parseModelOutputJsonObject(text: string): Record<string, unknown> | undefined {
	const whole = parseJsonObject(text);
	if (whole !== undefined) return whole ?? undefined;

	const fenceStart = text.indexOf("```");
	if (fenceStart >= 0) {
		let contentStart = fenceStart + 3;
		if (text.startsWith("json", contentStart)) contentStart += 4;
		const fenceEnd = text.indexOf("```", contentStart);
		if (fenceEnd > contentStart) {
			const fenced = parseJsonObject(text.slice(contentStart, fenceEnd));
			if (fenced !== undefined) return fenced ?? undefined;
		}
	}

	const objectStart = text.indexOf("{");
	const objectEnd = text.lastIndexOf("}");
	if (objectStart < 0 || objectEnd <= objectStart) return undefined;
	return parseJsonObject(text.slice(objectStart, objectEnd + 1)) ?? undefined;
}

/** `undefined` means invalid JSON; `null` means valid JSON with a non-object top level. */
function parseJsonObject(candidate: string): Record<string, unknown> | null | undefined {
	try {
		const parsed: unknown = JSON.parse(candidate);
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: null;
	} catch {
		return undefined;
	}
}
