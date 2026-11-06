/**
 * Where a message that can open or steer a turn came from, recorded where it enters the session and never classified
 * afterwards. The set is closed: every wake path maps to one kind (see `core/turn-origin.ts`, which derives the kind of
 * an unstamped message from the identity it already carries). A stamp is written only where no such identity exists: a
 * user message an extension delivers on behalf of a third party.
 *
 * It follows the worker-control design: a non-enumerable stamp on the message object that never reaches a serialized
 * message or a provider request; the session manager writes it on the message's entry (`SessionMessageEntry.turnOrigin`)
 * and rebuilds the stamp when it rebuilds a context, so replay, fork and resume keep it.
 */

import type { AgentMessage } from "./types.ts";

export type TurnOriginKind =
	| "owner-typed"
	| "extension-message"
	| "routine"
	| "host-event"
	| "peer-agent"
	| "inbound-channel"
	| "worker-result"
	| "goal-continuation"
	| "proactive-review"
	| "harness";

export interface TurnOriginRecord {
	readonly v: 1;
	readonly k: TurnOriginKind;
	/** The extension channel that delivered the words (`pi-chat`). */
	readonly channel?: string;
	/** The channel's broker verified which session sent them; it does not make the words the owner's. */
	readonly verified?: true;
	/** The words were authored by someone other than the owner or the owner's own code. */
	readonly thirdParty?: true;
	/** The sender's own id for this delivery (a channel's batch id), so it finds the turn that carried it. */
	readonly ref?: string;
}

const MAX_CHANNEL_CHARS = 128;
export const MAX_TURN_ORIGIN_REF_CHARS = 128;
const TURN_ORIGIN_KINDS: ReadonlySet<unknown> = new Set<TurnOriginKind>([
	"owner-typed",
	"extension-message",
	"routine",
	"host-event",
	"peer-agent",
	"inbound-channel",
	"worker-result",
	"goal-continuation",
	"proactive-review",
	"harness",
]);
const TURN_ORIGIN = Symbol("pi.turnOrigin");

/** The record an entry names when it cannot be read: third-party, so an unreadable origin never gains authority. */
export const UNREADABLE_TURN_ORIGIN: TurnOriginRecord = { v: 1, k: "inbound-channel", thirdParty: true };

/** Reads a record from a persisted entry or any foreign value, rebuilt field by field; `undefined` when malformed. */
export function parseTurnOriginRecord(value: unknown): TurnOriginRecord | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.v !== 1 || !TURN_ORIGIN_KINDS.has(record.k)) return undefined;
	if (
		record.channel !== undefined &&
		(typeof record.channel !== "string" || record.channel.length === 0 || record.channel.length > MAX_CHANNEL_CHARS)
	)
		return undefined;
	if (record.verified !== undefined && record.verified !== true) return undefined;
	if (record.thirdParty !== undefined && record.thirdParty !== true) return undefined;
	if (
		record.ref !== undefined &&
		(typeof record.ref !== "string" || record.ref.length === 0 || record.ref.length > MAX_TURN_ORIGIN_REF_CHARS)
	)
		return undefined;
	return {
		v: 1,
		k: record.k as TurnOriginKind,
		...(record.channel !== undefined ? { channel: record.channel as string } : {}),
		...(record.verified === true ? { verified: true as const } : {}),
		...(record.thirdParty === true ? { thirdParty: true as const } : {}),
		...(record.ref !== undefined ? { ref: record.ref as string } : {}),
	};
}

/** Stamps `message` with its origin. A message carries one origin, once. */
export function stampTurnOrigin(message: AgentMessage, record: TurnOriginRecord): void {
	const parsed = parseTurnOriginRecord(record);
	if (!parsed) throw new TypeError("A turn origin record is invalid.");
	const current = turnOriginStampOf(message);
	if (current !== undefined) {
		if (JSON.stringify(current) === JSON.stringify(parsed)) return;
		throw new Error(`A message already carries turn origin ${current.k}; it cannot carry ${parsed.k}.`);
	}
	Object.defineProperty(message, TURN_ORIGIN, {
		value: parsed,
		enumerable: false,
		writable: false,
		configurable: false,
	});
}

/** The origin `message` was stamped with, if it was stamped. */
export function turnOriginStampOf(message: object): TurnOriginRecord | undefined {
	return parseTurnOriginRecord(Reflect.get(message, TURN_ORIGIN));
}
