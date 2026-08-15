export interface ShellOutputDecoder {
	decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}

const WINDOWS_1252_EXTENSION = [
	"\u20ac",
	"\u0081",
	"\u201a",
	"\u0192",
	"\u201e",
	"\u2026",
	"\u2020",
	"\u2021",
	"\u02c6",
	"\u2030",
	"\u0160",
	"\u2039",
	"\u0152",
	"\u008d",
	"\u017d",
	"\u008f",
	"\u0090",
	"\u2018",
	"\u2019",
	"\u201c",
	"\u201d",
	"\u2022",
	"\u2013",
	"\u2014",
	"\u02dc",
	"\u2122",
	"\u0161",
	"\u203a",
	"\u0153",
	"\u009d",
	"\u017e",
	"\u0178",
] as const;
const FATAL_UTF8_DECODER = new TextDecoder("utf8", { fatal: true });

function utf8SequenceLength(byte: number): number {
	if (byte >= 0xc2 && byte <= 0xdf) return 2;
	if (byte >= 0xe0 && byte <= 0xef) return 3;
	if (byte >= 0xf0 && byte <= 0xf4) return 4;
	return 0;
}

function isContinuation(byte: number): boolean {
	return byte >= 0x80 && byte <= 0xbf;
}

function isValidUtf8Sequence(bytes: Buffer, index: number, length: number): boolean {
	const first = bytes[index] ?? 0;
	const second = bytes[index + 1] ?? 0;
	if (!isContinuation(second)) return false;
	if (length === 2) return true;
	const third = bytes[index + 2] ?? 0;
	if (!isContinuation(third)) return false;
	if (first === 0xe0 && second < 0xa0) return false;
	if (first === 0xed && second > 0x9f) return false;
	if (length === 3) return true;
	const fourth = bytes[index + 3] ?? 0;
	if (!isContinuation(fourth)) return false;
	if (first === 0xf0 && second < 0x90) return false;
	if (first === 0xf4 && second > 0x8f) return false;
	return true;
}

function decodeWindows1252Byte(byte: number): string {
	if (byte >= 0x80 && byte <= 0x9f) return WINDOWS_1252_EXTENSION[byte - 0x80] ?? "\ufffd";
	return String.fromCodePoint(byte);
}

/**
 * Decode valid UTF-8 sequences while recovering isolated legacy Windows-1252 bytes. ASCII is
 * shared by both encodings, and at most three trailing bytes are retained across stream chunks.
 */
class WindowsCompatibleShellOutputDecoder implements ShellOutputDecoder {
	private pending = Buffer.alloc(0);

	decode(input: Uint8Array = Buffer.alloc(0), options: { stream?: boolean } = {}): string {
		const incoming = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
		const bytes = this.pending.length > 0 ? Buffer.concat([this.pending, incoming]) : incoming;
		this.pending = Buffer.alloc(0);
		if (bytes.length === 0) return "";
		try {
			return FATAL_UTF8_DECODER.decode(bytes);
		} catch {
			// Legacy bytes or a split trailing UTF-8 sequence need the compatibility scan below.
		}

		const decoded: string[] = [];
		let utf8Start = 0;
		let index = 0;
		const appendUtf8 = (end: number): void => {
			if (end > utf8Start) decoded.push(bytes.subarray(utf8Start, end).toString("utf8"));
		};

		while (index < bytes.length) {
			const byte = bytes[index] ?? 0;
			if (byte <= 0x7f) {
				index += 1;
				continue;
			}

			const sequenceLength = utf8SequenceLength(byte);
			if (sequenceLength > 0 && index + sequenceLength > bytes.length && options.stream === true) {
				appendUtf8(index);
				this.pending = Buffer.from(bytes.subarray(index));
				return decoded.join("");
			}
			if (
				sequenceLength > 0 &&
				index + sequenceLength <= bytes.length &&
				isValidUtf8Sequence(bytes, index, sequenceLength)
			) {
				index += sequenceLength;
				continue;
			}

			appendUtf8(index);
			decoded.push(decodeWindows1252Byte(byte));
			index += 1;
			utf8Start = index;
		}

		appendUtf8(bytes.length);
		return decoded.join("");
	}
}

export function createShellOutputDecoder(windowsCompatible = false): ShellOutputDecoder {
	return windowsCompatible ? new WindowsCompatibleShellOutputDecoder() : new TextDecoder();
}
