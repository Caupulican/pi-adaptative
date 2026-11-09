import type { AgentContext } from "./loop-config.ts";
import { createCustomMessage } from "./messages.ts";
import {
	decideTransientRecord,
	fnv1aHash32,
	type TransientRecordDecision,
	type TransientRecordFacts,
	type TransientRecordVerdict,
	transientRecordDigest,
} from "./transient-record-decision.ts";
import type { AgentMessage } from "./types.ts";

/**
 * Append-on-change transient records (turn-economics remediation, A1 extended).
 *
 * Until this module existed, every transient (the tool-failure ledger, the verification-obligation
 * instruction, and host-owned ones like the reflection cue and the path-alias legend) was rebuilt and
 * re-appended at the tail of every single provider request. Because new durable content is inserted
 * BEFORE that tail on the next turn, the whole trailing region slides forward every turn - the exact
 * displacement `messagesPreserveCachedPrefix` and `getCachedWebSocketInputDelta` both measure against
 * (packages/ai/src/providers/openai-codex-responses.ts, read-only from here), which is why the
 * provider's prompt/websocket cache never engaged past turn 1 (see the Task 10 diagnosis).
 *
 * The fix: a transient kind is appended to durable history ONLY when its content differs from the
 * last instance of that same kind already appended - never rewritten, never repositioned, never
 * removed. Once appended, a record is a completely ordinary durable message from every other
 * consumer's point of view (compaction, host context-GC, the pack-freeze horizon); nothing here
 * grants it special permanence. Most turns append nothing, since most turns change no transient's
 * content - this is what makes the growth cheap (the alternative, appending fresh copies every turn
 * regardless of change, would cost MORE than the full resend it replaces for a large transient like
 * the path-alias legend).
 */

export const TRANSIENT_RECORD_SUPERSEDING_NOTE =
	"\n\n(This record supersedes any earlier message of the same kind in this conversation. If one " +
	"appears above, it is stale - only the LAST occurrence of a given kind is current.)";

/**
 * `details` a host puts on a transient `custom` message to say "this kind currently has nothing
 * active to say; if an instance of it is on record, append THIS text once to clear it". Adapted by
 * `adaptHostTransients` into a slot with `content: undefined` and the message text as
 * `clearedText`, so a host reuses the same reconciliation index as the kernel's own kinds instead
 * of scanning history itself to learn whether a record of the kind ever existed. The message text
 * never reaches the wire on its own: it is recorded only as that one cleared record.
 */
export const HOST_TRANSIENT_CLEARED_DETAILS = { transientCleared: true } as const;

/** A live projection belongs only to this request, never to durable history or later compactions. */
export const HOST_REQUEST_ONLY_DETAILS = { requestOnly: true } as const;

function isClearedHostTransient(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		typeof message.details === "object" &&
		message.details !== null &&
		(message.details as { transientCleared?: unknown }).transientCleared === true
	);
}

/**
 * One transient's current state for this request, keyed by a stable identity (`kind`) that must
 * never change across the life of a conversation for a given transient - it is the join key against
 * durable history, not a display label.
 */
export interface TransientRecordSlot {
	/** Stable kind identity. Doubles as the durable record's `CustomMessage.customType`. */
	kind: string;
	/** Current true content, or `undefined` when this kind currently has nothing active to say. */
	content: string | undefined;
	/**
	 * Text to durably record the moment `content` transitions from defined to `undefined` (a
	 * resolution/clearing event). Required for any kind whose disappearance is itself meaningful to
	 * the model (the tool-failure ledger, a verification obligation): under append-on-change, silence
	 * is indistinguishable from "unchanged, still active" - without an explicit cleared record, a
	 * stale active instance earlier in history would keep reading as current forever. Omit only for a
	 * kind that is monotonic (once it has content it never reverts to undefined) or whose absence
	 * carries no instruction either way - see `adaptHostTransients` below for why host-owned kinds
	 * default to omitting it.
	 */
	clearedText?: string;
	/**
	 * Marks a MUST-protocol kind that must occupy the trailing region - the literal end of the sent
	 * sequence - whenever it is active, matching the salience the pre-append-on-change design gave the
	 * failure ledger and verification obligation by rebuilding them last on every request (see the old
	 * trailing-region comment this replaces). Precedence among trailing slots is their ORDER in the
	 * `slots` array passed to `reconcileTransientRecords`: earlier trailing slots sit closer to the
	 * front of the trailing group, the last one is the very last message.
	 *
	 * Append-only and "always last" are in real tension - a record is written once and never
	 * repositioned, so the instant anything is appended after a trailing record, it is no longer last,
	 * permanently. The resolution is re-append, not reposition: whenever the trailing group's records
	 * are not the exact contiguous tail they need to be (something else was appended after them, this
	 * turn or several turns ago), every currently-active trailing slot gets a fresh instance appended,
	 * in precedence order, reclaiming the position: its full record when its own content changed, else a
	 * pointer naming the full record above. The superseding note already on every record is what makes
	 * the stranded older copy safe to leave in place rather than needing removal.
	 */
	trailing?: boolean;
	/**
	 * A cumulative kind: every record of it stays current and each new record only adds to the
	 * earlier ones (the path-alias legend delta). Such records carry no superseding note, are never
	 * packed as superseded, and a new record is appended whenever the host offers new content.
	 */
	cumulative?: boolean;
	/**
	 * The canonical typed record this slot's `content` renders (`{v, k, ...}`), carried into the durable
	 * record's `details.record` so a consumer or a human view reads the fact, never the rendering. The
	 * content must be a total function of it: reconciliation appends on a text change only.
	 */
	record?: TransientRecordPayload;
	/**
	 * The record's one-line name, rendered by the slot's producer from the same fact as `content`. A pointer that
	 * reclaims the trailing position repeats it (bounded), so only trailing slots need one; absent, the pointer
	 * names the kind.
	 */
	header?: string;
	/**
	 * The content's identity for change detection, when the producer knows a narrower one than the text (the failure
	 * ledger: its active set and required actions, not its counters). Stored as the full record's `details.digest`;
	 * absent, the digest of `content` itself.
	 */
	digest?: string;
}

/** A canonical machine record in a transient record's `details.record`: a version and a kind, then its fields. */
export interface TransientRecordPayload {
	readonly v: number;
	readonly k: string;
}

/** The typed record a transient record (or a host transient offered as one) carries in `details.record`, if any. */
export function readTransientRecordPayload(details: unknown): TransientRecordPayload | undefined {
	if (typeof details !== "object" || details === null) return undefined;
	const record = (details as { record?: unknown }).record;
	if (typeof record !== "object" || record === null) return undefined;
	const { v, k } = record as { v?: unknown; k?: unknown };
	return typeof v === "number" && typeof k === "string" ? (record as TransientRecordPayload) : undefined;
}

/** Marks a record as a pointer ("unchanged, see above") so content comparison ignores it. */
const POINTER_RECORD_DETAILS = { pointer: true } as const;

/**
 * `details.superseding` on a plain (non-cumulative) transient record: its content is the producer's content
 * followed by {@link TRANSIENT_RECORD_SUPERSEDING_NOTE}, written by `buildTransientRecord`. The note is the
 * model's view of that fact; this marker is the harness's.
 */
function isSupersedingRecordDetails(details: unknown): boolean {
	return (
		typeof details === "object" && details !== null && (details as { superseding?: unknown }).superseding === true
	);
}

/**
 * A pointer record ("unchanged, see the last full record above"). A pointer never supersedes the full record it names:
 * context GC must keep that record as the kind's current one, or the pointer would point at a packed stub.
 */
export function isTransientPointerRecord(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		typeof message.details === "object" &&
		message.details !== null &&
		(message.details as { pointer?: unknown }).pointer === true
	);
}

function isCumulativeTransient(message: AgentMessage): boolean {
	return (
		message.role === "custom" &&
		typeof message.details === "object" &&
		message.details !== null &&
		(message.details as { cumulative?: unknown }).cumulative === true
	);
}

/**
 * A pointer record naming its kind by the slot's header (the producer's current one-line name, so counters that do
 * not change what the model must do still read current), bounded to 80 characters.
 */
function buildPointerRecord(kind: string, header: string): AgentMessage {
	const name = header.length > 80 ? `${header.slice(0, 77)}...` : header;
	const text = `${name}; nothing to act on changed since the last full record of this kind above, which is current.`;
	return createCustomMessage(kind, text, false, POINTER_RECORD_DETAILS, deterministicRecordTimestamp(text));
}

/**
 * Deterministic stand-in for a wall-clock timestamp, content-derived so a byte-identical record
 * always serializes to byte-identical bytes no matter when it is (re)computed. Mirrors
 * packages/coding-agent/src/core/provider-request-context-controller.ts's
 * `deterministicTransientTimestamp` (read-only reference, not imported - that file is outside this
 * package) for the identical reason: these records are synthesized, not real events, and a
 * `Date.now()` read would make an otherwise-unchanged record differ from itself across an
 * idempotent-reconciliation retry within the same request-admission loop. The hash is a 32-bit
 * unsigned integer (0 to 4,294,967,295), always a valid, in-range millisecond-since-epoch value for
 * `Date` - no bounds check needed the way a wider or unbounded hash would require.
 */
function deterministicRecordTimestamp(content: string): string {
	return new Date(fnv1aHash32(content)).toISOString();
}

/**
 * Whether a persisted custom record was written by this module (a transient record): `details.superseding`
 * marks a plain record, `details.cumulative` a cumulative one; pointer records are excluded, as
 * `transientContentIndex` excludes them. The session context builder uses this to carry the current
 * record of each kind across a compaction cut: without it every kind is re-appended on the first
 * request after compaction (measured on a live session: the skill context re-sent 75 times for 7
 * distinct contents, the legend 256 times).
 */
export function classifyTransientRecord(
	content: unknown,
	details: unknown,
): { transient: boolean; cumulative: boolean } {
	const cumulative =
		typeof details === "object" && details !== null && (details as { cumulative?: unknown }).cumulative === true;
	const pointer =
		typeof details === "object" && details !== null && (details as { pointer?: unknown }).pointer === true;
	if (pointer) return { transient: false, cumulative: false };
	if (cumulative) return { transient: true, cumulative: true };
	if (isSupersedingRecordDetails(details)) return { transient: true, cumulative: false };
	return {
		// comms-legacy-decoder: plain records persisted before `details.superseding` existed are known only by the note.
		transient: typeof content === "string" && content.endsWith(TRANSIENT_RECORD_SUPERSEDING_NOTE),
		cumulative: false,
	};
}

/** Text of a `CustomMessage`, or undefined for the array-content shape this module never produces itself. */
function customMessageText(message: AgentMessage): string | undefined {
	if (message.role !== "custom") return undefined;
	return typeof message.content === "string" ? message.content : undefined;
}

/**
 * Most recent durably-recorded content for `kind`, or undefined if no instance has ever been
 * appended. Transient records are appended-only (never rewritten, moved, or removed by this module),
 * so the last one found scanning backward is always the current one by construction.
 *
 * Strips `TRANSIENT_RECORD_SUPERSEDING_NOTE` back off before returning: `buildTransientRecord` is the
 * only writer of a record this function can find (every durable instance of a given `kind` was built
 * by it), and it always appends that suffix to the caller's raw content before persisting. Its digest
 * (`recordedTransient`) is compared directly against a slot's raw `content`/`clearedText`, which never
 * carries the suffix. Returning the suffixed text here made that
 * comparison compare a suffixed string against a bare one, which can never be equal - so the "content
 * unchanged, skip" path (both here and in the trailing tail-intact check) never actually fired for any
 * slot that had ever been durably written, for either the non-trailing or the trailing case: a fresh
 * copy was appended on every turn a slot had live content, regardless of whether that content had
 * actually changed. A record marked `details.superseding` carries the suffix by construction; the
 * reconciliation base is the durable (never GC-packed) form, so its content is exactly that. Any other
 * custom message (a cumulative record, a host page this module did not write) is returned as-is.
 */
function durableTransientContent(message: AgentMessage): string | undefined {
	if (message.role !== "custom" || typeof message.content !== "string") return undefined;
	const text = message.content;
	if (isSupersedingRecordDetails(message.details)) {
		return text.slice(0, text.length - TRANSIENT_RECORD_SUPERSEDING_NOTE.length);
	}
	// comms-legacy-decoder: plain records persisted before `details.superseding` existed are known only by the note.
	return text.endsWith(TRANSIENT_RECORD_SUPERSEDING_NOTE)
		? text.slice(0, text.length - TRANSIENT_RECORD_SUPERSEDING_NOTE.length)
		: text;
}

/** The last full (non-pointer) record of one kind in a history, as reconciliation compares against it. */
interface RecordedTransient {
	/** Its content without the superseding note; undefined for a record without string content. */
	readonly content: string | undefined;
	/** `details.digest` when the producer stored one, else the digest of `content`. */
	readonly digest: string | undefined;
	/** Its timestamp: content-derived, so the planned copy of the same record carries the same one. */
	readonly timestamp: number;
}

function recordedTransient(message: Extract<AgentMessage, { role: "custom" }>): RecordedTransient {
	const content = durableTransientContent(message);
	const stored =
		typeof message.details === "object" && message.details !== null
			? (message.details as { digest?: unknown }).digest
			: undefined;
	return {
		content,
		digest: typeof stored === "string" ? stored : content === undefined ? undefined : transientRecordDigest(content),
		timestamp: message.timestamp,
	};
}

/**
 * Last durable record per kind, maintained incrementally. Each request reconciles every
 * slot against history, and a kind with no record yet (a session with no failure so far, for the
 * ledger) walked the whole history backwards on every request to learn that. The index is keyed by
 * the history's first message and is valid while the history it reflects is the same objects in the
 * same order (checked by reference); a history that changed underneath is indexed from the start.
 */
interface TransientContentIndex {
	count: number;
	processed: AgentMessage[];
	byKind: Map<string, RecordedTransient>;
}
const transientContentIndexes = new WeakMap<AgentMessage, TransientContentIndex>();

function transientContentIndex(messages: readonly AgentMessage[]): ReadonlyMap<string, RecordedTransient> {
	const first = messages[0];
	if (!first) return new Map();
	let index = transientContentIndexes.get(first);
	let from = 0;
	if (index && index.count <= messages.length) {
		from = index.count;
		for (let position = 0; position < from; position++) {
			if (index.processed[position] !== messages[position]) {
				index = undefined;
				from = 0;
				break;
			}
		}
	} else {
		index = undefined;
	}
	if (!index) {
		index = { count: 0, processed: [], byKind: new Map() };
		transientContentIndexes.set(first, index);
	}
	for (let position = from; position < messages.length; position++) {
		const message = messages[position];
		if (message.role === "custom" && !isTransientPointerRecord(message)) {
			index.byKind.set(message.customType, recordedTransient(message));
		}
	}
	if (from < messages.length) {
		index.processed = messages.slice();
		index.count = messages.length;
	}
	return index.byKind;
}

function buildTransientRecord(
	kind: string,
	content: string,
	cumulative = false,
	record?: TransientRecordPayload,
	digest?: string,
): AgentMessage {
	if (cumulative) {
		return createCustomMessage(
			kind,
			content,
			false,
			{ cumulative: true, ...(record ? { record } : {}) },
			deterministicRecordTimestamp(content),
		);
	}
	const text = `${content}${TRANSIENT_RECORD_SUPERSEDING_NOTE}`;
	return createCustomMessage(
		kind,
		text,
		false,
		{ superseding: true, ...(record ? { record } : {}), ...(digest ? { digest } : {}) },
		deterministicRecordTimestamp(text),
	);
}

/**
 * The kinds (of `wanted`, by the timestamp of their last durable record) whose last record the planned request still
 * carries in full: the last non-pointer record of the kind in `planned` is that same record (same content-derived
 * timestamp) and still ends with the superseding note, which packing and truncation remove and path aliasing keeps.
 * Read backward and stopped once every wanted kind is resolved.
 */
function visibleRecordKinds(
	planned: readonly AgentMessage[],
	wanted: ReadonlyMap<string, number>,
): ReadonlySet<string> {
	const visible = new Set<string>();
	const remaining = new Map(wanted);
	for (let position = planned.length - 1; position >= 0 && remaining.size > 0; position--) {
		const message = planned[position];
		if (message?.role !== "custom" || isTransientPointerRecord(message)) continue;
		const timestamp = remaining.get(message.customType);
		if (timestamp === undefined) continue;
		remaining.delete(message.customType);
		if (
			message.timestamp === timestamp &&
			typeof message.content === "string" &&
			// comms-legacy-decoder: context GC and truncation rewrite a record's content and keep its details, so the lost note is the only signal that a request no longer carries the record in full.
			message.content.endsWith(TRANSIENT_RECORD_SUPERSEDING_NOTE)
		) {
			visible.add(message.customType);
		}
	}
	return visible;
}

/** What one reconciliation appends, and the decision behind every non-cumulative slot. */
export interface TransientRecordReconciliation {
	readonly records: AgentMessage[];
	readonly decisions: TransientRecordDecision[];
}

/**
 * Decides, per slot, what this request appends (see `decideTransientRecord` for the ordered rules) and returns ONLY
 * the new records. Callers are responsible for actually committing the result into durable history (see
 * `provider-request-planner.ts`'s accepted-request commit step) - this function never mutates `durableMessages`.
 *
 * `durableMessages` is the history the request's wire is built from (the durable form records were committed in);
 * `planned` is the request's planned messages after context GC, enforcement and any projection. A record the plan
 * no longer carries in full reads as not visible and is sent again in full: the one fact that covers a compaction,
 * a GC pack and a projection that dropped it.
 *
 * Non-trailing (informational) slots append only when their content digest changed or the last record is not
 * visible; unchanged and visible appends nothing, which is cheaper than any pointer.
 *
 * Trailing (MUST-protocol) slots must stay the exact contiguous tail while active - see
 * `TransientRecordSlot.trailing`'s doc comment for why re-appending, not reordering, is the only way to hold that
 * invariant under append-only growth. Whenever the group lost the tail (ordinary turn growth, an informational
 * append, or one trailing member appending a full record), every member re-appends: a member whose own content
 * changed (or is not visible) appends its full record, every other member a pointer. An unchanged member is never
 * re-sent in full because a sibling changed.
 *
 * Cumulative slots (each record adds to the earlier ones) append whenever the host offers content that differs from
 * the last record; the host already offers only what the wire lacks.
 */
export function reconcileTransientRecords(
	durableMessages: readonly AgentMessage[],
	slots: readonly TransientRecordSlot[],
	planned: readonly AgentMessage[],
): TransientRecordReconciliation {
	const recorded = transientContentIndex(durableMessages);
	const nextDigest = (slot: TransientRecordSlot): string | undefined =>
		slot.content === undefined ? undefined : (slot.digest ?? transientRecordDigest(slot.content));
	const wanted = new Map<string, number>();
	for (const slot of slots) {
		const last = recorded.get(slot.kind);
		if (slot.cumulative || last?.digest === undefined || last.digest !== nextDigest(slot)) continue;
		wanted.set(slot.kind, last.timestamp);
	}
	const visible = visibleRecordKinds(planned, wanted);
	const factsFor = (slot: TransientRecordSlot, tailNeedsReclaim: boolean): TransientRecordFacts => {
		const lastDigest = recorded.get(slot.kind)?.digest;
		return {
			active: slot.content !== undefined,
			hasClearedText: slot.clearedText !== undefined,
			lastDigest,
			lastIsCleared: slot.clearedText !== undefined && lastDigest === transientRecordDigest(slot.clearedText),
			nextDigest: nextDigest(slot),
			lastVisible: visible.has(slot.kind),
			trailing: slot.trailing === true,
			tailNeedsReclaim,
		};
	};
	const records: AgentMessage[] = [];
	const decisions: TransientRecordDecision[] = [];
	const apply = (slot: TransientRecordSlot, verdict: TransientRecordVerdict): void => {
		let record: AgentMessage | undefined;
		let digest = nextDigest(slot);
		if (verdict.action === "full" && slot.content !== undefined) {
			record = buildTransientRecord(slot.kind, slot.content, false, slot.record, digest);
		} else if (verdict.action === "cleared" && slot.clearedText !== undefined) {
			digest = transientRecordDigest(slot.clearedText);
			record = buildTransientRecord(slot.kind, slot.clearedText, false, undefined, digest);
		} else if (verdict.action === "pointer") {
			record = buildPointerRecord(slot.kind, slot.header ?? slot.kind);
		}
		if (record) records.push(record);
		decisions.push({
			kind: slot.kind,
			...verdict,
			digest: verdict.action === "none" ? undefined : digest,
			chars: record ? (customMessageText(record)?.length ?? 0) : 0,
			trailing: slot.trailing === true,
		});
	};

	for (const slot of slots) {
		if (slot.trailing) continue;
		if (slot.cumulative) {
			if (slot.content !== undefined && slot.content !== recorded.get(slot.kind)?.content) {
				records.push(buildTransientRecord(slot.kind, slot.content, true, slot.record));
			}
			continue;
		}
		apply(slot, decideTransientRecord(factsFor(slot, false)));
	}

	const trailing = slots
		.filter((slot) => slot.trailing)
		.map((slot) => ({ slot, verdict: decideTransientRecord(factsFor(slot, false)) }));
	// The members that must hold the tail: every active member, and one transitioning to its cleared record on the
	// request it does so. A member settled into "cleared" (or never recorded) holds nothing and drops out.
	const holders = trailing.filter(
		(entry) => entry.verdict.action !== "none" && entry.verdict.rule !== "inactive_settled",
	);
	if (holders.length > 0) {
		// Informational appends above are also "something appended after" from the trailing group's point of view.
		// The tail of history-plus-new-records, read in place: copying the whole history to slice its last few
		// entries was an O(history) allocation on nearly every request.
		const provisionalLength = durableMessages.length + records.length;
		const actualTailKinds: Array<string | undefined> = [];
		for (let position = Math.max(0, provisionalLength - holders.length); position < provisionalLength; position++) {
			const message =
				position < durableMessages.length ? durableMessages[position] : records[position - durableMessages.length];
			actualTailKinds.push(message?.role === "custom" ? message.customType : undefined);
		}
		const tailIntact =
			actualTailKinds.length === holders.length &&
			holders.every((entry, index) => entry.slot.kind === actualTailKinds[index]);
		const tailNeedsReclaim =
			!tailIntact || holders.some((entry) => entry.verdict.action === "full" || entry.verdict.action === "cleared");
		for (const entry of trailing) {
			apply(
				entry.slot,
				tailNeedsReclaim && holders.includes(entry)
					? decideTransientRecord(factsFor(entry.slot, true))
					: entry.verdict,
			);
		}
	} else {
		for (const entry of trailing) apply(entry.slot, entry.verdict);
	}

	return { records, decisions };
}

/**
 * The ONLY way `pendingRecords` (a `reconcileTransientRecords` result) may be committed into durable
 * history: folds them into `sourceContext.messages` AND announces the commit via `onCommitted` in
 * the SAME call, so the two representations can never drift apart the way they once did. Before the
 * turn-economics remediation's host-gap hook existed, `agentLoop`'s own `newMessages` return value
 * (and the `message_start`/`message_end` events a host's persistence listens to) silently disagreed
 * with what got folded into `sourceContext.messages` - harmless until a worker-conversation
 * consistency check started comparing the two (see AGENTS.md's "Delegation and Orchestration"
 * section for the bug that produced). That gap existed because committing into `sourceContext` and
 * recording the commit were two separate statements a future edit could pull apart, or a new call
 * site could add without knowing it needed both. Fixing the specific bug did not remove that hazard
 * for the NEXT caller - this function does: there is exactly one way to commit a transient record,
 * and it always does both halves.
 *
 * Returns `sourceContext` BY REFERENCE, unchanged, when there is nothing to commit -
 * `provider-request-planner.ts`'s `adoptReplannedMessages` relies on reference (in)equality to know
 * whether a sync is needed, so this must never allocate a new object on a no-op call.
 */
export async function commitTransientRecords(
	sourceContext: AgentContext,
	pendingRecords: AgentMessage[],
	onCommitted: ((records: AgentMessage[]) => void | Promise<void>) | undefined,
): Promise<AgentContext> {
	if (pendingRecords.length === 0) return sourceContext;
	const committed: AgentContext = { ...sourceContext, messages: [...sourceContext.messages, ...pendingRecords] };
	await onCommitted?.(pendingRecords);
	return committed;
}

/**
 * Adapts host-contributed transients (`AgentContextPlan.transientMessages`, e.g. the reflection cue
 * or path-alias legend from packages/coding-agent's ProviderRequestContextController - read-only
 * reference, not imported) into append-on-change slots.
 *
 * Only a `role: "custom"` message carries a stable, host-assigned kind identity (`customType`) safe
 * to dedupe against; a message array's POSITION is not safe (a host may contribute a variable number
 * of transients turn to turn as different extensions activate, shifting everything after them - see
 * the investigation note in `provider-request-planner.ts`). Anything not shaped as a `CustomMessage`
 * with string content, or explicitly marked `HOST_REQUEST_ONLY_DETAILS`, is returned in `passThrough`
 * instead: appended fresh to the WIRE payload every
 * request exactly as before this module existed, never written into durable history. This is
 * correct-but-unoptimized for that shape rather than either dropping it (would silently lose content)
 * or guessing at a durable identity for it (would risk conflating two unrelated host transients that
 * happen to share position).
 *
 * No `clearedText` is synthesized for a host kind that disappears from `transientMessages`: only the
 * host that renders a kind's content knows what, if anything, its disappearance should say, and
 * inventing text on its behalf risks asserting something the host never intended. The stale record
 * simply stays in durable history, unchanged - harmless for cue/reference material, unlike a
 * verification obligation (this module's own kind, given `clearedText` explicitly), where an
 * unresolved-looking stale record left unclarified would misdirect the model into thinking work
 * remains outstanding.
 */
export function adaptHostTransients(transientMessages: readonly AgentMessage[]): {
	slots: TransientRecordSlot[];
	passThrough: AgentMessage[];
} {
	const slots: TransientRecordSlot[] = [];
	const passThrough: AgentMessage[] = [];
	for (const message of transientMessages) {
		if (
			message.role === "custom" &&
			typeof message.details === "object" &&
			message.details !== null &&
			(message.details as { requestOnly?: unknown }).requestOnly === true
		) {
			passThrough.push(message);
			continue;
		}
		const text = customMessageText(message);
		if (message.role === "custom" && text !== undefined) {
			if (isClearedHostTransient(message)) {
				slots.push({ kind: message.customType, content: undefined, clearedText: text });
				continue;
			}
			const record = readTransientRecordPayload(message.details);
			slots.push({
				kind: message.customType,
				content: text,
				...(isCumulativeTransient(message) ? { cumulative: true } : {}),
				...(record ? { record } : {}),
			});
		} else {
			passThrough.push(message);
		}
	}
	return { slots, passThrough };
}
