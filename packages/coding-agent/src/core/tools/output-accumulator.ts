import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, type TruncationResult } from "./truncate.ts";

export interface OutputAccumulatorOptions {
	maxLines?: number;
	maxBytes?: number;
	tempFilePrefix?: string;
}

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
	fullOutputError?: string;
}

export interface OutputPreview {
	content: string;
	skippedLines: number;
}

function defaultTempFilePath(prefix: string): string {
	const id = randomBytes(8).toString("hex");
	return join(tmpdir(), `${prefix}-${id}.log`);
}

const MAX_APPEND_CHUNK_BYTES = 64 * 1024;

function byteLength(text: string): number {
	return Buffer.byteLength(text, "utf-8");
}

function formatIoError(error: unknown): string {
	if (error instanceof Error) {
		const code = (error as NodeJS.ErrnoException).code;
		return code ? `${code}: ${error.message}` : error.message;
	}
	return String(error);
}

function tailUtf8String(text: string, maxBytes: number): { text: string; bytes: number } {
	if (maxBytes <= 0 || text.length === 0) {
		return { text: "", bytes: 0 };
	}

	const buffer = Buffer.from(text, "utf-8");
	if (buffer.length <= maxBytes) {
		return { text, bytes: buffer.length };
	}

	let start = buffer.length - maxBytes;
	while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) {
		start++;
	}

	const result = buffer.subarray(start).toString("utf-8");
	return { text: result, bytes: byteLength(result) };
}

/**
 * Incrementally tracks streaming output with bounded memory.
 *
 * Appends decode chunks with a streaming UTF-8 decoder, keeps a bounded tail of
 * logical lines, and opens a temp file when the full output needs preserving.
 * Snapshot and preview work is bounded by configured output limits, never by
 * total command history.
 */
export class OutputAccumulator {
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly tempFilePrefix: string;
	private readonly decoder = new TextDecoder();

	private rawChunks: Buffer[] = [];
	private tailLines: string[] = [];
	private tailLineBytes: number[] = [];
	private tailLineStoredBytes: number[] = [];
	private tailStart = 0;
	private tailStoredBytes = 0;
	private currentLineText = "";
	private currentLineBytes = 0;
	private currentLineStoredBytes = 0;
	private lastCompletedLineBytes = 0;
	private totalRawBytes = 0;
	private totalDecodedBytes = 0;
	private completedLines = 0;
	private totalLines = 0;
	private hasOpenLine = false;
	private finished = false;

	private tempFilePath: string | undefined;
	private tempFileFd: number | undefined;
	private tempFileError: string | undefined;

	constructor(options: OutputAccumulatorOptions = {}) {
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.tempFilePrefix = options.tempFilePrefix ?? "pi-output";
	}

	append(data: Buffer): void {
		if (this.finished) {
			throw new Error("Cannot append to a finished output accumulator");
		}

		for (let offset = 0; offset < data.length; offset += MAX_APPEND_CHUNK_BYTES) {
			this.appendBlock(data.subarray(offset, offset + MAX_APPEND_CHUNK_BYTES));
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		this.appendDecodedText(this.decoder.decode());
		if (this.shouldUseTempFile()) {
			this.tryEnsureTempFile();
		}
	}

	snapshot(options: { persistIfTruncated?: boolean } = {}): OutputSnapshot {
		const snapshot = this.buildSnapshot(this.maxLines, this.maxBytes);

		if (options.persistIfTruncated && snapshot.truncation.truncated) {
			this.tryEnsureTempFile();
		}

		return {
			...snapshot,
			fullOutputPath: this.fullOutputPath(),
			fullOutputError: this.tempFileError,
		};
	}

	preview(maxLines: number, maxBytes = this.maxBytes): OutputPreview {
		const snapshot = this.previewSnapshot(maxLines, maxBytes);
		return {
			content: snapshot.content,
			skippedLines: Math.max(0, this.totalLines - snapshot.truncation.outputLines),
		};
	}

	previewSnapshot(
		maxLines: number,
		maxBytes = this.maxBytes,
		options: { persistIfFullTruncated?: boolean } = {},
	): OutputSnapshot {
		const snapshot = this.buildSnapshot(maxLines, maxBytes);
		if (options.persistIfFullTruncated && this.shouldUseTempFile()) {
			this.tryEnsureTempFile();
		}
		return {
			...snapshot,
			fullOutputPath: this.fullOutputPath(),
			fullOutputError: this.tempFileError,
		};
	}

	async closeTempFile(): Promise<void> {
		const fd = this.tempFileFd;
		if (fd === undefined) {
			return;
		}
		this.tempFileFd = undefined;
		try {
			closeSync(fd);
		} catch (error) {
			this.tempFileError ??= formatIoError(error);
		}
	}

	getLastLineBytes(): number {
		return this.hasOpenLine ? this.currentLineBytes : this.lastCompletedLineBytes;
	}

	private appendBlock(data: Buffer): void {
		this.totalRawBytes += data.length;
		this.appendDecodedText(this.decoder.decode(data, { stream: true }));

		if (this.tempFileFd !== undefined || this.shouldUseTempFile()) {
			if (this.tryEnsureTempFile() && this.tempFileFd !== undefined) {
				try {
					writeSync(this.tempFileFd, data);
				} catch (error) {
					this.recordTempFileError(error);
				}
			}
		} else if (data.length > 0) {
			// Copy retained chunks: Buffer.subarray would pin a large caller buffer in memory.
			this.rawChunks.push(Buffer.from(data));
		}
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}

		this.totalDecodedBytes += byteLength(text);

		let segmentStart = 0;
		for (
			let newlineIndex = text.indexOf("\n");
			newlineIndex !== -1;
			newlineIndex = text.indexOf("\n", segmentStart)
		) {
			this.appendToCurrentLine(text.slice(segmentStart, newlineIndex));
			this.pushCompletedCurrentLine();
			segmentStart = newlineIndex + 1;
		}

		if (segmentStart < text.length) {
			this.appendToCurrentLine(text.slice(segmentStart));
		}

		this.totalLines = this.completedLines + (this.hasOpenLine ? 1 : 0);
	}

	private appendToCurrentLine(segment: string): void {
		if (segment.length === 0) {
			return;
		}

		const segmentBytes = byteLength(segment);
		this.currentLineBytes += segmentBytes;
		this.hasOpenLine = true;

		if (segmentBytes >= this.maxBytes) {
			const tail = tailUtf8String(segment, this.maxBytes);
			this.currentLineText = tail.text;
			this.currentLineStoredBytes = tail.bytes;
			return;
		}

		this.currentLineText += segment;
		this.currentLineStoredBytes += segmentBytes;
		if (this.currentLineStoredBytes > this.maxBytes) {
			const tail = tailUtf8String(this.currentLineText, this.maxBytes);
			this.currentLineText = tail.text;
			this.currentLineStoredBytes = tail.bytes;
		}
	}

	private pushCompletedCurrentLine(): void {
		this.completedLines++;
		this.lastCompletedLineBytes = this.currentLineBytes;
		this.tailLines.push(this.currentLineText);
		this.tailLineBytes.push(this.currentLineBytes);
		this.tailLineStoredBytes.push(this.currentLineStoredBytes);
		this.tailStoredBytes += this.currentLineStoredBytes;
		this.currentLineText = "";
		this.currentLineBytes = 0;
		this.currentLineStoredBytes = 0;
		this.hasOpenLine = false;
		this.trimStoredTail();
	}

	private trimStoredTail(): void {
		while (this.completedTailLineCount() > this.maxLines || this.tailStoredBytes > this.maxBytes) {
			this.tailStoredBytes -= this.tailLineStoredBytes[this.tailStart] ?? 0;
			this.tailStart++;
		}

		if (this.tailStart > 1024 && this.tailStart * 2 > this.tailLines.length) {
			this.tailLines = this.tailLines.slice(this.tailStart);
			this.tailLineBytes = this.tailLineBytes.slice(this.tailStart);
			this.tailLineStoredBytes = this.tailLineStoredBytes.slice(this.tailStart);
			this.tailStart = 0;
		}
	}

	private completedTailLineCount(): number {
		return this.tailLines.length - this.tailStart;
	}

	private buildSnapshot(maxLines: number, maxBytes: number): OutputSnapshot {
		const truncated = this.totalLines > maxLines || this.totalDecodedBytes > maxBytes;
		const outputLines: string[] = [];
		let outputBytes = 0;
		let outputLineCount = 0;
		let truncatedBy: "lines" | "bytes" = this.totalLines > maxLines ? "lines" : "bytes";
		let lastLinePartial = false;
		let readCurrent = this.hasOpenLine;
		let completedIndex = this.tailLines.length - 1;

		while (outputLineCount < maxLines) {
			let line: string;
			let lineBytes: number;
			let storedBytes: number;
			if (readCurrent) {
				line = this.currentLineText;
				lineBytes = this.currentLineBytes;
				storedBytes = this.currentLineStoredBytes;
				readCurrent = false;
			} else {
				if (completedIndex < this.tailStart) break;
				line = this.tailLines[completedIndex] ?? "";
				lineBytes = this.tailLineBytes[completedIndex] ?? 0;
				storedBytes = this.tailLineStoredBytes[completedIndex] ?? 0;
				completedIndex--;
			}

			const separatorBytes = outputLineCount > 0 ? 1 : 0;
			const fullLineBytes = lineBytes + separatorBytes;
			if (outputBytes + fullLineBytes > maxBytes) {
				truncatedBy = "bytes";
				if (outputLineCount === 0) {
					const partial =
						lineBytes > maxBytes ? tailUtf8String(line, maxBytes) : { text: line, bytes: storedBytes };
					outputLines.unshift(partial.text);
					outputBytes = partial.bytes;
					outputLineCount = 1;
					lastLinePartial = lineBytes > partial.bytes;
				}
				break;
			}

			outputLines.unshift(line);
			outputBytes += storedBytes + separatorBytes;
			outputLineCount++;
		}

		let content = outputLines.join("\n");
		if (!truncated && !this.hasOpenLine && this.totalLines > 0) {
			content += "\n";
			outputBytes += 1;
		}

		const effectiveTruncatedBy = truncated ? truncatedBy : null;
		const truncation: TruncationResult = {
			content,
			truncated,
			truncatedBy: effectiveTruncatedBy,
			totalLines: this.totalLines,
			totalBytes: this.totalDecodedBytes,
			outputLines: outputLineCount,
			outputBytes,
			lastLinePartial,
			firstLineExceedsLimit: false,
			maxLines,
			maxBytes,
		};

		return {
			content,
			truncation,
			fullOutputPath: this.fullOutputPath(),
			fullOutputError: this.tempFileError,
		};
	}

	private shouldUseTempFile(): boolean {
		return (
			this.totalRawBytes > this.maxBytes || this.totalDecodedBytes > this.maxBytes || this.totalLines > this.maxLines
		);
	}

	private fullOutputPath(): string | undefined {
		return this.tempFileError === undefined ? this.tempFilePath : undefined;
	}

	private tryEnsureTempFile(): boolean {
		if (this.tempFileError !== undefined) {
			return false;
		}
		if (this.tempFileFd !== undefined) {
			return true;
		}
		try {
			this.tempFilePath ??= defaultTempFilePath(this.tempFilePrefix);
			this.tempFileFd = openSync(this.tempFilePath, "w");
			for (const chunk of this.rawChunks) {
				writeSync(this.tempFileFd, chunk);
			}
			this.rawChunks = [];
			return true;
		} catch (error) {
			this.recordTempFileError(error);
			return false;
		}
	}

	private recordTempFileError(error: unknown): void {
		this.tempFileError ??= formatIoError(error);
		const fd = this.tempFileFd;
		this.tempFileFd = undefined;
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch (closeError) {
				this.tempFileError += `; close failed: ${formatIoError(closeError)}`;
			}
		}
	}
}
