/** Replace one provider emitted by generate-models.ts, preserving every other byte. */
export function replaceModelCatalogProvider(current: string, generated: string, provider: string): string {
	const [currentStart, currentEnd] = providerSection(current, provider);
	const [generatedStart, generatedEnd] = providerSection(generated, provider);
	return current.slice(0, currentStart) + generated.slice(generatedStart, generatedEnd) + current.slice(currentEnd);
}

function providerSection(catalog: string, provider: string): [number, number] {
	// Provider headers and terminators have one tab; nested models have two or more.
	// Use the generator's JSON key encoding so provider names cannot alter the marker.
	const marker = `\n\t${JSON.stringify(provider)}: {\n`;
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
