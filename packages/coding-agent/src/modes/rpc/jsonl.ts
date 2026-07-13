import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { StreamingLineDecoder } from "../../utils/streaming-lines.ts";

/**
 * Serialize a single strict JSONL record.
 *
 * Framing is LF-only. Payload strings may contain other Unicode separators such as
 * U+2028 and U+2029. Clients must split records on `\n` only.
 */
export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/**
 * Attach an LF-only JSONL reader to a stream.
 *
 * This intentionally does not use Node readline. Readline splits on additional
 * Unicode separators that are valid inside JSON strings and therefore does not
 * implement strict JSONL framing.
 */
// A non-compliant peer streaming without newlines would otherwise grow the
// line buffer without bound; one line can never legitimately exceed this.
const MAX_JSONL_LINE_CHARS = 64 * 1024 * 1024;

export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	const lines = new StreamingLineDecoder(MAX_JSONL_LINE_CHARS, { overflow: "skip", lineEndings: "lf" });

	const emitLine = (line: string) => {
		onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
	};

	const onData = (chunk: string | Buffer) => {
		for (const line of lines.push(typeof chunk === "string" ? chunk : decoder.write(chunk))) {
			emitLine(line);
		}
	};

	const onEnd = () => {
		for (const line of lines.push(decoder.end())) emitLine(line);
		const finalLine = lines.finish();
		if (finalLine !== undefined) emitLine(finalLine);
	};

	stream.on("data", onData);
	stream.on("end", onEnd);

	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
