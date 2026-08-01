import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parentPort } from "node:worker_threads";
import {
	type FileEntry,
	getDefaultSessionDir,
	isAutoLearnSessionId,
	loadEntriesFromFile,
} from "@caupulican/pi-agent-core/node";
import { type TranscriptDoc, TranscriptIndex } from "../transcript-index.ts";
import {
	isTranscriptRecallWorkerRequest,
	TRANSCRIPT_RECALL_MAX_ERROR_CHARS,
	TRANSCRIPT_RECALL_MAX_HITS,
	TRANSCRIPT_RECALL_MAX_QUERY_CHARS,
	TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS,
	type TranscriptRecallWorkerResponse,
} from "./transcript-recall-worker-protocol.ts";

const MAX_SESSIONS = 60;
const MAX_DOC_CHARS = 8_000;
const MAX_TOTAL_CHARS = 500_000;
const MAX_FILE_BYTES = 8_000_000;
const port = parentPort;
if (!port) throw new Error("transcript recall worker requires parentPort");
const workerPort = port;

let generation = -1;
let index: TranscriptIndex | undefined;

function post(response: TranscriptRecallWorkerResponse): void {
	workerPort.postMessage(response);
}

workerPort.on("message", (value: unknown) => {
	if (!isTranscriptRecallWorkerRequest(value)) return;
	if (value.type === "shutdown") {
		post({ type: "stopped", generation: value.generation });
		workerPort.close();
		return;
	}
	if (value.type === "initialize") {
		generation = value.generation;
		try {
			index = new TranscriptIndex(buildDocs(value.sessionId, value.cwd, value.agentDir));
			post({ type: "ready", generation, size: index.size });
		} catch (error) {
			index = undefined;
			post({
				type: "failed",
				generation,
				error: (error instanceof Error ? error.message : String(error)).slice(0, TRANSCRIPT_RECALL_MAX_ERROR_CHARS),
			});
		}
		return;
	}

	if (value.generation !== generation) return;
	const hits =
		index?.query(value.query.slice(0, TRANSCRIPT_RECALL_MAX_QUERY_CHARS), {
			k: TRANSCRIPT_RECALL_MAX_HITS,
			minScore: 0.34,
			maxSnippetChars: TRANSCRIPT_RECALL_MAX_SNIPPET_CHARS,
		}) ?? [];
	post({ type: "result", generation, requestId: value.requestId, hits });
});

function buildDocs(currentSessionId: string, cwd: string, agentDir: string): TranscriptDoc[] {
	const docs: TranscriptDoc[] = [];
	let dir: string;
	try {
		dir = getDefaultSessionDir(cwd, agentDir);
	} catch {
		return docs;
	}

	let files: Array<{ path: string; mtime: number }>;
	try {
		files = readdirSync(dir)
			.filter((name) => name.endsWith(".jsonl"))
			.map((name) => {
				const path = join(dir, name);
				let mtime = 0;
				let size = 0;
				try {
					const metadata = statSync(path);
					mtime = metadata.mtimeMs;
					size = metadata.size;
				} catch {}
				return { path, mtime, size };
			})
			.filter((file) => file.size > 0 && file.size <= MAX_FILE_BYTES)
			.sort((left, right) => right.mtime - left.mtime)
			.slice(0, MAX_SESSIONS);
	} catch {
		return docs;
	}

	let total = 0;
	for (const { path } of files) {
		let entries: FileEntry[];
		try {
			entries = loadEntriesFromFile(path);
		} catch {
			continue;
		}
		const header = entries.find(
			(entry): entry is Extract<FileEntry, { type: "session" }> => entry.type === "session",
		);
		const sessionId = header?.id;
		if (!sessionId || sessionId === currentSessionId || isAutoLearnSessionId(sessionId)) continue;
		if (header.cwd && resolve(header.cwd) !== resolve(cwd)) continue;

		const text = extractSessionText(entries, MAX_DOC_CHARS);
		if (!text.trim()) continue;
		docs.push({
			sessionId: sessionId.slice(0, 256),
			timestamp: typeof header.timestamp === "string" ? header.timestamp.slice(0, 128) : undefined,
			text,
		});
		total += text.length;
		if (total >= MAX_TOTAL_CHARS) break;
	}
	return docs;
}

function extractSessionText(entries: FileEntry[], maxChars: number): string {
	const parts: string[] = [];
	let length = 0;
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (message.role !== "user" && message.role !== "assistant") continue;
		const content = message.content;
		let text = "";
		if (typeof content === "string") {
			text = content;
		} else if (Array.isArray(content)) {
			text = content
				.map((block) =>
					block && typeof block === "object" && "type" in block && block.type === "text" ? (block.text ?? "") : "",
				)
				.join(" ");
		}
		text = text.trim();
		if (!text || text.includes('<memory_context source="transcript-recall"')) continue;
		parts.push(text);
		length += text.length;
		if (length >= maxChars) break;
	}
	return parts.join("\n").slice(0, maxChars);
}
