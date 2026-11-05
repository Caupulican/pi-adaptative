import type { FileHandle } from "node:fs/promises";
import { assertBoundedReadActive } from "./bounded-file.ts";

/** Complete a positioned transfer without treating a short read or write as completion. */
async function transferExactly(
	length: number,
	transfer: (offset: number, remaining: number) => Promise<number>,
	label: string,
	signal?: AbortSignal,
	allowEof = false,
	deadlineAt?: number,
): Promise<boolean> {
	let offset = 0;
	while (offset < length) {
		assertBoundedReadActive({ signal, deadlineAt });
		const transferred = await transfer(offset, length - offset);
		assertBoundedReadActive({ signal, deadlineAt });
		if (transferred === 0 && allowEof) return false;
		if (!Number.isSafeInteger(transferred) || transferred <= 0 || transferred > length - offset)
			throw new Error(`Incomplete positioned I/O: ${label}`);
		offset += transferred;
	}
	return true;
}

/** Fill the whole buffer; only an explicit allowEof returns false at actual EOF. Short reads always continue. */
export function readFileRangeInto(
	handle: FileHandle,
	buffer: Buffer,
	position: number,
	label: string,
	signal?: AbortSignal,
	allowEof = false,
	deadlineAt?: number,
): Promise<boolean> {
	return transferExactly(
		buffer.length,
		async (offset, remaining) => {
			const { bytesRead } = await handle.read(buffer, offset, remaining, position + offset);
			return bytesRead;
		},
		label,
		signal,
		allowEof,
		deadlineAt,
	);
}

export async function writeFileRangeFrom(
	handle: FileHandle,
	buffer: Buffer,
	position: number,
	label: string,
): Promise<void> {
	await transferExactly(
		buffer.length,
		async (offset, remaining) => {
			const { bytesWritten } = await handle.write(buffer, offset, remaining, position + offset);
			return bytesWritten;
		},
		label,
	);
}
