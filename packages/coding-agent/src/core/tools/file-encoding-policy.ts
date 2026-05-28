import { stripBom } from "./edit-diff.ts";

/**
 * Strict UTF-8 validation on a buffer.
 * TextDecoder with fatal: true throws an error on invalid UTF-8 sequences.
 */
export function isValidUTF8(buffer: Buffer): boolean {
	try {
		new TextDecoder("utf-8", { fatal: true }).decode(buffer);
		return true;
	} catch {
		return false;
	}
}

/**
 * Returns true if the file consistently uses CRLF.
 * Consistently means it contains at least one CRLF, and no LF without a preceding CR.
 */
export function isConsistentlyCRLF(text: string): boolean {
	const hasCRLF = text.includes("\r\n");
	if (!hasCRLF) {
		return false;
	}
	const withoutCRLF = text.replace(/\r\n/g, "");
	return !withoutCRLF.includes("\n");
}

/**
 * Preservation of BOM and line endings.
 */
export function applyEncodingPreservation(existingContent: string, newContent: string): string {
	const hasBOM = existingContent.startsWith("\uFEFF");
	const isCRLF = isConsistentlyCRLF(existingContent);

	// Strip BOM from newContent if it starts with one to avoid duplicates
	const { text: cleanNewContent } = stripBom(newContent);

	let finalContent = cleanNewContent;

	// Preserve dominant CRLF line endings if the newContent has only LF
	const hasNewCRLF = cleanNewContent.includes("\r\n");
	const hasNewLF = cleanNewContent.includes("\n");
	if (isCRLF && hasNewLF && !hasNewCRLF) {
		finalContent = cleanNewContent.replace(/\n/g, "\r\n");
	}

	// Preserve BOM
	if (hasBOM) {
		finalContent = `\uFEFF${finalContent}`;
	}

	return finalContent;
}

/**
 * Get the byte length of a string in UTF-8.
 */
export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}
