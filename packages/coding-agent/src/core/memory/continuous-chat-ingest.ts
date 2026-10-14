/**
 * Canonical ingestion: committed session entries, imported legacy entries and worker terminal reports become chat
 * records. The mapping is pure and shared with the worker log and the legacy import. The ingestor owns order,
 * idempotence and the "everything announced so far is logged" barrier, and it is the only path that appends session
 * content to the chat.
 */

import type { ImageContent, TextContent } from "@caupulican/pi-ai";
import type { AgentMessage } from "../../kernel/index.ts";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { SessionEntriesPersistedEvent } from "../../kernel/session/session-manager.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import type {
	ContinuousChatAppendInput,
	ContinuousChatImageInput,
	ContinuousChatMessageKind,
} from "./continuous-chat-contracts.ts";
import { parseContinuousChatNavigationCommand } from "./continuous-chat-navigation.ts";
import type { ContinuousChatRuntime } from "./continuous-chat-runtime.ts";
import { CONTINUOUS_CHAT_MAX_BULK_INPUTS } from "./continuous-chat-store.ts";

/** One loggable piece of a session message. `part` is the raw content-block index, stable across thinking blocks. */
export interface ContinuousChatMessagePart {
	part: number;
	kind: Exclude<ContinuousChatMessageKind, "note">;
	text: string;
	images?: ContinuousChatImageInput[];
	/** Explicit idempotency identity for durable derived entries such as worker terminals. */
	sourceKey?: string;
	/** Exact occurrence time when it differs from the containing session entry's persistence time. */
	date?: string;
}

export const CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE = "continuous_chat_work_report";

export interface ContinuousChatWorkReportEntry {
	version: 1;
	name: string;
	claimId: string;
	text: string;
	timestamp: number;
}

function workReportEntry(value: unknown): ContinuousChatWorkReportEntry | undefined {
	if (!isPlainRecord(value) || value.version !== 1) return undefined;
	if (
		typeof value.name !== "string" ||
		typeof value.claimId !== "string" ||
		typeof value.text !== "string" ||
		typeof value.timestamp !== "number" ||
		!Number.isFinite(value.timestamp) ||
		Number.isNaN(new Date(value.timestamp).getTime())
	) {
		return undefined;
	}
	if ("status" in parseContinuousChatNavigationCommand("zoom", { id: value.name, page: 0 })) return undefined;
	return { version: 1, name: value.name, claimId: value.claimId, text: value.text, timestamp: value.timestamp };
}

type ContentBlock = TextContent | ImageContent;

function blockText(blocks: readonly ContentBlock[]): string {
	return blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function blockImages(blocks: readonly ContentBlock[]): ContinuousChatImageInput[] {
	return blocks.flatMap((block) => (block.type === "image" ? [{ mimeType: block.mimeType, data: block.data }] : []));
}

/** A whole message as one part: its text lines and its images. An empty message has no part. */
function wholeMessagePart(
	kind: ContinuousChatMessagePart["kind"],
	content: string | readonly ContentBlock[],
): ContinuousChatMessagePart[] {
	const text = typeof content === "string" ? content : blockText(content);
	const images = typeof content === "string" ? [] : blockImages(content);
	if (text.length === 0 && images.length === 0) return [];
	return [{ part: 0, kind, text, ...(images.length > 0 ? { images } : {}) }];
}

/**
 * The chat parts of one message: user text, assistant text (one part per text block), tool calls (name, newline,
 * JSON input) and tool results. Thinking, custom and summary messages are not conversation turns and are not logged.
 * Every tool result is an echo, history reads included: each session entry is logged once under its own source key,
 * so no entry reaches the chat twice.
 */
export function continuousChatMessageParts(message: AgentMessage): ContinuousChatMessagePart[] {
	switch (message.role) {
		case "user":
			return wholeMessagePart("user", message.content);
		case "assistant": {
			const parts: ContinuousChatMessagePart[] = [];
			message.content.forEach((block, index) => {
				if (block.type === "text" && block.text.length > 0) {
					parts.push({ part: index, kind: "pi", text: block.text });
				} else if (block.type === "toolCall") {
					parts.push({ part: index, kind: "tool", text: `${block.name}\n${JSON.stringify(block.arguments)}` });
				}
			});
			return parts;
		}
		case "toolResult":
			return wholeMessagePart("echo", message.content);
		default:
			// Custom messages, committed transient records among them, bash runs and summaries are never chat turns.
			return [];
	}
}

/**
 * The chat parts of a session entry. Only the harness's own synthetic failure messages (origin `local`, written by the
 * agent loop and the agent when a run fails or aborts) are skipped. Every other message is logged, whatever it carries.
 */
export function continuousChatEntryParts(entry: SessionEntry): ContinuousChatMessagePart[] {
	if (entry.type === "message") return entry.origin !== "local" ? continuousChatMessageParts(entry.message) : [];
	if (entry.type !== "custom" || entry.customType !== CONTINUOUS_CHAT_WORK_REPORT_CUSTOM_TYPE) return [];
	const report = workReportEntry(entry.data);
	if (report === undefined) return [];
	return [
		{
			part: 0,
			kind: "work",
			text: `[${report.name}] ${report.text}`,
			sourceKey: `work:${report.claimId}`,
			date: new Date(report.timestamp).toISOString(),
		},
	];
}

export interface ContinuousChatIngestorDeps {
	appender: Pick<ContinuousChatRuntime, "append" | "appendMany">;
	/** The entry of an announced persistence; the ingestor never reads the session file itself. */
	readEntry(entryId: string): SessionEntry | undefined;
	warn(message: string): void;
}

/** One record to log, with its exact occurrence timestamp. Segment chronology is a store concern. */
type ChatRecord = Omit<ContinuousChatAppendInput, "date"> & { timestamp: string };

type IngestTask = { kind: "entry"; sessionId: string; entryId: string };

export class ContinuousChatIngestor {
	private readonly deps: ContinuousChatIngestorDeps;
	/** Announced work in arrival order. The head stays until it is logged, so a failure never drops an event. */
	private readonly queue: IngestTask[] = [];
	/** Passes run one at a time. Each pass works from the head until the queue is empty or the head fails. */
	private tail: Promise<void> = Promise.resolve();
	/** Set by a failed head, cleared when the head is logged. Every `settled()` rejects with it while it is set. */
	private failure: Error | undefined;
	private closed = false;

	constructor(deps: ContinuousChatIngestorDeps) {
		this.deps = deps;
	}

	/** Announcements of durable session writes. Each entry is logged once, in announcement order. */
	notifyEntriesPersisted(event: SessionEntriesPersistedEvent): void {
		this.ingestEntries(event.sessionId, event.entryIds);
	}

	/** Entries of one session, each logged once. Live announcements and the restart catch-up share this path. */
	ingestEntries(sessionId: string, entryIds: readonly string[]): void {
		if (this.closed) return;
		for (const entryId of entryIds) this.queue.push({ kind: "entry", sessionId, entryId });
		void this.schedule();
	}

	/** The entries of one earlier session, streamed into bounded bulk appends in file order. */
	async importLegacySession(sessionId: string, entries: AsyncIterable<SessionEntry>): Promise<void> {
		// Refused, never skipped: a silent return would let the import mark itself complete without these entries.
		if (this.closed) throw new Error("Continuous-chat ingestion is closed; the legacy import cannot run.");
		await this.logSessionEntries(sessionId, entries, false);
	}

	/**
	 * Recovers an earlier unsettled ICM session in bounded bulk calls, preserving canonical message kinds,
	 * occurrence timestamps, and source keys (including `work:<claimId>`).
	 */
	importCanonicalSession(sessionId: string, entries: AsyncIterable<SessionEntry>): Promise<void> {
		if (this.closed) {
			return Promise.reject(new Error("Continuous-chat ingestion is closed; cannot recover session entries."));
		}
		const run = this.tail.then(() => this.logSessionEntries(sessionId, entries, true));
		this.tail = run.catch(() => undefined);
		return run;
	}

	/** Retries the head now and resolves once the queue is empty. Rejects with the failure while one is outstanding. */
	async flush(): Promise<void> {
		await this.schedule();
		this.throwFailure();
	}

	/** Resolves once the queue is empty. Rejects with the stored failure while one is outstanding; never retries. */
	async settled(): Promise<void> {
		await this.idle();
		this.throwFailure();
	}

	/** Stops accepting announcements. Records already queued still run; see `idle`. */
	dispose(): void {
		this.closed = true;
	}

	/** Waits until no pass is running or scheduled. Never rejects: a failed head is left queued and reported. */
	async idle(): Promise<void> {
		let tail: Promise<void>;
		do {
			tail = this.tail;
			await tail;
		} while (tail !== this.tail);
	}

	private throwFailure(): void {
		if (this.failure !== undefined) throw this.failure;
	}

	/** Queues one pass after the running ones. Each pass retries the head, so every later call is also a retry. */
	private schedule(): Promise<void> {
		this.tail = this.tail.then(() => this.pass());
		return this.tail;
	}

	private async pass(): Promise<void> {
		for (let task = this.queue[0]; task !== undefined; task = this.queue[0]) {
			try {
				await this.perform(task);
			} catch (error) {
				const failure = error instanceof Error ? error : new Error(String(error));
				// Each retry of the same failure is silent: only a new cause is reported.
				if (this.failure?.message !== failure.message) {
					this.deps.warn(`Continuous chat ingestion is waiting to retry: ${failure.message}`);
				}
				this.failure = failure;
				return;
			}
			this.failure = undefined;
			this.queue.shift();
		}
	}

	private async perform(task: IngestTask): Promise<void> {
		return this.logEntry(task.sessionId, task.entryId);
	}

	private async logEntry(sessionId: string, entryId: string): Promise<void> {
		const entry = this.deps.readEntry(entryId);
		if (entry === undefined) throw new Error(`Persisted session entry ${entryId} is not readable.`);
		for (const piece of continuousChatEntryParts(entry)) {
			await this.appendRecord({
				kind: piece.kind,
				timestamp: piece.date ?? entry.timestamp,
				text: piece.text,
				...(piece.images ? { images: piece.images } : {}),
				sourceKey: piece.sourceKey ?? `${sessionId}:${entryId}:${piece.part}`,
				source: { sessionId, entryId },
			});
		}
	}

	/**
	 * Streams an earlier session in bounded bulk calls: the chat never holds more than one batch of the session at a
	 * time. Legacy sessions wrap conversational parts as `note` records while preserving canonical `work` reports;
	 * recovered ICM sessions keep all canonical message kinds. Every unit is deduplicated by its own source key.
	 */
	private async logSessionEntries(
		sessionId: string,
		entries: AsyncIterable<SessionEntry>,
		canonical: boolean,
	): Promise<void> {
		const maxLegacyParts = 32;
		let batch: ContinuousChatAppendInput[] = [];
		for await (const entry of entries) {
			for (const piece of continuousChatEntryParts(entry)) {
				if (!canonical && piece.kind === "echo") continue;
				batch.push({
					kind: canonical ? piece.kind : "note",
					date: canonical ? (piece.date ?? entry.timestamp) : entry.timestamp,
					text: canonical ? piece.text : `${piece.kind}: ${piece.text}`,
					...(piece.images ? { images: piece.images } : {}),
					sourceKey: canonical
						? (piece.sourceKey ?? `${sessionId}:${entry.id}:${piece.part}`)
						: `${sessionId}:${entry.id}:${piece.part}`,
					source: { sessionId, entryId: entry.id },
				});
				if (canonical && batch.length === CONTINUOUS_CHAT_MAX_BULK_INPUTS) {
					await this.deps.appender.appendMany(batch);
					batch = [];
				} else if (!canonical && batch.length > maxLegacyParts * 2) {
					batch = batch.slice(-maxLegacyParts);
				}
			}
		}
		if (!canonical && batch.length > maxLegacyParts) {
			batch = batch.slice(-maxLegacyParts);
		}
		if (batch.length > 0) await this.deps.appender.appendMany(batch);
	}

	/**
	 * The whole append command goes to the runtime, never a pre-check of one unit: the store deduplicates each unit by
	 * its own source key, so a crash that committed some units of a long text still completes the rest on replay.
	 */
	private async appendRecord(record: ChatRecord): Promise<void> {
		const { timestamp, ...fields } = record;
		await this.deps.appender.append({ ...fields, date: timestamp });
	}
}
