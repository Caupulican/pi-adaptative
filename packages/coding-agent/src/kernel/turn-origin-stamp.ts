/**
 * Where a message that can open or steer a turn came from, recorded where it enters the session and never classified
 * afterwards. The set is closed: every wake path maps to one kind (see `core/turn-origin.ts`, which derives the kind of
 * an unstamped message from the identity it already carries). A stamp is written only where no such identity exists: a
 * user message an extension delivers on behalf of a third party, or one the channels core delivers for an owner channel
 * (the owner's own listed identity on a platform chat). An `owner-channel` record that is missing its verification, its
 * channel or its reference does not parse, so it reads as unreadable, which is third-party. An `agent-mail` record (one
 * agent's mail to another, minted only by the bot host) names its sender and its place in the chain of mails (`from`,
 * `hop`) and never a third party: mail a third party's words reached is recorded as an `inbound-channel` record that
 * carries the same two fields. A build that does not know the kind reads its record as unreadable, which is third-party.
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
	| "owner-channel"
	| "worker-result"
	| "goal-continuation"
	| "proactive-review"
	| "harness"
	| "agent-mail";

export interface TurnOriginRecord {
	readonly v: 1;
	readonly k: TurnOriginKind;
	/** The extension channel that delivered the words (`pi-chat`), or the channel an `owner-channel` message arrived on. */
	readonly channel?: string;
	/**
	 * The channel's broker verified which session sent them; it does not make the words the owner's. On an `owner-channel`
	 * record it states that the channels core verified the sender against the owner's own list, and it is required.
	 */
	readonly verified?: true;
	/** The words were authored by someone other than the owner or the owner's own code. */
	readonly thirdParty?: true;
	/** The sender's own id for this delivery (a channel's batch id), so it finds the turn that carried it. */
	readonly ref?: string;
	/** Scheduled occurrence selected by the verified owner whose phone command opened this turn. */
	readonly routineRef?: string;
	/**
	 * The third party's words as the owner reads them, without the frame written for the model. The screen shows this, never
	 * the framed text.
	 */
	readonly shown?: string;
	/** Mail only: who sent it, as the host addresses its sender (`bot:<id>`, `root:<session id>`, `group:<id>:<incarnation>`). */
	readonly from?: string;
	/** Mail only: its place in its chain of mails, from 1 (the first mail after words from outside the agents) to `MAX_TURN_ORIGIN_HOP`. */
	readonly hop?: number;
}

export function isRoutineBotOccurrenceRef(value: unknown): value is string {
	return typeof value === "string" && /^routine:[a-f0-9]{32}$/.test(value);
}

export const MAX_TURN_ORIGIN_CHANNEL_CHARS = 128;
export const MAX_TURN_ORIGIN_REF_CHARS = 128;
export const MAX_TURN_ORIGIN_SHOWN_CHARS = 4000;
export const MAX_TURN_ORIGIN_FROM_CHARS = 320;
/** The longest chain of mails one agent's words may start: a mail past it is never sent. */
export const MAX_TURN_ORIGIN_HOP = 8;
const TURN_ORIGIN_KINDS: ReadonlySet<unknown> = new Set<TurnOriginKind>([
	"owner-typed",
	"extension-message",
	"routine",
	"host-event",
	"peer-agent",
	"inbound-channel",
	"owner-channel",
	"worker-result",
	"goal-continuation",
	"proactive-review",
	"harness",
	"agent-mail",
]);
/** The extension chat mesh is a third party's channel and can never be an owner channel. */
const PEER_CHAT_CHANNEL = "pi-chat";
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
		(typeof record.channel !== "string" ||
			record.channel.length === 0 ||
			record.channel.length > MAX_TURN_ORIGIN_CHANNEL_CHARS)
	)
		return undefined;
	if (record.verified !== undefined && record.verified !== true) return undefined;
	if (record.thirdParty !== undefined && record.thirdParty !== true) return undefined;
	if (
		record.ref !== undefined &&
		(typeof record.ref !== "string" || record.ref.length === 0 || record.ref.length > MAX_TURN_ORIGIN_REF_CHARS)
	)
		return undefined;
	if (
		record.shown !== undefined &&
		(typeof record.shown !== "string" ||
			record.shown.length === 0 ||
			record.shown.length > MAX_TURN_ORIGIN_SHOWN_CHARS)
	)
		return undefined;
	if (
		record.from !== undefined &&
		(typeof record.from !== "string" || record.from.length === 0 || record.from.length > MAX_TURN_ORIGIN_FROM_CHARS)
	)
		return undefined;
	if (
		record.hop !== undefined &&
		(!Number.isInteger(record.hop) || (record.hop as number) < 1 || (record.hop as number) > MAX_TURN_ORIGIN_HOP)
	)
		return undefined;
	// A sender and a place in a chain come together, only on mail: an agent's own (never a third party's) or one a third party's words reached.
	if ((record.from === undefined) !== (record.hop === undefined)) return undefined;
	if (
		record.routineRef !== undefined &&
		(record.k !== "owner-channel" || !isRoutineBotOccurrenceRef(record.routineRef))
	)
		return undefined;
	if (record.k === "agent-mail" && (record.from === undefined || record.thirdParty !== undefined)) return undefined;
	if (record.from !== undefined && record.k !== "agent-mail" && record.thirdParty !== true) return undefined;
	if (
		record.k === "owner-channel" &&
		(record.verified !== true ||
			record.thirdParty !== undefined ||
			record.ref === undefined ||
			typeof record.channel !== "string" ||
			record.channel === PEER_CHAT_CHANNEL)
	)
		return undefined;
	return {
		v: 1,
		k: record.k as TurnOriginKind,
		...(record.channel !== undefined ? { channel: record.channel as string } : {}),
		...(record.verified === true ? { verified: true as const } : {}),
		...(record.thirdParty === true ? { thirdParty: true as const } : {}),
		...(record.ref !== undefined ? { ref: record.ref as string } : {}),
		...(typeof record.routineRef === "string" ? { routineRef: record.routineRef } : {}),
		...(record.shown !== undefined ? { shown: record.shown as string } : {}),
		...(record.from !== undefined ? { from: record.from as string, hop: record.hop as number } : {}),
	};
}

/**
 * Whether `record` is one a host records for words it delivers itself (an agent's mail, a routine's prompt to a bot): it
 * names their channel and is never the owner's words, so a record a file holds can never lend them the owner's authority.
 */
export function isRecordedDeliveryOrigin(
	record: TurnOriginRecord,
): record is TurnOriginRecord & { readonly channel: string } {
	return (
		record.channel !== undefined &&
		(record.k === "agent-mail" || record.k === "routine" || record.thirdParty === true)
	);
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
