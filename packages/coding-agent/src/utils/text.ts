/**
 * Text and encoding utilities.
 */

/**
 * Split a UTF-8 Byte Order Mark (BOM) from content if present.
 */
export function splitBom(content: string): { bom: string; text: string } {
	return content.startsWith("\uFEFF") ? { bom: "\uFEFF", text: content.slice(1) } : { bom: "", text: content };
}

/**
 * Strip a UTF-8 Byte Order Mark (BOM) from content if present.
 */
export function stripBom(content: string): string {
	return content.startsWith("\uFEFF") ? content.slice(1) : content;
}
