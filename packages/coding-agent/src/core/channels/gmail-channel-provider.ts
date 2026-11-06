/**
 * The shipped Gmail transport: one mailbox, plain-text mail, over the Gmail REST API (HTTPS only; no IMAP, no SMTP,
 * no push endpoint, no listening socket).
 *
 * The OAuth client and its refresh token are a secret read from `<agentDir>/channels/gmail.credentials` at every
 * start. The client secret and the refresh token appear only in the token request's body, the access token only in the
 * `Authorization` header of the Gmail calls; every error, report and thrown text is this module's own words, never a
 * Google error, a URL or an error the runtime produced. New mail is found by reading the mailbox's history from a
 * durable read position (`state/channels/gmail-cursor.json`), which moves past a mail only after the core's handler
 * resolved, so the journal holds it first; a handler rejection reads the same history again after a backoff.
 *
 * A sender is verified only when the `Authentication-Results` header Gmail itself wrote shows DMARC, or DKIM and SPF,
 * passing for the domain of the `From` address. Mail from the mailbox itself, automatic replies, bounces, list mail and
 * mail with no plain-text part never reach the core. A reply goes to the `From` address in the same thread, as plain
 * text marked `Auto-Submitted: auto-replied`. The sender writes the `From` address, so it is a sender-chosen id.
 */

import { join } from "node:path";
import { stateFile } from "../agent-paths.ts";
import type {
	ChannelCapabilities,
	ChannelInboundHandler,
	ChannelMessage,
	ChannelProvider,
	ChannelSenderIds,
} from "../gateways/channel-provider.ts";
import { writeFileAtomicSync } from "../util/atomic-file.ts";
import { readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import { isPlainRecord } from "../util/value-guards.ts";
import { digest } from "./channel-journal.ts";
import { plainLine } from "./channel-message.ts";
import {
	type ApiOutcome,
	type Backoff,
	backoffDelay,
	ChannelTransport,
	type ConnectionReport,
	DEFAULT_RETRY_AFTER_MS,
	pause,
	postJsonApi,
	type RefusedApiOutcome,
	readChannelSecretFile,
	sendPaced,
} from "./channel-transport.ts";

export const GMAIL_CHANNEL = "gmail";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";
/** The wait between two reads of the mailbox's history while nothing goes wrong. */
export const GMAIL_POLL_INTERVAL_MS = 60_000;
/** Each request's own bound; it runs on the system clock, never on the schedule clock. */
const REQUEST_ABORT_MS = 30_000;
const MAX_CREDENTIALS_BYTES = 2048;
const MAX_CURSOR_BYTES = 1024;
const MAX_TOKEN_RESPONSE_BYTES = 64 * 1024;
const MAX_LIST_RESPONSE_BYTES = 1024 * 1024;
const MAX_MESSAGE_RESPONSE_BYTES = 4 * 1024 * 1024;
/** History pages read in one pass; the next pass goes on at once from where this one stopped. */
const MAX_HISTORY_PAGES = 10;
/** The part of a mail's text body that is read; the core cuts its text again for the turn. */
const MAX_BODY_BYTES = 20 * 1024;
const MAX_SUBJECT_CHARS = 150;
const MAX_ADDRESS_CHARS = 254;
const MAX_MIME_PARTS = 64;
const MAX_MIME_DEPTH = 8;
/** An access token is renewed this long before Google said it expires. */
const TOKEN_EXPIRY_MARGIN_MS = 60_000;
const DEFAULT_TOKEN_LIFETIME_MS = 3600_000;
/** Gmail sends at most about one message a second to one recipient here. */
const SEND_SPACING_MS = 1000;

const CLIENT_ID_SHAPE = /^\d{1,30}-[a-z0-9]{1,64}\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET_SHAPE = /^[A-Za-z0-9_-]{10,128}$/;
/** The same shape the redaction masks (`OUTBOUND_ONLY_TOKEN_SHAPES`, `core/security/secret-text.ts`). */
const REFRESH_TOKEN_SHAPE = /^1\/\/[A-Za-z0-9_-]{40,512}$/;
/** What may follow `Bearer ` in a header. */
const ACCESS_TOKEN_SHAPE = /^[A-Za-z0-9._~+/-]{20,4096}=*$/;
const GMAIL_ID = /^[A-Za-z0-9]{1,64}$/;
const HISTORY_ID = /^(?:0|[1-9]\d{0,19})$/;
const ACCOUNT_DIGEST = /^[0-9a-f]{64}$/;
const PAGE_TOKEN = /^[A-Za-z0-9_-]{1,512}$/;
const ATTACHMENT_ID = /^[A-Za-z0-9_-]{1,1024}$/;
/** An addr-spec with a dot-atom local part and a host name: what is read from `From` and written to `To`. */
const MAIL_ADDRESS = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[A-Za-z0-9-]{1,63}(?:\.[A-Za-z0-9-]{1,63})+$/;
/** A Message-ID kept for the reply's threading headers: no quote, backslash, space or angle bracket inside. */
const MESSAGE_ID = /^<[^<>\s"\\]{1,200}>$/;

const CREDENTIALS_REJECTED_REASON =
	"Google rejected the Gmail credentials (the client or its refresh token). Replace the credentials file; it is read again on each retry";
const SCOPE_REASON =
	"Google refused Gmail access (HTTP 403): the refresh token lacks the gmail.readonly scope. Create a new one with gmail.readonly and gmail.send; the file is read again on each retry";
const API_OFF_REASON =
	"Google refused Gmail access (HTTP 403): the Gmail API is not enabled for the OAuth client's project. Enable it; reading is retried with backoff";
const FORBIDDEN_REASON =
	"Google refused Gmail access (HTTP 403) for these credentials; reading is retried with backoff";
const UNREACHABLE_REASON = "Gmail cannot be reached; reading is retried with backoff";
const TOO_LARGE_WARNING = "Gmail delivered a mail larger than 4 MiB; Pi skips it.";
const UNREADABLE_MAIL_WARNING = "Gmail answered the read of a mail with something that is not a mail; Pi skips it.";
/** Reads of one mail Gmail refuses in a row with a client error of its own before the mail is skipped. */
const MAX_MAIL_REFUSALS = 3;
/** Client errors that say nothing about the mail itself: each has its own handling and never skips a mail. */
const RETRIED_STATUSES = new Set([401, 403, 404, 408, 429]);
const GAP_WARNING =
	"Gmail no longer keeps the mailbox history from Pi's last read position; mail that arrived since then was not read. Reading goes on from now.";

const TRANSIENT_BACKOFF: Backoff = { baseMs: 1000, maxMs: 5 * 60_000 };
const CREDENTIALS_BACKOFF: Backoff = { baseMs: 60_000, maxMs: 30 * 60_000 };

/** Google's reasons for a 403: compared only, never shown. */
const RATE_LIMIT_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "RATE_LIMIT_EXCEEDED"]);
const SCOPE_REASONS = new Set(["insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT"]);
const API_OFF_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED"]);
/** Labels of mail that is not new mail someone sent the mailbox. */
const NOT_INBOUND_LABELS = ["SENT", "DRAFT", "SPAM", "TRASH"];

interface GmailCredentials {
	readonly clientId: string;
	readonly clientSecret: string;
	readonly refreshToken: string;
}

/** The mailbox this run reads: its own address, and the history id read up to (saved: the one the file holds). */
interface Mailbox {
	readonly account: string;
	cursor: string;
	saved: string | undefined;
	/** Where a pass that read its last allowed page left the listing, so the next pass reads on from there. */
	resume?: { readonly start: string; readonly pageToken: string };
}

/** Where a reply goes: the thread, the verified sender, the subject and the Message-ID it answers. */
interface ReplyTarget {
	readonly thread: string;
	readonly to: string;
	readonly subject: string;
	readonly messageId?: string;
}

/** How the sign-in service answered a token request that did not end in a token: no Gmail call was made. */
type TokenFailure =
	| { readonly kind: "credentials_rejected" }
	| { readonly kind: "sign_in_refused"; readonly status: number }
	| { readonly kind: "sign_in_unreachable" }
	| { readonly kind: "stopped" };

type TokenOutcome = { readonly kind: "ok"; readonly token: string } | TokenFailure;

type GmailOutcome = ApiOutcome | TokenFailure;

/** One Gmail API call: a GET, or a POST of `body`. */
interface GmailRequest {
	readonly path: string;
	readonly query?: Readonly<Record<string, string>>;
	readonly body?: Readonly<Record<string, unknown>>;
	readonly maxResponseBytes: number;
	/** Whether a 2xx object is the answer asked for; any object by default. */
	readonly succeeded?: (payload: Record<string, unknown>) => boolean;
}

/** One read of a mail: its answer, or how the mail ends (`end` undefined: skipped, the pass goes on). */
type MailPartRead =
	| { readonly kind: "ok"; readonly payload: Record<string, unknown> }
	| { readonly kind: "end"; readonly end: PassEnd | undefined };

/** How one pass over the mailbox's history ended. */
type PassEnd =
	| { readonly kind: "done" }
	| { readonly kind: "more" }
	| { readonly kind: "handler" }
	| { readonly kind: "stopped" }
	| { readonly kind: "credentials" }
	| { readonly kind: "suspend"; readonly reason: string }
	| { readonly kind: "transient"; readonly reason: string }
	| { readonly kind: "wait"; readonly ms: number };

/** Whether decimal history id `left` comes after `right` (both validated, no leading zeros; they exceed 2^53). */
function isLater(left: string, right: string): boolean {
	return left.length !== right.length ? left.length > right.length : left > right;
}

/** One header line's value on one line: folding undone, any other line break a space. */
function flatHeader(value: string): string {
	return value.replace(/\r?\n[ \t]+/g, " ").replace(/[\r\n]+/g, " ");
}

/** The mail's headers by lower-cased name, in their order. */
function readHeaders(headers: unknown): readonly { readonly name: string; readonly value: string }[] {
	if (!Array.isArray(headers)) return [];
	const read: { name: string; value: string }[] = [];
	for (const header of headers)
		if (isPlainRecord(header) && typeof header.name === "string" && typeof header.value === "string")
			read.push({ name: header.name.toLowerCase(), value: flatHeader(header.value) });
	return read;
}

/** The one mailbox of a `From` header, lower-cased, with its display name; undefined for none or several. */
function readFrom(value: string | undefined): { readonly address: string; readonly name?: string } | undefined {
	if (value === undefined) return undefined;
	const flat = value.trim();
	const angle = /^(.*?)<([^<>]+)>\s*$/.exec(flat);
	if (angle && (angle[1] ?? "").includes("<")) return undefined;
	const address = (angle ? (angle[2] ?? "") : flat).trim();
	if (address.length > MAX_ADDRESS_CHARS || !MAIL_ADDRESS.test(address)) return undefined;
	// The core bounds a label where it shows it.
	const name = plainLine((angle?.[1] ?? "").trim().replace(/^"(.*)"$/, "$1"));
	return { address: address.toLowerCase(), ...(name ? { name } : {}) };
}

/**
 * An `Authentication-Results` value as result sets: comments dropped, quoted strings kept whole, split on `;` and
 * white space outside quotes. The first set is the authserv-id (and its version).
 */
function resultSets(value: string): string[][] {
	const sets: string[][] = [[]];
	let token = "";
	let depth = 0;
	let quoted = false;
	const flush = (): void => {
		if (token) sets[sets.length - 1]?.push(token);
		token = "";
	};
	for (let index = 0; index < value.length; index++) {
		const char = value[index] ?? "";
		if (char === "\\") {
			if (depth === 0) token += value.slice(index, index + 2);
			index++;
		} else if (quoted) {
			token += char;
			if (char === '"') quoted = false;
		} else if (char === "(") depth++;
		else if (char === ")" && depth > 0) depth--;
		else if (depth > 0) continue;
		else if (char === '"') {
			quoted = true;
			token += char;
		} else if (char === ";") {
			flush();
			sets.push([]);
		} else if (/\s/.test(char)) flush();
		else token += char;
	}
	flush();
	return sets;
}

const unquoted = (value: string): string => value.replace(/^"(.*)"$/, "$1").toLowerCase();
const domainOf = (value: string | undefined): string | undefined =>
	value === undefined ? undefined : value.slice(value.lastIndexOf("@") + 1);

/**
 * Whether the results Gmail wrote (the first `Authentication-Results` header, authserv-id `mx.google.com`) show the
 * `From` domain authenticated: DMARC passing for it, or DKIM signed by it and SPF passing for it. Anything else is not.
 */
function authenticatedBy(domain: string, header: string | undefined): boolean {
	if (header === undefined) return false;
	const [server, ...results] = resultSets(header);
	if (server?.[0]?.toLowerCase() !== "mx.google.com") return false;
	let dkim = false;
	let spf = false;
	for (const [result, ...properties] of results) {
		if (result === undefined) continue;
		const [method, outcome] = result.toLowerCase().split("=", 2);
		if (outcome !== "pass") continue;
		const values = new Map<string, string>();
		for (const property of properties) {
			const at = property.indexOf("=");
			if (at > 0) values.set(property.slice(0, at).toLowerCase(), unquoted(property.slice(at + 1)));
		}
		if (method === "dmarc" && values.get("header.from") === domain) return true;
		if (method === "dkim" && (values.get("header.d") === domain || domainOf(values.get("header.i")) === domain))
			dkim = true;
		if (method === "spf" && domainOf(values.get("smtp.mailfrom")) === domain) spf = true;
	}
	return dkim && spf;
}

/** The first `text/plain` part that is not an attachment, depth-first and bounded; undefined when the mail has none. */
function plainPart(root: unknown): Record<string, unknown> | undefined {
	let visited = 0;
	const walk = (part: unknown, depth: number): Record<string, unknown> | undefined => {
		if (!isPlainRecord(part) || depth > MAX_MIME_DEPTH || ++visited > MAX_MIME_PARTS) return undefined;
		const type = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
		if (type === "text/plain") {
			const disposition = readHeaders(part.headers).find((header) => header.name === "content-disposition");
			const attached =
				(typeof part.filename === "string" && part.filename !== "") ||
				/^\s*attachment/i.test(disposition?.value ?? "");
			return attached ? undefined : part;
		}
		if (!type.startsWith("multipart/") || !Array.isArray(part.parts)) return undefined;
		for (const child of part.parts) {
			const found = walk(child, depth + 1);
			if (found) return found;
		}
		return undefined;
	};
	return walk(root, 0);
}

/** A part's body as text in its declared charset, bounded; undefined when it has none or the charset is unknown. */
function decodeBody(part: Record<string, unknown>): string | undefined {
	const body = part.body;
	if (!isPlainRecord(body) || typeof body.data !== "string") return undefined;
	const contentType = readHeaders(part.headers).find((header) => header.name === "content-type")?.value ?? "";
	const charset = /charset\s*=\s*"?([A-Za-z0-9._:-]{1,40})"?/i.exec(contentType)?.[1] ?? "utf-8";
	let decoder: TextDecoder;
	try {
		decoder = new TextDecoder(charset.toLowerCase() === "us-ascii" ? "utf-8" : charset);
	} catch {
		return undefined;
	}
	return decoder.decode(Buffer.from(body.data, "base64url").subarray(0, MAX_BODY_BYTES));
}

/**
 * The mail's text without what it quotes: `>` lines, an "On … wrote:" attribution and an "Original Message" separator
 * with the header lines under it are left out. Every other line is kept, so a reply written below or between quoted
 * lines keeps its words.
 */
function withoutQuotedHistory(body: string): string {
	const lines = body.replace(/\r\n?/g, "\n").split("\n");
	const kept: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		const line = (lines[index] ?? "").trim();
		if (line.startsWith(">")) continue;
		if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) {
			while (/^(?:From|Sent|Date|To|Cc|Subject):/i.test((lines[index + 1] ?? "").trim())) index++;
			continue;
		}
		// "On <date>, <name> wrote:", which a mail program may wrap over up to three lines.
		if (/^On\s/.test(line)) {
			const end = lines.slice(index, index + 3).findIndex((next) => /(?:^|\s)wrote:$/.test(next.trim()));
			if (end >= 0) {
				index += end;
				continue;
			}
		}
		kept.push(lines[index] ?? "");
	}
	return kept
		.join("\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** The reply address of a mail: an opaque record only {@link readReplyTarget} reads back. */
function replyAddress(target: ReplyTarget): string {
	return JSON.stringify({
		t: target.thread,
		f: target.to,
		s: target.subject,
		...(target.messageId ? { m: target.messageId } : {}),
	});
}

function readReplyTarget(address: unknown): ReplyTarget | undefined {
	if (typeof address !== "string") return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(address);
	} catch {
		return undefined;
	}
	if (!isPlainRecord(parsed)) return undefined;
	const { t, f, s, m } = parsed;
	if (typeof t !== "string" || !GMAIL_ID.test(t)) return undefined;
	if (typeof f !== "string" || f.length > MAX_ADDRESS_CHARS || !MAIL_ADDRESS.test(f)) return undefined;
	if (typeof s !== "string" || s.length > MAX_SUBJECT_CHARS) return undefined;
	if (m !== undefined && (typeof m !== "string" || !MESSAGE_ID.test(m))) return undefined;
	return { thread: t, to: f, subject: s, ...(m ? { messageId: m } : {}) };
}

/** What one mail becomes: nothing for the core, or the event it is handed. */
type MailReading = { readonly kind: "ignore" } | { readonly kind: "event"; readonly message: ChannelMessage };

const IGNORE: MailReading = { kind: "ignore" };

/** A mail from `messages.get?format=full` as the core sees it, or ignored before it (see the module comment). */
function readMail(mail: unknown, account: string): MailReading {
	if (!isPlainRecord(mail) || !isPlainRecord(mail.payload)) return IGNORE;
	const { id, threadId, labelIds } = mail;
	if (typeof id !== "string" || !GMAIL_ID.test(id) || typeof threadId !== "string" || !GMAIL_ID.test(threadId))
		return IGNORE;
	const labels = Array.isArray(labelIds) ? labelIds : [];
	if (!labels.includes("INBOX") || NOT_INBOUND_LABELS.some((label) => labels.includes(label))) return IGNORE;
	const headers = readHeaders(mail.payload.headers);
	const first = (name: string): string | undefined => headers.find((header) => header.name === name)?.value;
	const from = readFrom(first("from"));
	if (!from || from.address === account) return IGNORE;
	// Automatic replies, bounces and list mail: answering them would start a loop or write to a list.
	const autoSubmitted = first("auto-submitted");
	if (autoSubmitted !== undefined && autoSubmitted.split(";")[0]?.trim().toLowerCase() !== "no") return IGNORE;
	if (/^\s*(?:bulk|list|junk|auto_reply)\s*$/i.test(first("precedence") ?? "")) return IGNORE;
	// A null reverse path: a bounce or another message no one may answer (RFC 5321).
	if (/^\s*<\s*>\s*$/.test(first("return-path") ?? "")) return IGNORE;
	if (first("list-id") !== undefined || first("x-auto-response-suppress") !== undefined) return IGNORE;
	const subject = plainLine(first("subject") ?? "")
		.slice(0, MAX_SUBJECT_CHARS)
		.trimEnd();
	const messageId = first("message-id")?.trim();
	const target: ReplyTarget = {
		thread: threadId,
		to: from.address,
		subject,
		...(messageId !== undefined && MESSAGE_ID.test(messageId) ? { messageId } : {}),
	};
	// Like a Telegram update with no text: a mail with no plain-text part Pi can read (HTML only, an unknown charset).
	const part = plainPart(mail.payload);
	const body = part ? decodeBody(part) : undefined;
	if (body === undefined) return IGNORE;
	const receivedAt =
		typeof mail.internalDate === "string" && /^\d{1,15}$/.test(mail.internalDate) ? Number(mail.internalDate) : 0;
	const domain = from.address.slice(from.address.lastIndexOf("@") + 1);
	return {
		kind: "event",
		message: {
			conversationKey: `gmail:${threadId}`,
			address: replyAddress(target),
			eventId: `gmail:${id}`,
			text: `Subject: ${subject}\n\n${withoutQuotedHistory(body)}`.trim(),
			kind: "message",
			sender: {
				id: from.address,
				verified: authenticatedBy(domain, first("authentication-results")),
				...(from.name ? { label: from.name } : {}),
			},
			...(receivedAt > 0 ? { receivedAt } : {}),
		},
	};
}

/** Header text as is when it is printable ASCII, else as RFC 2047 UTF-8 words of at most 45 bytes each. */
function headerText(value: string): string {
	if (/^[\x20-\x7e]*$/.test(value)) return value;
	const words: string[] = [];
	let chunk = "";
	for (const char of value) {
		if (Buffer.byteLength(chunk + char, "utf8") > 45) {
			words.push(chunk);
			chunk = "";
		}
		chunk += char;
	}
	if (chunk) words.push(chunk);
	return words.map((word) => `=?UTF-8?B?${Buffer.from(word, "utf8").toString("base64")}?=`).join("\r\n ");
}

/** The reply as an RFC 5322 message, base64url as `messages.send` takes it. Throws when a header would break a line. */
function rawReply(target: ReplyTarget, text: string): string {
	const subject = /^re:/i.test(target.subject) ? target.subject : `Re: ${target.subject}`.trim();
	if ([target.to, subject, target.messageId ?? ""].some((value) => /[\r\n]/.test(value)))
		throw new Error("The Gmail reply's headers would carry a line break; it was not sent.");
	const lines = [
		`To: ${target.to}`,
		`Subject: ${headerText(subject)}`,
		...(target.messageId ? [`In-Reply-To: ${target.messageId}`, `References: ${target.messageId}`] : []),
		// RFC 3834: a reply a program wrote, so the other side's responder answers it with nothing.
		"Auto-Submitted: auto-replied",
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=UTF-8",
		"Content-Transfer-Encoding: base64",
		"",
		...(Buffer.from(text, "utf8")
			.toString("base64")
			.match(/.{1,76}/g) ?? []),
		"",
	];
	return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** Google's machine reasons of a refusal (`error.errors[].reason`, `error.status`, `error.details[].reason`). */
function googleReasons(payload: unknown): Set<string> {
	const reasons = new Set<string>();
	const error = isPlainRecord(payload) ? payload.error : undefined;
	if (!isPlainRecord(error)) return reasons;
	if (typeof error.status === "string") reasons.add(error.status);
	for (const list of [error.errors, error.details])
		if (Array.isArray(list))
			for (const entry of list)
				if (isPlainRecord(entry) && typeof entry.reason === "string") reasons.add(entry.reason);
	return reasons;
}

function sendRefusal(outcome: RefusedApiOutcome): string {
	const { status } = outcome;
	if (status === 429) return "Gmail kept rate-limiting the reply (HTTP 429); it was not sent.";
	if (status >= 500) return `Gmail answered the reply with HTTP ${status}; it may have been delivered.`;
	if (status < 300) return "Gmail answered the reply with an unreadable response; it may have been delivered.";
	if (status === 401) return "Google rejected the Gmail access for the reply; it was not sent.";
	if (status === 403) {
		const reasons = googleReasons(outcome.payload);
		if ([...reasons].some((reason) => RATE_LIMIT_REASONS.has(reason)))
			return "Gmail kept rate-limiting the reply (HTTP 403); it was not sent.";
		return "Google refused the reply (HTTP 403): the refresh token needs the gmail.send scope and the Gmail API enabled; it was not sent.";
	}
	return `Gmail refused the reply (HTTP ${status}); it was not sent.`;
}

export interface GmailChannelProviderOptions {
	readonly agentDir: string;
	readonly fetch?: typeof globalThis.fetch;
	readonly warn: (message: string) => void;
	/** The schedule clock (`channel-poll`): poll interval, backoffs, token expiry, pacing. Requests time out on the system clock. */
	readonly timers?: TimerPort;
}

export function gmailCredentialsPath(agentDir: string): string {
	return join(agentDir, "channels", "gmail.credentials");
}

export function gmailCursorPath(agentDir: string): string {
	return stateFile(agentDir, "channels", "gmail-cursor.json");
}

export class GmailChannelProvider extends ChannelTransport implements ChannelProvider {
	readonly name = GMAIL_CHANNEL;
	/** One message per reply: the core never cuts a reply longer than this. */
	readonly capabilities: ChannelCapabilities = { maxMessageChars: 8000, markdown: false };
	/** A sender id is the `From` address, which the sender writes; addresses compare in lower case. */
	readonly senderIds: ChannelSenderIds = { assignedBy: "sender", normalize: (id) => id.toLowerCase() };
	private readonly credentialsPath: string;
	private readonly cursorPath: string;
	private readonly warn: (message: string) => void;
	private credentials: GmailCredentials | undefined;
	private access: { readonly token: string; readonly expiresAt: number } | undefined;
	/** The token request in flight, shared by the reading loop and a send. */
	private refreshing: Promise<TokenOutcome> | undefined;
	private mailbox: Mailbox | undefined;
	/** The mail whose reads Gmail refused last, and how many times in a row. */
	private refusedMail: { readonly id: string; readonly count: number } | undefined;
	private readonly warned = new Set<string>();

	constructor(options: GmailChannelProviderOptions) {
		super(options, SEND_SPACING_MS);
		this.credentialsPath = gmailCredentialsPath(options.agentDir);
		this.cursorPath = gmailCursorPath(options.agentDir);
		this.warn = options.warn;
	}

	protected forgetRun(): void {
		this.credentials = undefined;
		this.access = undefined;
		this.refreshing = undefined;
		this.mailbox = undefined;
		this.refusedMail = undefined;
		this.warned.clear();
	}

	async send(message: ChannelMessage): Promise<void> {
		const target = readReplyTarget(message.address);
		if (!target) throw new Error("A Gmail reply needs the mail its conversation came from.");
		const raw = rawReply(target, message.text);
		await sendPaced({
			service: "Gmail",
			destination: target.to,
			signal: this.signal,
			timers: this.timers,
			pacer: this.pacer,
			call: async (callSignal) => {
				const outcome = await this.authorized(
					(access) =>
						this.api(
							access,
							{
								path: "messages/send",
								body: { raw, threadId: target.thread },
								maxResponseBytes: MAX_TOKEN_RESPONSE_BYTES,
								succeeded: (payload) => typeof payload.id === "string",
							},
							callSignal,
						),
					callSignal,
				);
				// No access token came (at first, or after Gmail refused the old one with 401): no send was made.
				if (outcome.kind === "credentials_rejected")
					throw new Error("Google rejected the Gmail credentials; the reply was not sent.");
				if (outcome.kind === "sign_in_refused")
					throw new Error(
						`Google's sign-in service answered with HTTP ${outcome.status} and gave no Gmail access; the reply was not sent.`,
					);
				if (outcome.kind === "sign_in_unreachable")
					throw new Error("Google's sign-in service cannot be reached; the reply was not sent.");
				return outcome;
			},
			refusal: sendRefusal,
		});
	}

	/** The credentials, or a throw naming the file and what is wrong with it (never its content). */
	protected readSecrets(): void {
		const path = this.credentialsPath;
		const label = "Gmail credentials";
		const text = readChannelSecretFile({
			path,
			label,
			maxBytes: MAX_CREDENTIALS_BYTES,
			holds: "the credentials JSON",
		});
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		const { client_id, client_secret, refresh_token } = isPlainRecord(parsed) ? parsed : {};
		if (
			!isPlainRecord(parsed) ||
			Object.keys(parsed).length !== 3 ||
			typeof client_id !== "string" ||
			!CLIENT_ID_SHAPE.test(client_id) ||
			typeof client_secret !== "string" ||
			!CLIENT_SECRET_SHAPE.test(client_secret) ||
			typeof refresh_token !== "string" ||
			!REFRESH_TOKEN_SHAPE.test(refresh_token)
		)
			throw new Error(
				`the ${label} file ${path} does not hold exactly {"client_id", "client_secret", "refresh_token"} of a Google OAuth client`,
			);
		this.credentials = { clientId: client_id, clientSecret: client_secret, refreshToken: refresh_token };
	}

	/** A usable access token: the one held until shortly before it expires, else a new one (one request at a time). */
	private accessToken(signal: AbortSignal): Promise<TokenOutcome> {
		const access = this.access;
		if (access && this.timers.now() < access.expiresAt) return Promise.resolve({ kind: "ok", token: access.token });
		if (!this.refreshing) {
			const refreshing = this.requestToken(signal).finally(() => {
				if (this.refreshing === refreshing) this.refreshing = undefined;
			});
			this.refreshing = refreshing;
		}
		return this.refreshing;
	}

	private async requestToken(signal: AbortSignal): Promise<TokenOutcome> {
		const credentials = this.credentials;
		if (!credentials || signal.aborted) return { kind: "stopped" };
		const outcome = await postJsonApi({
			fetch: this.fetch,
			timers: SYSTEM_TIMER_PORT,
			url: TOKEN_URL,
			form: {
				client_id: credentials.clientId,
				client_secret: credentials.clientSecret,
				refresh_token: credentials.refreshToken,
				grant_type: "refresh_token",
			},
			succeeded: (payload) =>
				typeof payload.access_token === "string" && ACCESS_TOKEN_SHAPE.test(payload.access_token),
			maxResponseBytes: MAX_TOKEN_RESPONSE_BYTES,
			signal,
			timeoutMs: REQUEST_ABORT_MS,
		});
		if (outcome.kind === "refused" && (outcome.status === 400 || outcome.status === 401))
			return { kind: "credentials_rejected" };
		if (outcome.kind === "refused") return { kind: "sign_in_refused", status: outcome.status };
		if (outcome.kind === "unreachable") return { kind: "sign_in_unreachable" };
		if (outcome.kind !== "ok") return outcome;
		const token = String(outcome.payload.access_token);
		const seconds = outcome.payload.expires_in;
		const lifetimeMs =
			typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
				? seconds * 1000
				: DEFAULT_TOKEN_LIFETIME_MS;
		if (this.credentials === credentials)
			this.access = { token, expiresAt: this.timers.now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS) };
		return { kind: "ok", token };
	}

	/** One Gmail call with a usable access token; a 401 drops the token and the call is made once more with a new one. */
	private async authorized(call: (token: string) => Promise<ApiOutcome>, signal: AbortSignal): Promise<GmailOutcome> {
		for (let attempt = 1; ; attempt++) {
			const token = await this.accessToken(signal);
			if (token.kind !== "ok") return token;
			const outcome = await call(token.token);
			if (outcome.kind !== "refused" || outcome.status !== 401 || attempt > 1) return outcome;
			if (this.access?.token === token.token) this.access = undefined;
		}
	}

	private api(token: string, request: GmailRequest, signal: AbortSignal): Promise<ApiOutcome> {
		const { query, body } = request;
		return postJsonApi({
			fetch: this.fetch,
			timers: SYSTEM_TIMER_PORT,
			url: `${API_BASE}/${request.path}${query ? `?${new URLSearchParams(query).toString()}` : ""}`,
			method: body ? "POST" : "GET",
			headers: { authorization: `Bearer ${token}` },
			...(body ? { body } : {}),
			succeeded: request.succeeded ?? (() => true),
			maxResponseBytes: request.maxResponseBytes,
			signal,
			timeoutMs: REQUEST_ABORT_MS,
		});
	}

	/** Warn once per run for `key`. */
	private warnOnce(key: string, message: string): void {
		if (this.warned.has(key)) return;
		this.warned.add(key);
		this.warn(message);
	}

	/** Reads the mailbox's history pass after pass: at once while more is left, else after the quiet wait. */
	protected async receive(
		onInbound: ChannelInboundHandler,
		reports: ConnectionReport,
		signal: AbortSignal,
	): Promise<void> {
		let rejections = 0;
		let handlerFailures = 0;
		let reloadCredentials = false;
		while (!signal.aborted) {
			if (reloadCredentials) {
				try {
					this.readSecrets();
					this.access = undefined;
					// The file may name another mailbox: its address and read position are read again.
					this.mailbox = undefined;
					reloadCredentials = false;
				} catch (error) {
					reports.suspend(error instanceof Error ? error.message : CREDENTIALS_REJECTED_REASON);
					await pause(this.timers, backoffDelay(CREDENTIALS_BACKOFF, ++rejections), signal);
					continue;
				}
			}
			const end = await this.pass(onInbound, signal);
			if (end.kind === "stopped") return;
			if (end.kind === "done" || end.kind === "more" || end.kind === "handler") {
				rejections = 0;
				reports.connected();
				if (end.kind === "handler") {
					await pause(this.timers, backoffDelay(TRANSIENT_BACKOFF, ++handlerFailures), signal);
					continue;
				}
				handlerFailures = 0;
				if (end.kind === "done") await pause(this.timers, GMAIL_POLL_INTERVAL_MS, signal);
				continue;
			}
			if (end.kind === "wait") {
				await pause(this.timers, end.ms, signal);
				continue;
			}
			if (end.kind === "credentials" || end.kind === "suspend") {
				reports.suspend(end.kind === "credentials" ? CREDENTIALS_REJECTED_REASON : end.reason);
				reloadCredentials = true;
				await pause(this.timers, backoffDelay(CREDENTIALS_BACKOFF, ++rejections), signal);
				continue;
			}
			await pause(this.timers, backoffDelay(TRANSIENT_BACKOFF, reports.failed(end.reason)), signal);
		}
	}

	/** Why a Gmail call that did not succeed ends the pass. */
	private failed(outcome: Exclude<GmailOutcome, { kind: "ok" }>, call: string): PassEnd {
		if (outcome.kind === "stopped") return { kind: "stopped" };
		if (outcome.kind === "credentials_rejected") return { kind: "credentials" };
		if (outcome.kind === "unreachable" || outcome.kind === "sign_in_unreachable")
			return { kind: "transient", reason: UNREACHABLE_REASON };
		if (outcome.kind === "sign_in_refused")
			return {
				kind: "transient",
				reason: `Google's sign-in service answered with HTTP ${outcome.status}; reading is retried with backoff`,
			};
		// A new access token was refused as well.
		if (outcome.status === 401) return { kind: "credentials" };
		if (outcome.status === 429) return { kind: "wait", ms: outcome.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS };
		if (outcome.status === 403) {
			const reasons = [...googleReasons(outcome.payload)];
			if (reasons.some((reason) => RATE_LIMIT_REASONS.has(reason)))
				return { kind: "wait", ms: DEFAULT_RETRY_AFTER_MS };
			if (reasons.some((reason) => SCOPE_REASONS.has(reason))) return { kind: "suspend", reason: SCOPE_REASON };
			if (reasons.some((reason) => API_OFF_REASONS.has(reason))) return { kind: "suspend", reason: API_OFF_REASON };
			return { kind: "suspend", reason: FORBIDDEN_REASON };
		}
		return {
			kind: "transient",
			reason: `Gmail answered ${call} with HTTP ${outcome.status}; reading is retried with backoff`,
		};
	}

	/** The mailbox's own address and its current history id. */
	private async profile(
		signal: AbortSignal,
	): Promise<{ readonly account: string; readonly historyId: string } | PassEnd> {
		const outcome = await this.authorized(
			(token) => this.api(token, { path: "profile", maxResponseBytes: MAX_TOKEN_RESPONSE_BYTES }, signal),
			signal,
		);
		if (outcome.kind !== "ok") return this.failed(outcome, "getProfile");
		const { emailAddress, historyId } = outcome.payload;
		if (
			typeof emailAddress !== "string" ||
			emailAddress.length > MAX_ADDRESS_CHARS ||
			!MAIL_ADDRESS.test(emailAddress) ||
			typeof historyId !== "string" ||
			!HISTORY_ID.test(historyId)
		)
			return { kind: "transient", reason: "Gmail answered getProfile unreadably; reading is retried with backoff" };
		return { account: emailAddress.toLowerCase(), historyId };
	}

	/** The saved read position of `account`'s mailbox; undefined when there is none, it is unreadable or another mailbox's. */
	private readCursor(account: string): string | undefined {
		let text: string | undefined;
		try {
			text = readOptionalBoundedTextFileSync(this.cursorPath, MAX_CURSOR_BYTES, "Gmail read position");
		} catch {
			text = "";
		}
		if (text === undefined) return undefined;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			parsed = undefined;
		}
		const saved = isPlainRecord(parsed) ? parsed : {};
		const { account: owner, historyId } = saved;
		if (
			typeof owner !== "string" ||
			!ACCOUNT_DIGEST.test(owner) ||
			typeof historyId !== "string" ||
			!HISTORY_ID.test(historyId)
		) {
			this.warnOnce("cursor", "Pi's Gmail read position could not be read; reading starts from now.");
			return undefined;
		}
		return owner === digest(account) ? historyId : undefined;
	}

	/** Keep the read position when it moved; a failed write keeps it in memory and is tried again at the next move. */
	private saveCursor(mailbox: Mailbox): void {
		if (mailbox.saved === mailbox.cursor) return;
		try {
			writeFileAtomicSync(
				this.cursorPath,
				`${JSON.stringify({ account: digest(mailbox.account), historyId: mailbox.cursor })}\n`,
			);
			mailbox.saved = mailbox.cursor;
		} catch {
			this.warnOnce(
				"cursor-write",
				"Pi's Gmail read position cannot be saved; after a restart mail already recorded is read again and dropped as a duplicate.",
			);
		}
	}

	/** The mailbox's history read up to now: each new mail handed to the core in order, the read position moved after it. */
	private async pass(onInbound: ChannelInboundHandler, signal: AbortSignal): Promise<PassEnd> {
		if (!this.mailbox) {
			const profile = await this.profile(signal);
			if ("kind" in profile) return profile;
			// A first start, or another mailbox: read nothing older than now.
			const saved = this.readCursor(profile.account);
			this.mailbox = { account: profile.account, cursor: saved ?? profile.historyId, saved };
		}
		const mailbox = this.mailbox;
		// Pages a listing leaves for the next pass are read on with their token, not listed again from the same start.
		const resume = mailbox.resume;
		mailbox.resume = undefined;
		const start = resume?.start ?? mailbox.cursor;
		const handled = new Set<string>();
		let pageToken = resume?.pageToken;
		for (let page = 0; page < MAX_HISTORY_PAGES; page++) {
			const listed = await this.authorized(
				(token) =>
					this.api(
						token,
						{
							path: "history",
							query: {
								startHistoryId: start,
								historyTypes: "messageAdded",
								labelId: "INBOX",
								maxResults: "100",
								...(pageToken ? { pageToken } : {}),
							},
							maxResponseBytes: MAX_LIST_RESPONSE_BYTES,
						},
						signal,
					),
				signal,
			);
			if (listed.kind === "refused" && listed.status === 404) return this.restart(mailbox, signal);
			if (listed.kind !== "ok") {
				this.saveCursor(mailbox);
				return this.failed(listed, "history.list");
			}
			const records = Array.isArray(listed.payload.history) ? listed.payload.history : [];
			for (const record of records) {
				if (!isPlainRecord(record) || typeof record.id !== "string" || !HISTORY_ID.test(record.id)) continue;
				const added = Array.isArray(record.messagesAdded) ? record.messagesAdded : [];
				for (const entry of added) {
					const mail = isPlainRecord(entry) ? entry.message : undefined;
					if (!isPlainRecord(mail) || typeof mail.id !== "string" || !GMAIL_ID.test(mail.id)) continue;
					if (handled.has(mail.id)) continue;
					const labels = Array.isArray(mail.labelIds) ? mail.labelIds : ["INBOX"];
					if (labels.includes("INBOX") && !NOT_INBOUND_LABELS.some((label) => labels.includes(label))) {
						const end = await this.deliver(mail.id, mailbox.account, onInbound, signal);
						if (end) {
							this.saveCursor(mailbox);
							return end;
						}
					}
					handled.add(mail.id);
				}
				if (isLater(record.id, mailbox.cursor)) mailbox.cursor = record.id;
			}
			const next = listed.payload.nextPageToken;
			if (typeof next === "string" && PAGE_TOKEN.test(next)) {
				pageToken = next;
				continue;
			}
			const current = listed.payload.historyId;
			if (typeof current === "string" && HISTORY_ID.test(current) && isLater(current, mailbox.cursor))
				mailbox.cursor = current;
			this.saveCursor(mailbox);
			return { kind: "done" };
		}
		this.saveCursor(mailbox);
		if (pageToken !== undefined) mailbox.resume = { start, pageToken };
		return { kind: "more" };
	}

	/** Gmail no longer has the history from the read position: go on from the mailbox's current id, and say so once. */
	private async restart(mailbox: Mailbox, signal: AbortSignal): Promise<PassEnd> {
		const profile = await this.profile(signal);
		if ("kind" in profile) return profile;
		mailbox.cursor = profile.historyId;
		this.saveCursor(mailbox);
		this.warn(GAP_WARNING);
		return { kind: "done" };
	}

	/**
	 * One read of a mail (`messages.get`, or its text part's `attachments.get`): the answer, or how the mail ends. A mail
	 * deleted since it arrived is skipped silently; one whose whole answer is too large or not a mail, or that Gmail keeps
	 * refusing with a client error three times, is skipped and said; anything else (no answer, a cut answer, a server error)
	 * ends the pass, so the same mail is read again.
	 */
	private async readMailPart(
		id: string,
		call: "messages.get" | "messages.attachments.get",
		request: Omit<GmailRequest, "maxResponseBytes">,
		signal: AbortSignal,
	): Promise<MailPartRead> {
		const outcome = await this.authorized(
			(token) => this.api(token, { ...request, maxResponseBytes: MAX_MESSAGE_RESPONSE_BYTES }, signal),
			signal,
		);
		if (outcome.kind === "ok") return outcome;
		const skip = (warning?: string) => {
			this.refusedMail = undefined;
			if (warning) this.warn(warning);
			return { kind: "end", end: undefined } as const;
		};
		if (outcome.kind === "refused" && outcome.status === 404) return skip();
		if (outcome.kind === "refused" && outcome.status < 300)
			return skip(outcome.unreadable === "too_large" ? TOO_LARGE_WARNING : UNREADABLE_MAIL_WARNING);
		if (
			outcome.kind === "refused" &&
			outcome.status >= 400 &&
			outcome.status < 500 &&
			!RETRIED_STATUSES.has(outcome.status)
		) {
			const refusals = this.refusedMail?.id === id ? this.refusedMail.count + 1 : 1;
			if (refusals >= MAX_MAIL_REFUSALS)
				return skip(
					`Gmail refused to give a mail ${refusals} times in a row (HTTP ${outcome.status}); Pi skips it.`,
				);
			this.refusedMail = { id, count: refusals };
		}
		return { kind: "end", end: this.failed(outcome, call) };
	}

	/** One new mail: read, then handed to the core unless it is ignored. Returns why the pass ends, or nothing to go on. */
	private async deliver(
		id: string,
		account: string,
		onInbound: ChannelInboundHandler,
		signal: AbortSignal,
	): Promise<PassEnd | undefined> {
		const fetched = await this.readMailPart(
			id,
			"messages.get",
			{ path: `messages/${id}`, query: { format: "full" } },
			signal,
		);
		if (fetched.kind === "end") return fetched.end;
		// Gmail answers a large text part by reference: its data is read on its own.
		const body = isPlainRecord(fetched.payload.payload) ? plainPart(fetched.payload.payload)?.body : undefined;
		if (
			isPlainRecord(body) &&
			typeof body.data !== "string" &&
			typeof body.attachmentId === "string" &&
			ATTACHMENT_ID.test(body.attachmentId)
		) {
			const attachment = await this.readMailPart(
				id,
				"messages.attachments.get",
				{ path: `messages/${id}/attachments/${body.attachmentId}` },
				signal,
			);
			if (attachment.kind === "end") return attachment.end;
			if (typeof attachment.payload.data === "string") body.data = attachment.payload.data;
		}
		this.refusedMail = undefined;
		const reading = readMail(fetched.payload, account);
		if (reading.kind === "ignore") return undefined;
		try {
			await onInbound(reading.message);
		} catch {
			return { kind: "handler" };
		}
		return undefined;
	}
}
