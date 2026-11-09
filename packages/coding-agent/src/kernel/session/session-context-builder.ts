/** Model-facing session context: compaction-aware selection of retained entries, the context messages and their delivered metadata, and the branch views built from them. */
import { ACTIVE_TASK_SOURCE_MAX_CHARS, clampText } from "../compaction/extraction.ts";
import { projectCurrentActiveTask } from "../compaction/verification.ts";
import { createBranchSummaryMessage, createCompactionSummaryMessage, createCustomMessage } from "../messages.ts";
import { type OwnerInputId, ownerInputIdOf, stampOwnerInput } from "../owner-input-stamp.ts";
import { classifyTransientRecord } from "../transient-records.ts";
import {
	parseTurnOriginRecord,
	stampTurnOrigin,
	type TurnOriginRecord,
	turnOriginStampOf,
	UNREADABLE_TURN_ORIGIN,
} from "../turn-origin-stamp.ts";
import type { AgentMessage } from "../types.ts";
import { parseWorkerControlRecord, stampWorkerControl, workerControlOf } from "../worker-control-stamp.ts";
import { parentInputContextIds } from "./parent-input-ledger.ts";
import type { CompactionEntry, CustomMessageEntry, SessionEntry } from "./session-entries.ts";
import type { SessionContext } from "./session-manager-types.ts";
import { visitSessionAncestry } from "./session-tree.ts";

const synthesizedSessionContextMessages = new WeakSet<AgentMessage>();
/**
 * The custom_message entry each custom message object was persisted as or materialized from. A custom message is
 * rebuilt from its entry's fields, so unlike a message entry its object identity is not the entry's: this map is
 * the only link from the object back to its entry.
 */
export const customMessageEntries = new WeakMap<object, CustomMessageEntry>();

export function retainSynthesizedSessionContextMessage<T extends AgentMessage>(
	message: T,
	customEntry?: CustomMessageEntry,
): T {
	synthesizedSessionContextMessages.add(message);
	if (customEntry !== undefined) customMessageEntries.set(message, customEntry);
	return message;
}

export function cloneSessionContext(context: SessionContext): SessionContext {
	return {
		messages: context.messages.map((message) => {
			if (!synthesizedSessionContextMessages.has(message)) return message;
			const copy = { ...message };
			const customEntry = customMessageEntries.get(message);
			if (customEntry !== undefined) customMessageEntries.set(copy, customEntry);
			return copy;
		}),
		thinkingLevel: context.thinkingLevel,
		model: context.model ? { ...context.model } : null,
	};
}

export function getLatestCompactionEntry(entries: SessionEntry[]): CompactionEntry | null {
	for (let i = entries.length - 1; i >= 0; i--) {
		if (entries[i].type === "compaction") {
			return entries[i] as CompactionEntry;
		}
	}
	return null;
}

/** Same custom type as `COMPACTION_PREPARED_CUSTOM_TYPE` in the compaction controller. The kernel cannot import that module. */
const COMPACTION_PREPARED_ENTRY_TYPE = "compaction_prepared";
/** Trailer `applyResult` appends to an original-user summary. The prepared record keeps the summary without it. */
const PREPARED_SUMMARY_TRANSCRIPT_TRAILER = /^\n\nFull pre-compaction transcript: [^\n]+$/;

function userMessageText(message: AgentMessage): string {
	if (message.role !== "user") return "";
	const content = message.content;
	if (typeof content === "string") return content.trim();
	const parts: string[] = [];
	for (const block of content) {
		if (block.type === "text") parts.push(block.text);
	}
	return (parts.length === 1 ? parts[0] : parts.join(" ")).trim();
}

/** Summary text of an original-user `compaction_prepared` entry that names its parent. */
function readPreparedSummary(entry: SessionEntry): string | undefined {
	if (entry.type !== "custom" || entry.customType !== COMPACTION_PREPARED_ENTRY_TYPE || !entry.parentId) {
		return undefined;
	}
	const data = entry.data;
	if (typeof data !== "object" || data === null || !("result" in data)) return undefined;
	const result = data.result;
	if (typeof result !== "object" || result === null) return undefined;
	if (!("summary" in result) || typeof result.summary !== "string" || result.summary.trimEnd().length === 0) {
		return undefined;
	}
	if (!("retention" in result) || typeof result.retention !== "object" || result.retention === null) return undefined;
	if (!("mode" in result.retention) || result.retention.mode !== "original-user") return undefined;
	return result.summary;
}

function appliedSummaryMatchesPrepared(applied: string, prepared: string): boolean {
	const base = prepared.trimEnd();
	if (applied === base) return true;
	if (!applied.startsWith(base)) return false;
	return PREPARED_SUMMARY_TRANSCRIPT_TRAILER.test(applied.slice(base.length));
}

/**
 * Parent of the latest prepared summary that this compaction applied. A request or another compaction
 * between them means the prepared summary is not this checkpoint, and no boundary is invented.
 */
function recoveredCoveredEntryId(
	path: readonly SessionEntry[],
	compactionIdx: number,
	appliedSummary: string,
): string | undefined {
	let coveredId: string | undefined;
	for (let i = 0; i < compactionIdx; i++) {
		const entry = path[i];
		const prepared = readPreparedSummary(entry);
		if (!prepared || !appliedSummaryMatchesPrepared(appliedSummary, prepared)) continue;
		let blocked = false;
		for (let j = i + 1; j < compactionIdx; j++) {
			const between = path[j]?.type;
			if (between === "request_snapshot" || between === "compaction") {
				blocked = true;
				break;
			}
		}
		if (!blocked && entry.parentId) coveredId = entry.parentId;
	}
	return coveredId;
}

function latestUserText(entries: readonly SessionEntry[], anchorId: string | undefined): string {
	let text = "";
	for (const entry of entries) {
		if (!entry || (anchorId !== undefined && entry.id === anchorId) || entry.type !== "message") continue;
		const next = userMessageText(entry.message);
		if (next) text = next;
	}
	return text;
}

interface OriginalUserCut {
	compaction: CompactionEntry;
	index: number;
	coveredIdx: number;
}

function originalUserCuts(path: readonly SessionEntry[]): OriginalUserCut[] {
	const cuts: OriginalUserCut[] = [];
	for (let i = 0; i < path.length; i++) {
		const entry = path[i];
		if (entry?.type !== "compaction" || entry.retention?.mode !== "original-user") continue;
		const coveredThroughEntryId = entry.coveredThroughEntryId ?? recoveredCoveredEntryId(path, i, entry.summary);
		const coveredIdx =
			coveredThroughEntryId === undefined
				? -1
				: path.findIndex((candidate) => candidate.id === coveredThroughEntryId);
		cuts.push({ compaction: entry, index: i, coveredIdx });
	}
	return cuts;
}

function isProjectedGapEntry(entry: SessionEntry): boolean {
	return (
		entry.type === "message" ||
		entry.type === "custom_message" ||
		(entry.type === "branch_summary" && Boolean(entry.summary))
	);
}

function gapEntries(path: readonly SessionEntry[], cut: OriginalUserCut): SessionEntry[] {
	if (cut.coveredIdx < 0 || cut.coveredIdx >= cut.index) return [];
	const anchorId = cut.compaction.retention?.userEntryId;
	const entries: SessionEntry[] = [];
	for (let i = cut.coveredIdx + 1; i < cut.index; i++) {
		const entry = path[i];
		if (!entry || entry.id === anchorId || !isProjectedGapEntry(entry)) continue;
		entries.push(entry);
	}
	return entries;
}

/** A later checkpoint lists this id only when its summary was built from a projection that contained it. */
function gapOwnedByLaterSummary(path: readonly SessionEntry[], entryId: string, cutIndex: number): boolean {
	for (let i = cutIndex + 1; i < path.length; i++) {
		const later = path[i];
		if (later?.type !== "compaction" || !later.summarizedGapEntryIds?.includes(entryId)) continue;
		return true;
	}
	return false;
}

/**
 * Gap entries the current projection emits. These are the messages a summary of this projection
 * contains and must record. A later checkpoint that lists an id already summarized it.
 */
function projectedGapEntries(path: readonly SessionEntry[]): SessionEntry[] {
	const projected: SessionEntry[] = [];
	const seen = new Set<string>();
	for (const cut of originalUserCuts(path)) {
		for (const entry of gapEntries(path, cut)) {
			if (seen.has(entry.id) || gapOwnedByLaterSummary(path, entry.id, cut.index)) continue;
			seen.add(entry.id);
			projected.push(entry);
		}
	}
	return projected;
}

function branchPath(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionEntry[] | undefined {
	if (!byId) {
		byId = new Map<string, SessionEntry>();
		for (const entry of entries) byId.set(entry.id, entry);
	}
	if (leafId === null) return undefined;
	let leaf = leafId ? byId.get(leafId) : undefined;
	if (!leaf) leaf = entries[entries.length - 1];
	if (!leaf) return undefined;
	const path: SessionEntry[] = [];
	visitSessionAncestry(leaf, byId, (entry) => {
		path.push(entry);
	});
	path.reverse();
	return path;
}

/**
 * Entry ids of original-user gaps that `buildSessionContext` emits for this branch, from every section of the
 * rebuilt context. Session-replacement preparation stores them on the checkpoint so the next rebuild does not emit
 * messages the summary included.
 */
export function summarizedGapEntryIds(entries: SessionEntry[], leafId?: string | null): string[] {
	const path = branchPath(entries, leafId);
	if (!path) return [];
	const ids: string[] = [];
	for (const section of compactedContextSections(path)) {
		if (section.kind === "compacted") for (const entry of section.selection.restoredGaps) ids.push(entry.id);
	}
	return ids;
}

/**
 * Whether a checkpoint summarizes everything before it on this path: it is unscoped, or its scope starts at the
 * path's first entry. A checkpoint scoped to a later entry replaced only that scope, so the entries before the scope
 * are not covered by its summary and a new checkpoint of this path must read them itself.
 */
export function isWholePathCompaction(path: readonly SessionEntry[], compaction: CompactionEntry): boolean {
	return compaction.scopeStartEntryId === undefined || compaction.scopeStartEntryId === path[0]?.id;
}

/**
 * Where a checkpoint's scope starts on a branch path: 0 for an unscoped checkpoint, else the index of its scope
 * start entry. A scope start that is not at or before the checkpoint on the path is a broken session, never guessed.
 */
function compactionScopeIndex(
	path: readonly SessionEntry[],
	compaction: CompactionEntry,
	compactionIdx: number,
): number {
	if (compaction.scopeStartEntryId === undefined) return 0;
	for (let i = compactionIdx; i >= 0; i--) {
		if (path[i]?.id === compaction.scopeStartEntryId) return i;
	}
	throw new Error(
		`Compaction ${compaction.id} is scoped to entry ${compaction.scopeStartEntryId}, which is not before it on this branch.`,
	);
}

/** What a rebuilt context emits verbatim for one checkpoint's section `[scopeIdx, end)` of a branch path. */
interface CompactedContextSelection {
	/** Where the checkpoint's scope starts: the section's first entry. Entries before it belong to earlier sections. */
	scopeIdx: number;
	compactionIdx: number;
	/** Where the section ends: the path's end for the latest checkpoint, else the next section's scope start. */
	end: number;
	/**
	 * The entry kept verbatim before the summary, in `original-user` mode: the original user message, or for a scoped
	 * checkpoint its scope start, whatever that entry's message role.
	 */
	originalUserEntry: SessionEntry | undefined;
	/** The original-user gap entries a rebuild restores; empty in the standard mode. */
	restoredGaps: SessionEntry[];
	/** Transient records carried forward from before the cut, in path order. */
	carried: SessionEntry[];
	/** Entries before the compaction entry that stay verbatim: the kept tail, or the restored gaps. */
	retained: SessionEntry[];
}

/**
 * The one owner of which entries before a compaction stay in the context: `buildSessionContext` emits them
 * and {@link retainedEntryIdsBeforeCompaction} reports them, so no other module restates the retention rules.
 * The selection covers the checkpoint's section `[scopeIdx, end)` only: a scoped checkpoint owns only the entries
 * from its scope start onward, so nothing before that is retained, restored or carried by it. Without a scope the
 * whole path before the checkpoint is its input, as always.
 */
function selectCompactedContext(
	path: readonly SessionEntry[],
	compaction: CompactionEntry,
	compactionIdx: number,
	end: number,
	pendingInputIds: ReadonlySet<string>,
): CompactedContextSelection {
	const scopeIdx = compactionScopeIndex(path, compaction, compactionIdx);
	const scopedPath = scopeIdx === 0 && end === path.length ? path : path.slice(scopeIdx, end);
	const originalUserEntry =
		compaction.retention?.mode === "original-user"
			? path
					.slice(scopeIdx, compactionIdx)
					.find(
						(entry) =>
							entry.id === compaction.retention?.userEntryId &&
							(entry.type === "message" || entry.type === "custom_message"),
					)
			: undefined;

	const restoredGaps = compaction.retention?.mode === "original-user" ? projectedGapEntries(scopedPath) : [];

	// Transient records (append-on-change host and kernel records: skill context, goal context,
	// legend deltas, failure ledger) that fell before the cut are carried forward: the last record
	// of each kind, every record of a cumulative kind. Without them the reconciler sees no durable
	// instance after compaction and re-appends every kind on the next request, re-sending the same
	// content the compacted history already carried. Kinds with a record in the kept tail need none.
	let firstKeptIdx = compactionIdx;
	for (let i = scopeIdx; i < compactionIdx; i++) {
		if (path[i].id === compaction.firstKeptEntryId) {
			firstKeptIdx = i;
			break;
		}
	}
	const tailKinds = new Set<string>();
	for (let i = firstKeptIdx; i < end; i++) {
		const entry = path[i];
		if (entry.type === "custom_message" && classifyTransientRecord(entry.content, entry.details).transient) {
			tailKinds.add(entry.customType);
		}
	}
	const carriedByKind = new Map<string, SessionEntry[]>();
	for (let i = scopeIdx; i < firstKeptIdx; i++) {
		const entry = path[i];
		if (entry.type !== "custom_message" || tailKinds.has(entry.customType)) continue;
		const record = classifyTransientRecord(entry.content, entry.details);
		if (!record.transient) continue;
		if (record.cumulative) {
			const list = carriedByKind.get(entry.customType) ?? [];
			list.push(entry);
			carriedByKind.set(entry.customType, list);
		} else carriedByKind.set(entry.customType, [entry]);
	}
	const retained = compaction.retention ? restoredGaps : path.slice(firstKeptIdx, compactionIdx);
	const carried = [...carriedByKind.values()].flat();
	const preserved = new Set([...carried, ...retained, ...restoredGaps].map((entry) => entry.id));
	if (originalUserEntry) preserved.add(originalUserEntry.id);
	// Accepted input remains verbatim until its wake settles, even when a summary covers its position.
	for (let i = scopeIdx; i < compactionIdx; i++) {
		const entry = path[i];
		if (pendingInputIds.has(entry.id) && !preserved.has(entry.id)) {
			carried.push(entry);
			preserved.add(entry.id);
		}
	}
	carried.sort((a, b) => path.indexOf(a) - path.indexOf(b));
	return { scopeIdx, compactionIdx, end, originalUserEntry, restoredGaps, carried, retained };
}

/** One section of a rebuilt context: raw entries `[0, end)`, or one checkpoint's section. */
type ContextSection =
	| { kind: "raw"; end: number }
	| { kind: "compacted"; compaction: CompactionEntry; selection: CompactedContextSelection };

/**
 * The sections a branch path rebuilds into, earliest first. The latest checkpoint owns the path from its scope start
 * to the end. A scoped checkpoint replaced only its scope, so the entries before that scope are rebuilt exactly as the
 * shorter branch ending there would be: by its own latest checkpoint, and so on, down to a raw section or an
 * unscoped checkpoint. Each step scans backward from the previous section's start, so the whole path is read once.
 */
function compactedContextSections(path: readonly SessionEntry[]): ContextSection[] {
	const pendingInputIds = parentInputContextIds(path);
	const sections: ContextSection[] = [];
	let end = path.length;
	while (end > 0) {
		let compactionIdx = -1;
		for (let i = end - 1; i >= 0; i--) {
			if (path[i]?.type === "compaction") {
				compactionIdx = i;
				break;
			}
		}
		if (compactionIdx < 0) {
			sections.push({ kind: "raw", end });
			break;
		}
		const compaction = path[compactionIdx] as CompactionEntry;
		const selection = selectCompactedContext(path, compaction, compactionIdx, end, pendingInputIds);
		sections.push({ kind: "compacted", compaction, selection });
		end = selection.scopeIdx;
	}
	return sections.reverse();
}

/**
 * Ids of the entries positioned before the latest compaction of a branch path that the rebuilt context still
 * emits: the kept tail (or, in `original-user` mode, the retained user message and restored gaps) and the
 * carried-forward transient records, plus, for a scoped checkpoint, everything the sections before its scope emit
 * (their checkpoint entries included). Everything else before that compaction was compacted away. Empty when the
 * path holds no compaction.
 */
export function retainedEntryIdsBeforeCompaction(path: readonly SessionEntry[]): ReadonlySet<string> {
	const retained = new Set<string>();
	const sections = compactedContextSections(path);
	const latest = sections[sections.length - 1];
	if (latest?.kind !== "compacted") return retained;
	for (const section of sections) {
		if (section.kind === "raw") {
			for (let i = 0; i < section.end; i++) retained.add((path[i] as SessionEntry).id);
			continue;
		}
		const { selection } = section;
		if (selection.originalUserEntry) retained.add(selection.originalUserEntry.id);
		for (const entry of selection.carried) retained.add(entry.id);
		for (const entry of selection.retained) retained.add(entry.id);
		if (section === latest) continue;
		retained.add(section.compaction.id);
		for (let i = selection.compactionIdx + 1; i < selection.end; i++) retained.add((path[i] as SessionEntry).id);
	}
	return retained;
}

/**
 * Build the session context from entries using tree traversal.
 * If leafId is provided, walks from that entry to root.
 * Handles compaction and branch summaries along the path.
 *
 * The latest compaction is the checkpoint. A checkpoint scoped to a later entry (a running ICM chat turn's start)
 * replaced only its scope: the entries before the scope are rebuilt first, as the branch ending there would be.
 * Its own unsummarized suffix, and any earlier
 * original-user gap that no later checkpoint recorded as part of its summary, are emitted
 * after that summary. A stored `coveredThroughEntryId` is never replaced by recovery.
 * The stored summary text is not rewritten. When a restored gap contains a user message, only the
 * provider view of Active Task names the latest of those messages. Messages after the checkpoint are
 * never read: they follow the summary in context, and rewriting the summary at the head of the
 * request on each of them would break the cached prefix every user turn.
 */
export function buildSessionContext(
	entries: SessionEntry[],
	leafId?: string | null,
	byId?: Map<string, SessionEntry>,
): SessionContext {
	const path = branchPath(entries, leafId, byId);
	if (!path) {
		return { messages: [], thinkingLevel: "off", model: null };
	}

	// Extract settings
	let thinkingLevel = "off";
	let model: { provider: string; modelId: string } | null = null;

	for (const entry of path) {
		if (entry.type === "thinking_level_change") {
			thinkingLevel = entry.thinkingLevel;
		} else if (entry.type === "model_change") {
			model = { provider: entry.provider, modelId: entry.modelId };
		}
	}

	return { messages: sessionContextItems(path).map((item) => item.message), thinkingLevel, model };
}

/** One message of a rebuilt session context and the entry it came from (a compaction entry for its summary). */
export interface SessionContextItem {
	entry: SessionEntry;
	message: AgentMessage;
}

function sessionContextMessage(entry: SessionEntry): AgentMessage | undefined {
	if (entry.type === "message") {
		// A context rebuilt from persisted entries carries the identity the entry names, as a live message does.
		if (
			entry.workerControl !== undefined &&
			entry.message.role === "user" &&
			Object.isExtensible(entry.message) &&
			workerControlOf(entry.message) === undefined
		) {
			const record = parseWorkerControlRecord(entry.workerControl);
			if (record) stampWorkerControl(entry.message, record);
		}
		// An origin that does not parse is third-party: an unreadable record never gains the owner's authority.
		if (
			entry.turnOrigin !== undefined &&
			entry.message.role === "user" &&
			Object.isExtensible(entry.message) &&
			turnOriginStampOf(entry.message) === undefined
		)
			stampTurnOrigin(entry.message, parseTurnOriginRecord(entry.turnOrigin) ?? UNREADABLE_TURN_ORIGIN);
		// The owner input the entry delivered, so a rebuilt context (resume, fork, tree, a parent's wake) names whose words
		// it holds as the live message did.
		if (
			typeof entry.ownerInputId === "string" &&
			entry.message.role === "user" &&
			Object.isExtensible(entry.message) &&
			ownerInputIdOf(entry.message) === undefined
		)
			stampOwnerInput(entry.message, entry.ownerInputId as OwnerInputId);
		return entry.message;
	}
	if (entry.type === "custom_message") {
		return retainSynthesizedSessionContextMessage(
			createCustomMessage(entry.customType, entry.content, entry.display, entry.details, entry.timestamp),
			entry,
		);
	}
	if (entry.type === "branch_summary" && entry.summary) {
		return retainSynthesizedSessionContextMessage(
			createBranchSummaryMessage(entry.summary, entry.fromId, entry.timestamp),
		);
	}
	return undefined;
}

/** The typed worker-message identity a persisted user message carries, to be written before it on its entry. */
export function deliveredWorkerControl(message: AgentMessage): { workerControl?: ReturnType<typeof workerControlOf> } {
	const record = message.role === "user" ? workerControlOf(message) : undefined;
	return record === undefined ? {} : { workerControl: record };
}

/** The owner input a persisted user message delivers, as its entry names it; nothing for any other message. */
export function deliveredOwnerInput(message: AgentMessage): { ownerInputId?: string } {
	const id = message.role === "user" ? ownerInputIdOf(message) : undefined;
	return id === undefined ? {} : { ownerInputId: id };
}

/** The origin stamp a persisted user message carries, to be written on its entry. */
export function deliveredTurnOrigin(message: AgentMessage): { turnOrigin?: TurnOriginRecord } {
	const record = message.role === "user" ? turnOriginStampOf(message) : undefined;
	return record === undefined ? {} : { turnOrigin: record };
}

/**
 * The messages {@link buildSessionContext} rebuilds for a branch path (root to leaf), in order, each with its source
 * entry. The one owner of what a rebuilt context holds: anything that reports on the active context reads this.
 */
export function sessionContextItems(path: readonly SessionEntry[]): SessionContextItem[] {
	const items: SessionContextItem[] = [];
	const appendMessage = (entry: SessionEntry) => {
		const message = sessionContextMessage(entry);
		if (message) items.push({ entry, message });
	};

	// Sections run earliest first: a scoped checkpoint follows the context of the entries before its scope.
	for (const section of compactedContextSections(path)) {
		if (section.kind === "raw") {
			// No compaction before this point - emit all messages, handle branch summaries and custom messages
			for (let i = 0; i < section.end; i++) appendMessage(path[i] as SessionEntry);
			continue;
		}
		const { compaction, selection } = section;
		const { compactionIdx, originalUserEntry, restoredGaps } = selection;
		const unsummarizedTask = compaction.retention
			? clampText(latestUserText(restoredGaps, compaction.retention.userEntryId), ACTIVE_TASK_SOURCE_MAX_CHARS)
			: "";
		const providerSummary = unsummarizedTask
			? projectCurrentActiveTask(compaction.summary, unsummarizedTask)
			: compaction.summary;

		if (originalUserEntry) appendMessage(originalUserEntry);
		items.push({
			entry: compaction,
			message: retainSynthesizedSessionContextMessage(
				createCompactionSummaryMessage(
					providerSummary,
					compaction.tokensBefore,
					compaction.timestamp,
					compaction.details,
					compaction.id,
				),
			),
		});

		for (const entry of selection.carried) appendMessage(entry);
		for (const entry of selection.retained) appendMessage(entry);

		// Emit messages after compaction, up to the section's end
		for (let i = compactionIdx + 1; i < selection.end; i++) {
			appendMessage(path[i] as SessionEntry);
		}
	}
	return items;
}
