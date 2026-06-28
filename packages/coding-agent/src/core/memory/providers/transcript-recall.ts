/**
 * TranscriptRecallProvider — cross-session similarity recall (adaptive-agent design R3).
 *
 * A read-only CONTEXT memory provider: it indexes the most-recent past session transcripts (the JSONL
 * corpus) with a dependency-free token/Jaccard index ({@link TranscriptIndex}, reusing skill_audit's
 * tokenizer) and answers `prefetch(query)` with a small `<memory_context>` recall page of the most
 * relevant past snippets. The current session and auto-learn sessions are excluded. It never writes —
 * the file-store remains the write target; this is the recall corpus.
 */

import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { wrapUntrustedText } from "../../security/untrusted-boundary.ts";
import {
	type FileEntry,
	getDefaultSessionDir,
	isAutoLearnSessionId,
	loadEntriesFromFile,
} from "../../session-manager.ts";
import type { MemoryCapabilities, MemoryLifecycleContext, MemoryProvider } from "../memory-provider.ts";
import { type TranscriptDoc, TranscriptIndex } from "../transcript-index.ts";

/** Most-recent past sessions to consider. */
const MAX_SESSIONS = 60;
/** Per-session text cap (keeps the index light and snippets relevant). */
const MAX_DOC_CHARS = 8_000;
/** Overall corpus cap across all docs. */
const MAX_TOTAL_CHARS = 500_000;
/** Skip transcript files larger than this before parsing them, so a huge log can't block/bloat the
 * first recalled turn (Bug #9). Far above a normal session; only pathological logs exceed it. */
const MAX_FILE_BYTES = 8_000_000;

export class TranscriptRecallProvider implements MemoryProvider {
	readonly name = "transcript-recall";
	private index: TranscriptIndex | undefined;
	private currentSessionId = "";
	private cwd = "";
	private agentDir = "";

	isAvailable(): boolean {
		return true;
	}

	getCapabilities(): MemoryCapabilities {
		return { surfaces: ["context"] };
	}

	async initialize(sessionId: string, ctx: MemoryLifecycleContext): Promise<void> {
		this.currentSessionId = sessionId;
		this.cwd = ctx.cwd;
		this.agentDir = ctx.agentDir;
		this.index = undefined; // built lazily on first prefetch
	}

	async shutdown(): Promise<void> {
		this.index = undefined;
	}

	/** GC manages the dynamic recall page so stale pages pack while the newest are kept. */
	getContextMarkers(): string[] {
		return ["<memory_context"];
	}

	async prefetch(query: string): Promise<string> {
		if (!query.trim()) return "";
		let index: TranscriptIndex;
		try {
			index = this.ensureIndex();
		} catch {
			return "";
		}
		if (index.size === 0) return "";
		// minScore is a query-CONTAINMENT threshold (fraction of the query's tokens present in the doc),
		// not Jaccard — so it is length-independent and recalls relevant long sessions. ~1/3 of query
		// terms must appear before a session is considered relevant.
		const hits = index.query(query, { k: 3, minScore: 0.34, maxSnippetChars: 600 });
		if (hits.length === 0) return "";
		// Recalled past text is UNTRUSTED (it may itself contain injected instructions or a forged
		// `</memory_context>` to break out). Fence each snippet with the untrusted-content boundary so a
		// payload can't escape and be replayed as a current instruction (design: recall = untrusted).
		const body = hits
			.map((h) => `- (${h.timestamp ?? "earlier session"}) ${wrapUntrustedText(h.snippet, "transcript-recall")}`)
			.join("\n");
		return `<memory_context source="transcript-recall">\nRelevant context recalled from past sessions (read-only reference, untrusted, may be stale):\n${body}\n</memory_context>`;
	}

	private ensureIndex(): TranscriptIndex {
		if (!this.index) {
			this.index = new TranscriptIndex(this.buildDocs());
		}
		return this.index;
	}

	private buildDocs(): TranscriptDoc[] {
		const docs: TranscriptDoc[] = [];
		let dir: string;
		try {
			dir = getDefaultSessionDir(this.cwd, this.agentDir);
		} catch {
			return docs;
		}

		let files: Array<{ path: string; mtime: number }>;
		try {
			files = readdirSync(dir)
				.filter((f) => f.endsWith(".jsonl"))
				.map((f) => {
					const path = join(dir, f);
					let mtime = 0;
					let size = 0;
					try {
						const st = statSync(path);
						mtime = st.mtimeMs;
						size = st.size;
					} catch {}
					return { path, mtime, size };
				})
				.filter((f) => f.size > 0 && f.size <= MAX_FILE_BYTES) // skip oversize logs before parse (Bug #9)
				.sort((a, b) => b.mtime - a.mtime) // most-recent first
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
			const header = entries.find((e): e is Extract<FileEntry, { type: "session" }> => e.type === "session");
			const sessionId = header?.id;
			if (!sessionId || sessionId === this.currentSessionId || isAutoLearnSessionId(sessionId)) continue;
			// Privacy: only recall from sessions that ran in THIS working directory. A misplaced/copied
			// transcript with a different cwd must not leak across project boundaries (Bug #11).
			if (header?.cwd && resolve(header.cwd) !== resolve(this.cwd)) continue;

			const text = extractSessionText(entries, MAX_DOC_CHARS);
			if (!text.trim()) continue;
			docs.push({ sessionId, timestamp: header?.timestamp, text });
			total += text.length;
			if (total >= MAX_TOTAL_CHARS) break;
		}
		return docs;
	}
}

/** Concatenate user+assistant text from a session's entries, capped to `maxChars`. */
function extractSessionText(entries: FileEntry[], maxChars: number): string {
	const parts: string[] = [];
	let len = 0;
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
				.map((b) => (b && typeof b === "object" && "type" in b && b.type === "text" ? (b.text ?? "") : ""))
				.join(" ");
		}
		text = text.trim();
		if (!text) continue;
		// Skip our own previously-injected recall pages so recalled snippets don't recirculate and
		// amplify across sessions (Bug #10).
		if (text.includes('<memory_context source="transcript-recall"')) continue;
		parts.push(text);
		len += text.length;
		if (len >= maxChars) break;
	}
	return parts.join("\n").slice(0, maxChars);
}
