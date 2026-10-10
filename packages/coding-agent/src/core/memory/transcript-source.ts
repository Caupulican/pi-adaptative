/**
 * Pure capture of canonical session entries into source-linked spans. No filesystem, worker or
 * provider access: callers feed entries and receive bounded spans that name their exact canonical
 * source (session, entry, part, digest).
 *
 * Lineage comes from entry ancestry, never from physical order: the selected lineage is the ancestry
 * of the session's last entry, every other captured entry is `alternate`.
 */

import { createHash, type Hash } from "node:crypto";
import type { SessionEntry } from "../../kernel/session/session-entries.ts";
import type { FileEntry } from "../../kernel/session/session-manager.ts";
import { collectSessionBranch } from "../../kernel/session/session-tree.ts";
import { hasSecretLikeText } from "../security/secret-text.ts";
import {
	formatTranscriptLineageDigest,
	formatTranscriptSourceHandle,
	parseTranscriptSourceHandle,
	sameTranscriptSource,
	splitUtf8,
	TRANSCRIPT_LINEAGE_DIGEST_MODULUS,
	TRANSCRIPT_MAX_PARTS_PER_ENTRY,
	TRANSCRIPT_PART_MAX_BYTES,
	TRANSCRIPT_RECALL_PAGE_MARKER,
	TRANSCRIPT_RECALL_RESULT_MARKER,
	type TranscriptCaptureRole,
	type TranscriptLineage,
	type TranscriptSourceSpan,
	type TranscriptUncapturedReason,
	transcriptCaptureIdentity,
	transcriptCaptureInputs,
	transcriptDigest,
	transcriptLineageTerm,
	utf8ByteLength,
} from "./transcript-memory-contracts.ts";

/** One captured source part: its bounded metadata plus the exact captured text. */
export interface CapturedSpan {
	span: TranscriptSourceSpan;
	text: string;
}

/** What one conversation entry contributed. `uncapturedReason` is the first reason content was left out. */
export interface EntryCapture {
	parts: CapturedSpan[];
	uncapturedReason?: string;
	uncaptured: Record<string, number>;
}

export interface SessionSpanCapture {
	sessionId: string;
	timestamp?: string;
	cwd?: string;
	spans: CapturedSpan[];
	/** Counts of content left out of capture, by reason. */
	uncaptured: Record<string, number>;
}

export interface TranscriptPartLookup {
	/** Whether the entry is a conversation entry of this session at all. */
	entryExists: boolean;
	part?: CapturedSpan;
	nextPart?: CapturedSpan;
	/** First reason content of this entry was left out of capture. */
	uncapturedReason?: string;
}

interface CaptureUnit {
	role: TranscriptCaptureRole;
	text: string;
	toolName?: string;
	toolCallId?: string;
	isError?: boolean;
}

interface LiteEntry {
	id: string;
	parentId: string | null;
}

function startsWith(ids: readonly string[], prefix: readonly string[]): boolean {
	for (let position = 0; position < prefix.length; position++) {
		if (ids[position] !== prefix[position]) return false;
	}
	return true;
}

const NOT_A_DIGEST = "0".repeat(16);

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object";
}

function bump(counts: Record<string, number>, reason: string, amount = 1): void {
	counts[reason] = (counts[reason] ?? 0) + amount;
}

/**
 * Whether a handle for this session and entry survives a format/parse round trip. A captured span
 * whose handle could not be opened again would be a fabricated source, so identifiers that fail the
 * handle grammar are never captured.
 */
function isHandleResolvable(projectId: string, sessionId: string, entryId: string): boolean {
	const handle = formatTranscriptSourceHandle({ projectId, sessionId, entryId, part: 0, digest: NOT_A_DIGEST });
	return parseTranscriptSourceHandle(handle, projectId) !== undefined;
}

export function isTranscriptSessionIdResolvable(projectId: string, sessionId: string): boolean {
	return isHandleResolvable(projectId, sessionId, "e");
}

/** Text blocks joined by newline. Image blocks are counted as uncaptured; every other block type is ignored. */
function collectText(content: unknown, uncaptured: Record<string, number>): string | undefined {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return undefined;
	const texts: string[] = [];
	for (const block of content as unknown[]) {
		if (!isRecord(block)) continue;
		if (block.type === "text" && typeof block.text === "string") texts.push(block.text);
		else if (block.type === "image") bump(uncaptured, "binary_or_image");
	}
	return texts.length > 0 ? texts.join("\n") : undefined;
}

/** Units of a message entry, or undefined when the message role is not conversation content. */
function messageUnits(message: unknown, uncaptured: Record<string, number>): CaptureUnit[] | undefined {
	if (!isRecord(message)) return undefined;
	if (message.role === "user") {
		const text = collectText(message.content, uncaptured);
		return text === undefined ? [] : [{ role: "user", text }];
	}
	if (message.role === "toolResult") {
		const text = collectText(message.content, uncaptured);
		if (text === undefined) return [];
		const unit: CaptureUnit = { role: "tool_result", text, isError: message.isError === true };
		if (typeof message.toolName === "string") unit.toolName = message.toolName;
		if (typeof message.toolCallId === "string") unit.toolCallId = message.toolCallId;
		return [unit];
	}
	if (message.role === "assistant") {
		if (!Array.isArray(message.content)) return [];
		const texts: string[] = [];
		const calls: CaptureUnit[] = [];
		for (const block of message.content as unknown[]) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") {
				texts.push(block.text);
			} else if (block.type === "toolCall" && typeof block.name === "string") {
				const call: CaptureUnit = {
					role: "tool_call",
					text: `${block.name} ${JSON.stringify(block.arguments ?? {})}`,
					toolName: block.name,
				};
				if (typeof block.id === "string") call.toolCallId = block.id;
				calls.push(call);
			}
		}
		const units: CaptureUnit[] = texts.length > 0 ? [{ role: "assistant", text: texts.join("\n") }] : [];
		return [...units, ...calls];
	}
	return undefined;
}

/**
 * Capture one session entry. Returns undefined for entries that are not conversation content
 * (lifecycle, model changes, labels, ...). Spans start labelled `selected`; the owning
 * {@link SessionCaptureState} relabels them from ancestry.
 */
export function captureEntry(entry: SessionEntry, projectId: string, sessionId: string): EntryCapture | undefined {
	const uncaptured: Record<string, number> = {};
	let reason: string | undefined;
	const note = (why: TranscriptUncapturedReason, amount = 1): void => {
		bump(uncaptured, why, amount);
		reason ??= why;
	};
	const finish = (parts: CapturedSpan[]): EntryCapture => {
		const capture: EntryCapture = { parts, uncaptured };
		if (reason !== undefined) capture.uncapturedReason = reason;
		return capture;
	};

	if (entry.type === "custom_message") {
		note("custom_message");
		return finish([]);
	}
	if (entry.type !== "message") return undefined;
	// A history read's result is recalled evidence: capturing it again would make the system index and
	// summarize its own recall. The canonical entry stays as it is; only its derived capture is left out.
	const message: unknown = entry.message;
	if (
		isRecord(message) &&
		message.role === "toolResult" &&
		isRecord(message.details) &&
		message.details[TRANSCRIPT_RECALL_RESULT_MARKER] === true
	) {
		note("recalled_history");
		return finish([]);
	}

	const units = messageUnits(message, uncaptured);
	if (units === undefined) {
		note("other_message_role");
		return finish([]);
	}
	if (!isHandleResolvable(projectId, sessionId, entry.id)) {
		note("invalid_id");
		return finish([]);
	}

	const parts: CapturedSpan[] = [];
	for (const unit of units) {
		const text = unit.text.trim();
		if (!text) {
			note("empty");
			continue;
		}
		if (text.includes(TRANSCRIPT_RECALL_PAGE_MARKER)) {
			note("generated_memory");
			continue;
		}
		if (hasSecretLikeText(text)) {
			note("secret_like");
			continue;
		}
		const chunks = splitUtf8(text, TRANSCRIPT_PART_MAX_BYTES);
		for (let index = 0; index < chunks.length; index++) {
			if (parts.length >= TRANSCRIPT_MAX_PARTS_PER_ENTRY) {
				note("part_limit", chunks.length - index);
				break;
			}
			const chunk = chunks[index] ?? "";
			const span: TranscriptSourceSpan = {
				ref: { projectId, sessionId, entryId: entry.id, part: parts.length, digest: "" },
				role: unit.role,
				lineage: "selected",
				bytes: utf8ByteLength(chunk),
				textDigest: transcriptDigest(chunk),
			};
			if (typeof entry.timestamp === "string") span.timestamp = entry.timestamp;
			if (entry.origin === "local") span.origin = "host";
			if (unit.toolName !== undefined) span.toolName = unit.toolName;
			if (unit.toolCallId !== undefined) span.toolCallId = unit.toolCallId;
			if (unit.isError !== undefined) span.isError = unit.isError;
			// The identity binds the text and the metadata just attached, through the same input builder the
			// verifier (`isCurrentCaptureIdentity`) uses.
			span.ref.digest = transcriptCaptureIdentity(transcriptCaptureInputs(span, chunk));
			parts.push({ span, text: chunk });
		}
	}
	return finish(parts);
}

/**
 * Incremental capture of one session: entries are added as they are read (a full file load and a
 * later appended batch use the same path), and lineage is recomputed from ancestry on `finalize`.
 */
export class SessionCaptureState {
	readonly projectId: string;
	readonly sessionId: string;
	private readonly lite: LiteEntry[] = [];
	private readonly ids = new Set<string>();
	private readonly entries = new Map<string, EntryCapture>();
	private readonly uncapturedTotals: Record<string, number> = {};
	private bytes = 0;
	private count = 0;
	private branchIds: string[] = [];
	private selectedList: CapturedSpan[] = [];
	/**
	 * `termPrefix[i]`: sum of the lineage terms of `selectedList[0..i)`, modulo 2^128. Extended lazily up to the
	 * furthest position a range check needed; an append leaves it valid, a lineage rebuild resets it.
	 */
	private termPrefix: bigint[] = [0n];
	private lineageHash: Hash | undefined;
	private digestValue = transcriptDigest("");

	constructor(projectId: string, sessionId: string) {
		this.projectId = projectId;
		this.sessionId = sessionId;
	}

	/** Total UTF-8 bytes of captured text retained by this state. */
	get retainedBytes(): number {
		return this.bytes;
	}

	get spanCount(): number {
		return this.count;
	}

	get uncaptured(): Readonly<Record<string, number>> {
		return this.uncapturedTotals;
	}

	/** A line that could not be read as a session entry. Counted by reason, never silently dropped. */
	noteUncapturedLine(reason: TranscriptUncapturedReason): void {
		bump(this.uncapturedTotals, reason);
	}

	add(entry: SessionEntry): void {
		if (this.ids.has(entry.id)) {
			bump(this.uncapturedTotals, "duplicate_entry_id");
			return;
		}
		this.ids.add(entry.id);
		this.lite.push({ id: entry.id, parentId: entry.parentId });
		const capture = captureEntry(entry, this.projectId, this.sessionId);
		if (!capture) return;
		this.entries.set(entry.id, capture);
		for (const [reason, amount] of Object.entries(capture.uncaptured)) bump(this.uncapturedTotals, reason, amount);
		for (const part of capture.parts) {
			this.bytes += part.span.bytes;
			this.count++;
		}
	}

	/** Ids of the selected lineage's entries (every entry type), root first, as of the last `finalize`. */
	get branchEntryIds(): readonly string[] {
		return this.branchIds;
	}

	/** Whether the current selected lineage keeps `previous` as its prefix, i.e. only grew at the leaf. */
	lineageExtends(previous: readonly string[]): boolean {
		return previous.length <= this.branchIds.length && startsWith(this.branchIds, previous);
	}

	/** Captured spans on the selected lineage in ancestry order (entry order, then part order). */
	selectedSpans(): readonly CapturedSpan[] {
		return this.selectedList;
	}

	/** Digest over the selected lineage's span handles in order; changes whenever that lineage changes. */
	lineageDigest(): string {
		return this.digestValue;
	}

	/**
	 * Relabel every span from entry ancestry and extend the selected-lineage list and its digest. When the
	 * new lineage only grew at the leaf, just the new entries are appended and hashed; any other change
	 * (branch switch, first call) rebuilds. Throws when the entry graph has a parent cycle.
	 */
	finalize(): void {
		const previousIds = this.branchIds;
		const ids = collectSessionBranch(this.lite).map((entry) => entry.id);
		const grew = this.lineageHash !== undefined && ids.length >= previousIds.length && startsWith(ids, previousIds);
		this.branchIds = ids;
		let hash = this.lineageHash;
		let from = previousIds.length;
		if (!grew || hash === undefined) {
			hash = createHash("sha256");
			this.selectedList = [];
			this.termPrefix = [0n];
			from = 0;
		}
		for (let position = from; position < ids.length; position++) {
			const capture = this.entries.get(ids[position] ?? "");
			if (!capture) continue;
			for (const part of capture.parts) {
				// Identical bytes to `transcriptDigest(handles.join("\n"))`, hashed as the lineage grows.
				if (this.selectedList.length > 0) hash.update("\n");
				hash.update(formatTranscriptSourceHandle(part.span.ref));
				this.selectedList.push(part);
			}
		}
		this.lineageHash = hash;
		this.digestValue = hash.copy().digest("hex").slice(0, 16);
		const selected = new Set(this.branchIds);
		for (const [entryId, capture] of this.entries) {
			const lineage: TranscriptLineage = selected.has(entryId) ? "selected" : "alternate";
			for (const part of capture.parts) {
				if (part.span.lineage !== lineage) part.span = { ...part.span, lineage };
			}
		}
	}

	/**
	 * The first selected-lineage position whose part differs from `previous` (an earlier selected list of this
	 * session): positions before it hold the same sources. When one list is a prefix of the other it is the shorter
	 * length. The lowest position a lineage change can have affected.
	 */
	firstChangedPosition(previous: readonly CapturedSpan[]): number {
		const shared = Math.min(previous.length, this.selectedList.length);
		for (let position = 0; position < shared; position++) {
			const before = previous[position];
			const after = this.selectedList[position];
			if (!before || !after || !sameTranscriptSource(before.span.ref, after.span.ref)) return position;
		}
		return shared;
	}

	/**
	 * The lineage range digest of `count` selected-lineage parts from `fromIndex`: the same value as
	 * `transcriptLineageRangeDigest(fromIndex, refs)` of the parts there, read from prefix sums, so a check costs
	 * O(1) once the prefix reaches the range. Undefined when the lineage is shorter than the range.
	 */
	rangeDigest(fromIndex: number, count: number): string | undefined {
		const to = fromIndex + count;
		if (to > this.selectedList.length) return undefined;
		for (let position = this.termPrefix.length - 1; position < to; position++) {
			const part = this.selectedList[position];
			if (!part) return undefined;
			const sum = (this.termPrefix[position] ?? 0n) + transcriptLineageTerm(position, part.span.ref);
			this.termPrefix.push(sum % TRANSCRIPT_LINEAGE_DIGEST_MODULUS);
		}
		return formatTranscriptLineageDigest((this.termPrefix[to] ?? 0n) - (this.termPrefix[fromIndex] ?? 0n));
	}

	spans(): CapturedSpan[] {
		const spans: CapturedSpan[] = [];
		for (const capture of this.entries.values()) spans.push(...capture.parts);
		return spans;
	}

	lookup(entryId: string, part: number): TranscriptPartLookup {
		const capture = this.entries.get(entryId);
		if (!capture) return { entryExists: false };
		const result: TranscriptPartLookup = { entryExists: true };
		const found = capture.parts[part];
		if (found) result.part = found;
		const next = capture.parts[part + 1];
		if (next) result.nextPart = next;
		if (capture.uncapturedReason !== undefined) result.uncapturedReason = capture.uncapturedReason;
		return result;
	}
}

/** Capture a whole session from its entries. The header supplies the session identity. */
export function captureSessionSpans(entries: readonly FileEntry[], projectId: string): SessionSpanCapture {
	let header: Extract<FileEntry, { type: "session" }> | undefined;
	for (const entry of entries) {
		if (entry.type === "session") {
			header = entry;
			break;
		}
	}
	if (!header) throw new Error("Session entries have no session header.");
	const state = new SessionCaptureState(projectId, header.id);
	for (const entry of entries) {
		if (entry.type !== "session") state.add(entry);
	}
	state.finalize();
	const capture: SessionSpanCapture = {
		sessionId: header.id,
		spans: state.spans(),
		uncaptured: { ...state.uncaptured },
	};
	if (typeof header.timestamp === "string") capture.timestamp = header.timestamp;
	if (typeof header.cwd === "string") capture.cwd = header.cwd;
	return capture;
}
