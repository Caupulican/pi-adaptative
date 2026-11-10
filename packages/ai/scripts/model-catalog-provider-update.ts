/**
 * Replace one provider emitted by generate-models.ts, preserving every other byte. A provider the committed catalog
 * does not list yet takes its place in the generator's provider order.
 */
export function replaceModelCatalogProvider(current: string, generated: string, provider: string): string {
	const [generatedStart, generatedEnd] = providerSection(generated, provider);
	const section = generated.slice(generatedStart, generatedEnd);
	if (current.includes(providerMarker(provider))) {
		const [currentStart, currentEnd] = providerSection(current, provider);
		return current.slice(0, currentStart) + section + current.slice(currentEnd);
	}
	// A section runs from the line break before its header through the one after its terminator; the break at the
	// insertion point already ends the new section.
	const at = insertionPoint(current, provider);
	return current.slice(0, at) + section.slice(0, -1) + current.slice(at);
}

// Provider headers and terminators have one tab; nested models have two or more.
// Use the generator's JSON key encoding so provider names cannot alter the marker.
function providerMarker(provider: string): string {
	return `\n\t${JSON.stringify(provider)}: {\n`;
}

function providerSection(catalog: string, provider: string): [number, number] {
	const marker = providerMarker(provider);
	const start = catalog.indexOf(marker);
	if (start < 0) throw new Error(`Missing catalog provider: ${provider}`);
	if (catalog.indexOf(marker, start + marker.length) >= 0) throw new Error(`Duplicate catalog provider: ${provider}`);
	const endMarker = "\n\t},\n";
	const end = catalog.indexOf(endMarker, start + marker.length);
	const nextProvider = catalog.indexOf('\n\t"', start + marker.length);
	if (end < 0 || (nextProvider >= 0 && nextProvider < end)) {
		throw new Error(`Unterminated catalog provider: ${provider}`);
	}
	return [start, end + endMarker.length];
}

/** Where a new provider's section goes: before the first provider that sorts after it, else before the closing brace. */
function insertionPoint(catalog: string, provider: string): number {
	for (const header of catalog.matchAll(/\n\t("(?:[^"\\]|\\.)*"): \{\n/g)) {
		// The generator orders providers by plain string comparison.
		if ((JSON.parse(header[1]) as string) > provider) return header.index;
	}
	const close = catalog.lastIndexOf("\n};\n");
	if (close < 0) throw new Error("Unterminated model catalog");
	return close;
}
