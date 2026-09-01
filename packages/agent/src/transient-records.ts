import { createCustomMessage } from "./messages.ts";
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
 */
function lastDurableTransientContent(messages: readonly AgentMessage[], kind: string): string | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "custom" && message.customType === kind) return customMessageText(message);
	}
	return undefined;
}

/**
 * Diffs each slot's current content against the last durably-recorded instance of the same kind and
 * returns ONLY the new records that need appending this turn - typically empty. Callers are
 * responsible for actually committing the result into durable history (see
 * `provider-request-planner.ts`'s accepted-request commit step) - this function only decides WHAT
 * would need to change, it never mutates `durableMessages`.
 */
export function reconcileTransientRecords(
	durableMessages: readonly AgentMessage[],
	slots: readonly TransientRecordSlot[],
): AgentMessage[] {
	const newRecords: AgentMessage[] = [];
	for (const slot of slots) {
		const lastContent = lastDurableTransientContent(durableMessages, slot.kind);
		const nextContent = slot.content ?? (lastContent !== undefined ? slot.clearedText : undefined);
		if (nextContent === undefined || nextContent === lastContent) continue;
		const text = `${nextContent}${TRANSIENT_RECORD_SUPERSEDING_NOTE}`;
		newRecords.push(createCustomMessage(slot.kind, text, false, undefined, deterministicRecordTimestamp(text)));
	}
	return newRecords;
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
