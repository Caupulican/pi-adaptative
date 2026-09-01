import { createCustomMessage } from "./messages.ts";
import type { AgentContext, AgentMessage } from "./types.ts";

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

const TRANSIENT_RECORD_SUPERSEDING_NOTE =
	"\n\n(This record supersedes any earlier message of the same kind in this conversation. If one " +
	"appears above, it is stale - only the LAST occurrence of a given kind is current.)";

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
	 * in precedence order, reclaiming the position. The superseding note already on every record is
	 * what makes the stranded older copy safe to leave in place rather than needing removal.
	 */
	trailing?: boolean;
}

/**
 * Fast, non-cryptographic 32-bit string hash (a standard multiplicative/xor-fold shape, the same
 * technique `packages/ai/src/utils/hash.ts`'s `shortHash` uses - not imported from there because that
 * function is internal to packages/ai, never exported at its package boundary, and adding one for a
 * single caller was not worth a cross-package edit under release pressure). Deliberately NOT a
 * cryptographic hash (no sha256/node:crypto): this module sits on the provider-request path, which
 * `check:browser-smoke` bundles for a browser target, and `node:crypto` does not resolve there. The
 * property this needs is only "same content in, same value out" - collision resistance against
 * adversarial input is not being bought here and never was. Do not "upgrade" this back to sha256; it
 * will re-break the browser build.
 */
function fnv1aHash32(str: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < str.length; i++) {
		hash ^= str.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193);
	}
	return hash >>> 0;
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

/** Text of a `CustomMessage`, or undefined for the array-content shape this module never produces
 * itself but may encounter when scanning durable history for a prior instance. */
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
 * by it), and it always appends that suffix to the caller's raw content before persisting. Every
 * caller of THIS function - `resolveSlotContent` - compares the result directly against a slot's raw
 * `content`/`clearedText`, which never carries the suffix. Returning the suffixed text here made that
 * comparison compare a suffixed string against a bare one, which can never be equal - so the "content
 * unchanged, skip" path (both here and in the trailing tail-intact check) never actually fired for any
 * slot that had ever been durably written, for either the non-trailing or the trailing case: a fresh
 * copy was appended on every turn a slot had live content, regardless of whether that content had
 * actually changed. A message lacking the suffix (nothing this module wrote, in practice - defensive
 * only) is returned as-is rather than mis-stripped.
 */
function lastDurableTransientContent(messages: readonly AgentMessage[], kind: string): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "custom" && message.customType === kind) {
			const text = customMessageText(message);
			if (text === undefined) return undefined;
			return text.endsWith(TRANSIENT_RECORD_SUPERSEDING_NOTE)
				? text.slice(0, text.length - TRANSIENT_RECORD_SUPERSEDING_NOTE.length)
				: text;
		}
	}
	return undefined;
}

function buildTransientRecord(kind: string, content: string): AgentMessage {
	const text = `${content}${TRANSIENT_RECORD_SUPERSEDING_NOTE}`;
	return createCustomMessage(kind, text, false, undefined, deterministicRecordTimestamp(text));
}

/** This turn's true content for a slot: the slot's own current content, or - only on the transition
 * from active to inactive - its configured cleared text. `undefined` means genuinely nothing to say,
 * now or ever so far. */
function resolveSlotContent(
	durableMessages: readonly AgentMessage[],
	slot: TransientRecordSlot,
): { lastContent: string | undefined; nextContent: string | undefined } {
	const lastContent = lastDurableTransientContent(durableMessages, slot.kind);
	const nextContent = slot.content ?? (lastContent !== undefined ? slot.clearedText : undefined);
	return { lastContent, nextContent };
}

/**
 * Diffs each slot's current content against the last durably-recorded instance of the same kind and
 * returns ONLY the new records that need appending this turn. Callers are responsible for actually
 * committing the result into durable history (see `provider-request-planner.ts`'s accepted-request
 * commit step) - this function only decides WHAT would need to change, it never mutates
 * `durableMessages`.
 *
 * Non-trailing (informational) slots: append only when content changed - typically empty, since most
 * turns change no informational transient's content (measured: e.g. a host reflection cue that changes
 * every other turn appends on roughly half of turns, zero on the rest).
 *
 * Trailing (MUST-protocol) slots are NOT typically empty while any are active: append when content
 * changed, OR when the trailing group is not already the exact contiguous tail its active members
 * require - see `TransientRecordSlot.trailing`'s doc comment for why re-appending, not reordering, is
 * the only way to hold that invariant under append-only growth. Measured over a 15-turn run with one
 * failure/resolution cycle and ordinary tool-call growth in between (no host transients involved at
 * all): every one of the 14 turns the ledger/obligation were active fired a trailing re-append; 12 of
 * those 14 had genuinely unchanged content and fired ONLY because ordinary turn growth (the assistant
 * reply and tool result from the previous turn) had been appended after them. This is not a host-
 * transient-volatility effect - it reproduced identically with zero host transients present.
 */
export function reconcileTransientRecords(
	durableMessages: readonly AgentMessage[],
	slots: readonly TransientRecordSlot[],
): AgentMessage[] {
	const newRecords: AgentMessage[] = [];
	for (const slot of slots) {
		if (slot.trailing) continue;
		const { lastContent, nextContent } = resolveSlotContent(durableMessages, slot);
		if (nextContent === undefined || nextContent === lastContent) continue;
		newRecords.push(buildTransientRecord(slot.kind, nextContent));
	}

	const trailingSlots = slots.filter((slot) => slot.trailing);
	const trailingState = trailingSlots.map((slot) => ({ slot, ...resolveSlotContent(durableMessages, slot) }));
	// A cleared slot is a fixed point of `resolveSlotContent`: once `lastContent` durably equals
	// `slot.clearedText`, an inactive slot (`slot.content === undefined`) resolves `nextContent` to
	// that SAME `clearedText` forever after - so `nextContent !== undefined` alone would keep a slot
	// that cleared once eligible for trailing reclaim for the rest of the conversation. What actually
	// needs the trailing position protected is narrower: the slot is presently live (`slot.content`
	// defined), OR this is the one turn where it is transitioning to cleared (`nextContent !==
	// lastContent`, true only on that turn, false at the fixed point). A slot that is fully settled
	// into "cleared" drops out here and stops being reclaimed, exactly like the non-trailing path's
	// `nextContent === lastContent` skip above.
	const active = trailingState.filter(
		(entry): entry is typeof entry & { nextContent: string } =>
			entry.nextContent !== undefined &&
			(entry.slot.content !== undefined || entry.nextContent !== entry.lastContent),
	);
	if (active.length > 0) {
		// Informational appends above (`newRecords` so far) are also "something appended after" from
		// the trailing group's point of view, so they must count as part of the array being checked.
		const provisional = [...durableMessages, ...newRecords];
		const actualTailKinds = provisional
			.slice(-active.length)
			.map((message) => (message.role === "custom" ? message.customType : undefined));
		const expectedTailKinds = active.map((entry) => entry.slot.kind);
		const tailIntact =
			actualTailKinds.length === expectedTailKinds.length &&
			expectedTailKinds.every((kind, index) => kind === actualTailKinds[index]);
		const anyContentChanged = active.some((entry) => entry.nextContent !== entry.lastContent);
		if (!tailIntact || anyContentChanged) {
			for (const entry of active) newRecords.push(buildTransientRecord(entry.slot.kind, entry.nextContent));
		}
	}

	return newRecords;
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
 * with string content is returned in `passThrough` instead: appended fresh to the WIRE payload every
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
		const text = customMessageText(message);
		if (message.role === "custom" && text !== undefined) {
			slots.push({ kind: message.customType, content: text });
		} else {
			passThrough.push(message);
		}
	}
	return { slots, passThrough };
}
