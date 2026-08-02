import { closeSync, openSync, writeFileSync } from "node:fs";

const MAX_JSONL_BATCH_CHARS = 256 * 1024;

/** Serialize a session JSONL iterable in bounded batches instead of materializing the full export. */
export function writeJsonLinesSync(filePath: string, values: Iterable<unknown>): void {
	const descriptor = openSync(filePath, "w");
	const chunks: string[] = [];
	let batchChars = 0;
	const flush = (): void => {
		if (chunks.length === 0) return;
		writeFileSync(descriptor, chunks.join(""), "utf8");
		chunks.length = 0;
		batchChars = 0;
	};

	try {
		for (const value of values) {
			const encoded = JSON.stringify(value);
			if (encoded === undefined) throw new TypeError("Session JSONL records must be JSON-serializable values.");
			const recordChars = encoded.length + 1;
			if (recordChars > MAX_JSONL_BATCH_CHARS) {
				flush();
				writeFileSync(descriptor, encoded, "utf8");
				writeFileSync(descriptor, "\n", "utf8");
				continue;
			}
			if (batchChars + recordChars > MAX_JSONL_BATCH_CHARS) flush();
			chunks.push(encoded, "\n");
			batchChars += recordChars;
		}
		flush();
	} finally {
		closeSync(descriptor);
	}
}
