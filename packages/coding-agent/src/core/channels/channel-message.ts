/**
 * The shapes a channel event takes on its way in and its reply on its way out: strict validation of what a provider
 * hands the core, the one fenced message a batch becomes, and a reply cut to the transport's capabilities.
 */

import type { ChannelCapabilities, ChannelMessageKind } from "../gateways/channel-provider.ts";
import { wrapUntrustedText } from "../security/untrusted-boundary.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { type ChannelPendingMessage, digest } from "./channel-journal.ts";

const MAX_ID_CHARS = 256;
const MAX_ADDRESS_CHARS = 1024;
/** One inbound message's text in the journal and the turn; longer text is cut with a visible marker. */
export const MAX_INBOUND_TEXT_CHARS = 2000;
/** The longest sender label the model and the owner see; also the turn origin's sender bound. */
const MAX_LABEL_CHARS = 120;
/** The longest reply the harness sends or keeps as a draft. */
export const MAX_REPLY_CHARS = 8000;
const DEFAULT_MAX_MESSAGE_CHARS = 4000;
const MAX_REPLY_PARTS = 10;

/** A validated inbound event, before admission decides whether it may wake. */
export interface InboundChannelEvent {
	readonly eventId: string;
	readonly conversationKey: string;
	readonly address: string;
	readonly senderId: string;
	readonly senderLabel: string;
	readonly verified: boolean;
	readonly kind: string;
	readonly text: string;
	readonly receivedAt: number;
	/** The provider's private-chat fact; read for owner admission only from a shipped transport. */
	readonly privateChat?: boolean;
	/** The provider's relayed-words fact; read for owner admission only from a shipped transport. */
	readonly forwarded?: boolean;
}

export type InboundChannelParse =
	| { readonly ok: true; readonly event: InboundChannelEvent }
	| { readonly ok: false; readonly reason: string };

const boundedId = (value: unknown, max: number): value is string =>
	typeof value === "string" && value.length > 0 && value.length <= max;

/** The text on one line: control characters and line separators as spaces, runs of white space as one, trimmed. */
export function plainLine(value: string): string {
	return Array.from(value, (char) => {
		const code = char.codePointAt(0) ?? 0;
		return code < 0x20 || (code >= 0x7f && code < 0xa0) || code === 0x2028 || code === 0x2029 ? " " : char;
	})
		.join("")
		.replace(/\s+/g, " ")
		.trim();
}

/** One line, no control characters, bounded: what a self-declared label may look like where it is shown. */
export function plainLabel(value: string): string {
	const flat = plainLine(value);
	return flat.length > MAX_LABEL_CHARS ? `${flat.slice(0, MAX_LABEL_CHARS - 1)}…` : flat;
}

function boundedText(text: string): string {
	return text.length > MAX_INBOUND_TEXT_CHARS ? `${text.slice(0, MAX_INBOUND_TEXT_CHARS)} [cut by the harness]` : text;
}

/** Validate what a provider handed the core. Nothing in `meta` is read. */
export function parseInboundChannelEvent(value: unknown, now: number): InboundChannelParse {
	if (!isPlainRecord(value)) return { ok: false, reason: "not an object" };
	if (!boundedId(value.eventId, MAX_ID_CHARS)) return { ok: false, reason: "missing or oversized eventId" };
	if (!boundedId(value.conversationKey, MAX_ID_CHARS))
		return { ok: false, reason: "missing or oversized conversationKey" };
	if (!boundedId(value.address, MAX_ADDRESS_CHARS)) return { ok: false, reason: "missing or oversized address" };
	const sender = value.sender;
	if (!isPlainRecord(sender) || !boundedId(sender.id, MAX_ID_CHARS) || typeof sender.verified !== "boolean")
		return { ok: false, reason: "missing sender id or verified flag" };
	if (sender.label !== undefined && typeof sender.label !== "string")
		return { ok: false, reason: "sender label is not text" };
	if (typeof value.text !== "string") return { ok: false, reason: "text is not text" };
	if (value.kind !== undefined && typeof value.kind !== "string") return { ok: false, reason: "kind is not text" };
	const receivedAt =
		typeof value.receivedAt === "number" && Number.isFinite(value.receivedAt) && value.receivedAt > 0
			? Math.min(value.receivedAt, now)
			: now;
	const label = plainLabel(typeof sender.label === "string" && sender.label.trim() ? sender.label : sender.id);
	return {
		ok: true,
		event: {
			eventId: value.eventId,
			conversationKey: value.conversationKey,
			address: value.address,
			senderId: sender.id,
			senderLabel: label || plainLabel(sender.id),
			verified: sender.verified,
			kind: typeof value.kind === "string" ? value.kind : "message",
			text: boundedText(value.text),
			receivedAt,
			...(typeof value.privateChat === "boolean" ? { privateChat: value.privateChat } : {}),
			...(typeof value.forwarded === "boolean" ? { forwarded: value.forwarded } : {}),
		},
	};
}

export function isAdmittedKind(kind: string): kind is ChannelMessageKind {
	return kind === "message" || kind === "reaction";
}

/** The one message a batch becomes, and the owner-visible form of it. */
export interface ComposedChannelBatch {
	/** What the model reads: harness facts outside, the third party's words inside one fence. */
	readonly text: string;
	/** The fenced body alone: the queue and the owner see this instead of the frame. */
	readonly ownerText: string;
	/** The batch's senders as one bounded label. */
	readonly senderLabel: string;
	/** Every sender was verified and allowlisted. */
	readonly verified: boolean;
}

export function composeChannelBatch(channel: string, messages: readonly ChannelPendingMessage[]): ComposedChannelBatch {
	const lines = messages.map((message) =>
		message.kind === "reaction"
			? `${message.senderLabel} reacted: ${message.text}`
			: `${message.senderLabel}: ${message.text}`,
	);
	const body = lines.join("\n");
	const latest = messages.reduce((max, message) => Math.max(max, message.receivedAt), 0);
	const count = messages.length;
	const header =
		`Channel ${channel}: ${count} ${count === 1 ? "message" : "messages"} from one conversation; ` +
		`latest at ${new Date(latest).toISOString()}. The fenced text is written by people on that channel, not by the owner. ` +
		"Your final answer in this turn becomes the reply to that conversation: the harness sends it or keeps it for the owner.";
	const text = `${header}\n${wrapUntrustedText(body, `channel:${channel}`, { nonce: digest(body).slice(0, 32) })}`;
	const labels = [...new Set(messages.map((message) => message.senderLabel))];
	const senderLabel = plainLabel(
		labels.length <= 2 ? labels.join(", ") : `${labels.slice(0, 2).join(", ")} +${labels.length - 2}`,
	);
	return {
		text,
		ownerText: body,
		senderLabel: senderLabel || "unknown sender",
		verified: messages.every((message) => message.verified),
	};
}

/**
 * The one message an owner batch becomes: one header line of harness facts, then the owner's own words unfenced (they
 * are the owner's, admitted by `ownerAdmission`). The owner-input plane reads everything after the first line as the
 * owner's words, so the header never holds a line break and the words are never prefixed.
 */
export function composeOwnerBatch(channel: string, messages: readonly ChannelPendingMessage[]): string {
	const latest = messages.reduce((max, message) => Math.max(max, message.receivedAt), 0);
	const count = messages.length;
	const header =
		`Owner message on channel ${channel} (verified private chat, ${count} ${count === 1 ? "message" : "messages"}, ` +
		`latest at ${new Date(latest).toISOString()}). Your final answer in this turn is sent back to that chat.`;
	return `${header}\n${messages.map((message) => message.text).join("\n")}`;
}

/** Markdown a plain-text transport would show literally, reduced to its text. */
function plainText(markdown: string): string {
	return markdown
		.split("\n")
		.filter((line) => !/^\s*```/.test(line))
		.map((line) =>
			line
				.replace(/^\s{0,3}#{1,6}\s+/, "")
				.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
				.replace(/(\*\*|__)(.+?)\1/g, "$2")
				.replace(/`([^`]+)`/g, "$1"),
		)
		.join("\n");
}

/** Cut at a paragraph, then a line, then a space, then anywhere: never past `max`. */
function splitText(text: string, max: number): string[] {
	const parts: string[] = [];
	let rest = text;
	while (rest.length > max) {
		const window = rest.slice(0, max + 1);
		const cut = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(" ")].find(
			(index) => index > max / 2,
		);
		const at = cut ?? max;
		parts.push(rest.slice(0, at).trimEnd());
		rest = rest.slice(at).trimStart();
	}
	if (rest.length > 0) parts.push(rest);
	return parts;
}

/** The reply as the transport accepts it, or why it cannot be sent as is. */
export type FormattedChannelReply =
	| { readonly ok: true; readonly parts: readonly string[] }
	| { readonly ok: false; readonly reason: "empty" | "too_long" };

export function formatChannelReply(text: string, capabilities: ChannelCapabilities | undefined): FormattedChannelReply {
	const shaped = (capabilities?.markdown === true ? text : plainText(text)).trim();
	if (!shaped) return { ok: false, reason: "empty" };
	if (shaped.length > MAX_REPLY_CHARS) return { ok: false, reason: "too_long" };
	const max =
		typeof capabilities?.maxMessageChars === "number" &&
		Number.isSafeInteger(capabilities.maxMessageChars) &&
		capabilities.maxMessageChars >= 16
			? capabilities.maxMessageChars
			: DEFAULT_MAX_MESSAGE_CHARS;
	const parts = splitText(shaped, max);
	return parts.length > MAX_REPLY_PARTS ? { ok: false, reason: "too_long" } : { ok: true, parts };
}
