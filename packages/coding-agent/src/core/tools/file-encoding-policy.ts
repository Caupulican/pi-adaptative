import { splitBom, stripBom } from "../../utils/text.ts";

/**
 * Offset of the first byte where strict UTF-8 decoding fails, or -1 when the buffer is well-formed.
 * The offset is the start of the offending sequence — the byte a reader has to look at — not the
 * continuation byte that revealed the problem. Overlong encodings, surrogate halves and
 * out-of-range code points all fail here, exactly as `TextDecoder` with `fatal: true` does.
 *
 * `allowIncompleteTail` is the streaming case: a sequence cut off by the end of a non-final chunk
 * continues in the next one and is not an error there.
 */
export function firstInvalidUtf8Offset(buffer: Buffer, options?: { allowIncompleteTail?: boolean }): number {
	let index = 0;
	while (index < buffer.length) {
		const lead = buffer[index];
		if (lead < 0x80) {
			index += 1;
			continue;
		}
		let length: number;
		let code: number;
		if (lead >= 0xc2 && lead <= 0xdf) {
			length = 2;
			code = lead & 0x1f;
		} else if (lead >= 0xe0 && lead <= 0xef) {
			length = 3;
			code = lead & 0x0f;
		} else if (lead >= 0xf0 && lead <= 0xf4) {
			length = 4;
			code = lead & 0x07;
		} else {
			return index;
		}
		const available = Math.min(length, buffer.length - index);
		for (let position = 1; position < available; position++) {
			const continuation = buffer[index + position];
			if ((continuation & 0xc0) !== 0x80) return index;
			code = (code << 6) | (continuation & 0x3f);
		}
		if (available < length) return options?.allowIncompleteTail ? -1 : index;
		if (length === 3 && (code < 0x800 || (code >= 0xd800 && code <= 0xdfff))) return index;
		if (length === 4 && (code < 0x10000 || code > 0x10ffff)) return index;
		index += length;
	}
	return -1;
}

/** Strict UTF-8 validation on a buffer. */
export function isValidUTF8(buffer: Buffer): boolean {
	return firstInvalidUtf8Offset(buffer) === -1;
}

/** The edit contract is UTF-8, not charset detection. Ambiguous NUL-bearing text may be BOM-less UTF-16. */
export function decodeUtf8ForEdit(buffer: Buffer, path: string): string {
	if (!isValidUTF8(buffer) || buffer.includes(0)) {
		throw new Error(
			`PI_FILE_ENCODING_CORRUPTION: ${path} contains invalid UTF-8 or NUL-bearing data; exact text replacement is unsafe. Use authorized encoding-aware recovery; no conversion was attempted.`,
		);
	}
	return buffer.toString("utf-8");
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
	const { bom, text: cleanExisting } = splitBom(existingContent);
	const hasBOM = bom.length > 0;
	const isCRLF = isConsistentlyCRLF(cleanExisting);

	// Strip BOM from newContent if it starts with one to avoid duplicates
	const cleanNewContent = stripBom(newContent);

	let finalContent = cleanNewContent;

	// Preserve dominant CRLF line endings if the newContent has only LF
	const hasNewCRLF = cleanNewContent.includes("\r\n");
	const hasNewLF = cleanNewContent.includes("\n");
	if (isCRLF && hasNewLF && !hasNewCRLF) {
		finalContent = cleanNewContent.replace(/\n/g, "\r\n");
	}

	// Preserve BOM
	if (hasBOM) {
		finalContent = `${bom}${finalContent}`;
	}

	return finalContent;
}

/**
 * Get the byte length of a string in UTF-8.
 */
export function utf8ByteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}
