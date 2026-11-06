/**
 * The shipped Slack transport: one app, direct messages from people, text only, over Socket Mode (an outbound
 * WebSocket the app opens; no SDK, no public endpoint, no listening socket).
 *
 * Two secrets are read at every start from `<agentDir>/channels/`: the app-level token (`slack.app-token`, `xapp-`)
 * opens the connection (`apps.connections.open`), the bot token (`slack.bot-token`, `xoxb-`) posts replies
 * (`chat.postMessage`). Each appears only in its request's `Authorization` header, and the socket URL (it carries a
 * connection ticket) only in the socket's constructor; every error, report and thrown text is this module's own words,
 * never a Slack error code, a URL or an error the runtime produced. An envelope is acknowledged to Slack only after the
 * core's handler resolved, so the journal holds the event first; one the handler rejects is not acknowledged, and Slack
 * delivers it again.
 */

import { join } from "node:path";
import type {
	ChannelCapabilities,
	ChannelInboundHandler,
	ChannelMessage,
	ChannelProvider,
	ChannelSenderIds,
} from "../gateways/channel-provider.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { isPlainRecord } from "../util/value-guards.ts";
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
	readChannelTokenFile,
	sendPaced,
} from "./channel-transport.ts";

export const SLACK_CHANNEL = "slack";

const API_BASE = "https://slack.com/api";
const OPEN_ABORT_MS = 30_000;
const SEND_ABORT_MS = 30_000;
/** Slack greets a new connection at once; one that stays silent this long is given up. */
const HELLO_TIMEOUT_MS = 30_000;
/** Slack announces the end of a connection; one it outlives by this margin without the announcement is renewed. */
const REFRESH_MARGIN_MS = 60_000;
const MIN_REFRESH_MS = 60_000;
const MAX_REFRESH_MS = 24 * 60 * 60_000;
const SOCKET_OPEN = 1;
/** The same `xapp-` shape the redaction masks (`TOKEN_SHAPE_PATTERNS`, `core/security/secret-text.ts`). */
const APP_TOKEN_SHAPE = /^xapp-[A-Za-z0-9-]{20,250}$/;
/** Inside the redaction's `xox[baprs]-` shape. */
const BOT_TOKEN_SHAPE = /^xoxb-[A-Za-z0-9-]{20,250}$/;
/** Slack allows about one message a second into one conversation. */
const SEND_SPACING_MS = 1000;
const USER_ID = /^[UW][A-Z0-9]{2,30}$/;
const DIRECT_CHANNEL_ID = /^D[A-Z0-9]{2,30}$/;
const MESSAGE_TS = /^\d{1,12}\.\d{1,8}$/;
const EVENT_ID = /^[A-Za-z0-9]{1,128}$/;
const MAX_ENVELOPE_ID_CHARS = 256;
/** A reply address: the direct-message channel, and the thread's `ts` when the message was in one. */
const ADDRESS = /^(D[A-Z0-9]{2,30})(?:\/(\d{1,12}\.\d{1,8}))?$/;

/** Error codes Slack answers a token it does not accept with. Compared only, never shown. */
const TOKEN_ERRORS = new Set([
	"invalid_auth",
	"not_authed",
	"token_revoked",
	"token_expired",
	"account_inactive",
	"not_allowed_token_type",
]);
/** Error codes of a conversation the bot cannot post in. */
const CONVERSATION_ERRORS = new Set(["channel_not_found", "not_in_channel", "is_archived", "cannot_dm_bot"]);

const TOKEN_REJECTED_REASON =
	"Slack rejected the app-level token (HTTP 401 or an auth error). Replace the token file; both token files are read again on each retry";
const REFUSED_REASON =
	"Slack refused to open a Socket Mode connection: check that Socket Mode is enabled for the app and its app-level token has the connections:write scope. The connection is retried with backoff";
const DISABLED_REASON =
	"Slack turned Socket Mode off for the app (link disabled); enable it again in the app's settings. The connection is retried with backoff";
const UNREACHABLE_REASON = "Slack's Socket Mode connection cannot be opened or kept; it is retried with backoff";

const TRANSIENT_BACKOFF: Backoff = { baseMs: 1000, maxMs: 5 * 60_000 };
const REFUSED_BACKOFF: Backoff = { baseMs: 5000, maxMs: 5 * 60_000 };
const TOKEN_BACKOFF: Backoff = { baseMs: 60_000, maxMs: 30 * 60_000 };

interface SlackTokens {
	readonly app: string;
	readonly bot: string;
}

/** How one socket ended, and whether Slack greeted it first (the connection worked). */
type SocketEnd =
	| { readonly kind: "stopped"; readonly hello: boolean }
	| { readonly kind: "refresh"; readonly hello: boolean }
	| { readonly kind: "disabled"; readonly hello: boolean }
	| { readonly kind: "lost"; readonly hello: boolean };

const slackError = (payload: unknown): string | undefined =>
	isPlainRecord(payload) && typeof payload.error === "string" ? payload.error : undefined;

function readFrame(data: unknown): Record<string, unknown> | undefined {
	if (typeof data !== "string") return undefined;
	try {
		const frame: unknown = JSON.parse(data);
		return isPlainRecord(frame) ? frame : undefined;
	} catch {
		return undefined;
	}
}

/** The direct message a person wrote the app, from an `events_api` envelope's payload; undefined for anything else. */
function readDirectMessage(payload: unknown): ChannelMessage | undefined {
	if (!isPlainRecord(payload) || payload.type !== "event_callback") return undefined;
	const eventId = payload.event_id;
	const event = payload.event;
	if (typeof eventId !== "string" || !EVENT_ID.test(eventId) || !isPlainRecord(event)) return undefined;
	if (event.type !== "message" || event.channel_type !== "im") return undefined;
	// Edits, deletions, joins, file shares and every bot's posts (the app's own included) carry a subtype or a bot id.
	if (event.subtype !== undefined || event.bot_id !== undefined) return undefined;
	const { user, channel, text, ts } = event;
	if (typeof user !== "string" || !USER_ID.test(user)) return undefined;
	if (typeof channel !== "string" || !DIRECT_CHANNEL_ID.test(channel)) return undefined;
	if (typeof text !== "string" || typeof ts !== "string" || !MESSAGE_TS.test(ts)) return undefined;
	const thread = event.thread_ts;
	if (thread !== undefined && (typeof thread !== "string" || !MESSAGE_TS.test(thread))) return undefined;
	const receivedAt = Math.round(Number(ts) * 1000);
	return {
		conversationKey: thread ? `slack:${channel}:${thread}` : `slack:${channel}`,
		address: thread ? `${channel}/${thread}` : channel,
		eventId,
		text,
		kind: "message",
		sender: { id: user, verified: true },
		...(receivedAt > 0 ? { receivedAt } : {}),
	};
}

function sendRefusal(outcome: RefusedApiOutcome): string {
	const { status } = outcome;
	const error = slackError(outcome.payload);
	if (status === 429) return "Slack kept rate-limiting the reply (HTTP 429); it was not sent.";
	if (status >= 500) return `Slack answered the reply with HTTP ${status}; it may have been delivered.`;
	if (status < 300 && !isPlainRecord(outcome.payload))
		return "Slack answered the reply with an unreadable response; it may have been delivered.";
	if (status === 401 || status === 403 || (error !== undefined && TOKEN_ERRORS.has(error)))
		return "Slack rejected the bot token; the reply was not sent.";
	if (error === "missing_scope")
		return "Slack refused the reply: the bot token lacks the chat:write scope; it was not sent.";
	if (error !== undefined && CONVERSATION_ERRORS.has(error))
		return "Slack refused the reply: the app cannot post in that conversation; it was not sent.";
	if (error === "msg_too_long") return "Slack refused the reply as too long; it was not sent.";
	return `Slack refused the reply (HTTP ${status}); it was not sent.`;
}

export interface SlackChannelProviderOptions {
	readonly agentDir: string;
	readonly fetch?: typeof globalThis.fetch;
	/** The WebSocket constructor; the runtime's global one when omitted. */
	readonly webSocket?: typeof globalThis.WebSocket;
	readonly timers?: TimerPort;
}

export function slackTokenPaths(agentDir: string): { readonly app: string; readonly bot: string } {
	return { app: join(agentDir, "channels", "slack.app-token"), bot: join(agentDir, "channels", "slack.bot-token") };
}

export class SlackChannelProvider extends ChannelTransport implements ChannelProvider {
	readonly name = SLACK_CHANNEL;
	readonly capabilities: ChannelCapabilities = { maxMessageChars: 3000, markdown: false, threads: true };
	/** A Slack user id (`U…`) is one Slack assigns. */
	readonly senderIds: ChannelSenderIds = { assignedBy: "platform" };
	private readonly tokenPaths: { readonly app: string; readonly bot: string };
	private readonly webSocketOverride: typeof globalThis.WebSocket | undefined;
	private tokens: SlackTokens | undefined;

	constructor(options: SlackChannelProviderOptions) {
		super(options, SEND_SPACING_MS);
		this.tokenPaths = slackTokenPaths(options.agentDir);
		this.webSocketOverride = options.webSocket;
	}

	/** Both tokens, or a throw naming the file and what is wrong with it (never its content). */
	protected readSecrets(): void {
		this.tokens = {
			app: readChannelTokenFile({
				path: this.tokenPaths.app,
				label: "Slack app-level token",
				shape: APP_TOKEN_SHAPE,
				shapeHint: "an app-level token (xapp-...)",
			}),
			bot: readChannelTokenFile({
				path: this.tokenPaths.bot,
				label: "Slack bot token",
				shape: BOT_TOKEN_SHAPE,
				shapeHint: "a bot token (xoxb-...)",
			}),
		};
	}

	protected forgetRun(): void {
		this.tokens = undefined;
	}

	async send(message: ChannelMessage): Promise<void> {
		const target = typeof message.address === "string" ? ADDRESS.exec(message.address) : null;
		const channel = target?.[1];
		if (!target || !channel)
			throw new Error("A Slack reply needs the direct-message conversation its message came from.");
		const thread = target[2];
		await sendPaced({
			service: "Slack",
			destination: channel,
			signal: this.signal,
			timers: this.timers,
			pacer: this.pacer,
			call: (signal) =>
				this.call(
					"chat.postMessage",
					"bot",
					{
						channel,
						text: message.text,
						mrkdwn: false,
						unfurl_links: false,
						unfurl_media: false,
						...(thread ? { thread_ts: thread } : {}),
					},
					signal,
					SEND_ABORT_MS,
				),
			refusal: sendRefusal,
		});
	}

	private call(
		method: "apps.connections.open" | "chat.postMessage",
		token: keyof SlackTokens,
		body: Record<string, unknown> | undefined,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<ApiOutcome> {
		const tokens = this.tokens;
		if (!tokens || signal.aborted) return Promise.resolve({ kind: "stopped" });
		return postJsonApi({
			fetch: this.fetch,
			timers: this.timers,
			url: `${API_BASE}/${method}`,
			headers: {
				authorization: `Bearer ${tokens[token]}`,
				...(body === undefined ? { "content-type": "application/x-www-form-urlencoded" } : {}),
			},
			...(body !== undefined ? { body } : {}),
			signal,
			timeoutMs,
		});
	}

	/** Socket Mode: open a connection, read it until it ends, open the next one. */
	protected async receive(
		onInbound: ChannelInboundHandler,
		reports: ConnectionReport,
		signal: AbortSignal,
	): Promise<void> {
		let refusals = 0;
		let rejections = 0;
		let reloadTokens = false;
		while (!signal.aborted) {
			if (reloadTokens) {
				try {
					this.readSecrets();
					reloadTokens = false;
				} catch (error) {
					reports.suspend(error instanceof Error ? error.message : TOKEN_REJECTED_REASON);
					await pause(this.timers, backoffDelay(TOKEN_BACKOFF, ++rejections), signal);
					continue;
				}
			}
			const opened = await this.call("apps.connections.open", "app", undefined, signal, OPEN_ABORT_MS);
			if (opened.kind === "stopped") return;
			const url = opened.kind === "ok" ? opened.payload.url : undefined;
			if (typeof url === "string" && url.startsWith("wss://")) {
				const end = await this.connect(url, onInbound, reports, signal);
				if (end.hello) {
					refusals = 0;
					rejections = 0;
				}
				if (end.kind === "stopped") return;
				// Slack announced the end of a connection that worked: the next one opens at once.
				if (end.kind === "refresh" && end.hello) continue;
				if (end.kind === "disabled") {
					reports.suspend(DISABLED_REASON);
					await pause(this.timers, backoffDelay(REFUSED_BACKOFF, ++refusals), signal);
					continue;
				}
				await pause(this.timers, backoffDelay(TRANSIENT_BACKOFF, reports.failed(UNREACHABLE_REASON)), signal);
				continue;
			}
			if (opened.kind === "refused" && opened.status === 429) {
				await pause(this.timers, opened.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, signal);
				continue;
			}
			const error = opened.kind === "refused" ? slackError(opened.payload) : undefined;
			if (
				opened.kind === "refused" &&
				(opened.status === 401 || opened.status === 403 || (error !== undefined && TOKEN_ERRORS.has(error)))
			) {
				reports.suspend(TOKEN_REJECTED_REASON);
				reloadTokens = true;
				await pause(this.timers, backoffDelay(TOKEN_BACKOFF, ++rejections), signal);
				continue;
			}
			// An answer Slack gave on purpose (HTTP 200 without a connection URL): retrying soon changes nothing.
			if (opened.kind === "ok" || (opened.kind === "refused" && opened.status < 300 && error !== undefined)) {
				reports.suspend(REFUSED_REASON);
				await pause(this.timers, backoffDelay(REFUSED_BACKOFF, ++refusals), signal);
				continue;
			}
			const failures = reports.failed(
				opened.kind === "refused"
					? `Slack answered apps.connections.open with HTTP ${opened.status}; the connection is retried with backoff`
					: UNREACHABLE_REASON,
			);
			await pause(this.timers, backoffDelay(TRANSIENT_BACKOFF, failures), signal);
		}
	}

	/**
	 * One socket, from its URL to its end. Envelopes are handled one at a time in arrival order; the socket is closed
	 * only after the envelopes already handed to the core settled, so their acknowledgements still go out.
	 */
	private connect(
		url: string,
		onInbound: ChannelInboundHandler,
		reports: ConnectionReport,
		signal: AbortSignal,
	): Promise<SocketEnd> {
		const Socket = this.webSocketOverride ?? globalThis.WebSocket;
		let socket: WebSocket;
		try {
			socket = new Socket(url);
		} catch {
			return Promise.resolve({ kind: "lost", hello: false });
		}
		return new Promise<SocketEnd>((resolve) => {
			let hello = false;
			let ended = false;
			let handled: Promise<void> = Promise.resolve();
			let alarm = this.timers.setTimeout(() => end("lost"), HELLO_TIMEOUT_MS);
			const end = (kind: SocketEnd["kind"]): void => {
				if (ended) return;
				ended = true;
				this.timers.clearTimeout(alarm);
				socket.removeEventListener("message", onMessage);
				socket.removeEventListener("close", onClose);
				signal.removeEventListener("abort", onAbort);
				void handled.then(() => {
					socket.close(1000);
					resolve({ kind, hello });
				});
			};
			const onAbort = (): void => end("stopped");
			const onClose = (): void => end(signal.aborted ? "stopped" : "lost");
			const onMessage = (event: { readonly data: unknown }): void => {
				const frame = readFrame(event.data);
				if (!frame) return;
				if (frame.type === "hello") {
					hello = true;
					reports.connected();
					this.timers.clearTimeout(alarm);
					const info = frame.debug_info;
					const seconds = isPlainRecord(info) ? info.approximate_connection_time : undefined;
					if (typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0) {
						const refreshMs = Math.min(
							MAX_REFRESH_MS,
							Math.max(MIN_REFRESH_MS, seconds * 1000 + REFRESH_MARGIN_MS),
						);
						alarm = this.timers.setTimeout(() => end("refresh"), refreshMs);
					}
					return;
				}
				if (frame.type === "disconnect") {
					end(frame.reason === "link_disabled" ? "disabled" : "refresh");
					return;
				}
				const envelopeId = frame.envelope_id;
				if (typeof envelopeId !== "string" || !envelopeId || envelopeId.length > MAX_ENVELOPE_ID_CHARS) return;
				const message = frame.type === "events_api" ? readDirectMessage(frame.payload) : undefined;
				handled = handled.then(() => this.handle(socket, envelopeId, message, onInbound));
			};
			socket.addEventListener("message", onMessage);
			socket.addEventListener("close", onClose);
			signal.addEventListener("abort", onAbort, { once: true });
			if (signal.aborted) onAbort();
		});
	}

	/** Hand an admitted message to the core, then acknowledge the envelope; a rejected handler leaves it unacknowledged. */
	private async handle(
		socket: WebSocket,
		envelopeId: string,
		message: ChannelMessage | undefined,
		onInbound: ChannelInboundHandler,
	): Promise<void> {
		if (message) {
			try {
				await onInbound(message);
			} catch {
				return;
			}
		}
		if (socket.readyState === SOCKET_OPEN) socket.send(JSON.stringify({ envelope_id: envelopeId }));
	}
}
