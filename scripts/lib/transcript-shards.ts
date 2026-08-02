import { writeFileSync } from "node:fs";
import path from "node:path";

export interface TranscriptShard {
	name: string;
	chars: number;
	lines: number;
	oversized: boolean;
}

export interface TranscriptShardOptions {
	outputDir: string;
	maxChars: number;
	onWrite?: (shard: TranscriptShard) => void;
}

function countNewlines(text: string): number {
	let count = 0;
	for (let index = 0; index < text.length; index++) {
		if (text.charCodeAt(index) === 10) count++;
	}
	return count;
}

export function writeTranscriptShards(transcripts: Iterable<string>, options: TranscriptShardOptions): { files: TranscriptShard[]; transcripts: number } {
	if (!Number.isSafeInteger(options.maxChars) || options.maxChars <= 0) throw new TypeError("maxChars must be a positive safe integer");
	const files: TranscriptShard[] = [];
	const parts: string[] = [];
	let chars = 0;
	let newlines = 0;
	let transcriptCount = 0;
	let fileIndex = 0;

	const writeShard = (content: string, contentNewlines: number, oversized: boolean) => {
		const name = `session-transcripts-${String(fileIndex).padStart(3, "0")}.txt`;
		writeFileSync(path.join(options.outputDir, name), content);
		const shard = { name, chars: content.length, lines: content.length === 0 ? 0 : contentNewlines + 1, oversized };
		files.push(shard);
		options.onWrite?.(shard);
		fileIndex++;
	};
	const flush = () => {
		if (chars === 0) return;
		writeShard(parts.join(""), newlines, false);
		parts.length = 0;
		chars = 0;
		newlines = 0;
	};

	for (const transcript of transcripts) {
		transcriptCount++;
		const transcriptNewlines = countNewlines(transcript);
		if (transcript.length > options.maxChars) {
			flush();
			writeShard(transcript, transcriptNewlines, true);
			continue;
		}
		if (chars > 0 && chars + 2 + transcript.length > options.maxChars) flush();
		if (chars > 0) {
			parts.push("\n\n");
			chars += 2;
			newlines += 2;
		}
		parts.push(transcript);
		chars += transcript.length;
		newlines += transcriptNewlines;
	}
	flush();
	return { files, transcripts: transcriptCount };
}
