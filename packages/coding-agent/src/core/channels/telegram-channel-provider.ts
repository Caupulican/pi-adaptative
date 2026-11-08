/**
 * The shipped Telegram transport: one bot, private chats, text only, over the Bot API's HTTPS long polling
 * (`getUpdates`, `sendMessage`). No SDK, no webhook, no listening socket.
 *
 * The bot token is a secret read from `<agentDir>/channels/telegram.token` at every start. It appears only in the
 * request URL; every error, report and thrown text is built from the API method and HTTP status in this module's own
 * words, never from a URL or an error the runtime produced. An update is acknowledged to Telegram (the next poll's
 * `offset`) only after the core's handler resolved, so the journal holds it first; a handler rejection polls the same
 * offset again after a backoff.
 */

import { join } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
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
	boundedRetryAfterMs,
	ChannelTransport,
	type ConnectionReport,
	DEFAULT_RETRY_AFTER_MS,
	pause,
	postJsonApi,
	readChannelTokenFile,
	sendPaced,
} from "./channel-transport.ts";

export const TELEGRAM_CHANNEL = "telegram";

const API_BASE = "https://api.telegram.org";
/** The server holds a poll this long; the client gives up well after it, so a normal empty poll never aborts. */
const POLL_TIMEOUT_SECONDS = 25;
const POLL_ABORT_MS = 40_000;
const SEND_ABORT_MS = 30_000;
/** The same shape the diagnostic redaction masks (`OUTBOUND_ONLY_TOKEN_SHAPES`, `core/security/secret-text.ts`). */
const TOKEN_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{30,64}$/;
/** Telegram allows about one message a second into one chat. */
const SEND_SPACING_MS = 1000;

const CONFLICT_REASON =
	"Telegram refused long polling (HTTP 409): another program polls this bot, or a webhook is set for it; stop it or delete the webhook. Polling is retried with backoff";
const TOKEN_REJECTED_REASON =
	"Telegram rejected the bot token (HTTP 401 or 404). Replace the token file; it is read again on each retry";
const UNREACHABLE_REASON = "Telegram's Bot API cannot be reached; polling is retried with backoff";

const TRANSIENT_BACKOFF: Backoff = { baseMs: 1000, maxMs: 5 * 60_000 };
const CONFLICT_BACKOFF: Backoff = { baseMs: 5000, maxMs: 5 * 60_000 };
const TOKEN_BACKOFF: Backoff = { baseMs: 60_000, maxMs: 30 * 60_000 };

const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** Fields Telegram sets on a message relaying words the sender did not write in this chat. */
const RELAYED_FIELDS = [
	"forward_origin",
	"forward_from",
	"forward_from_chat",
	"forward_sender_name",
	"forward_date",
	"is_automatic_forward",
	"via_bot",
] as const;

/**
 * One update as the core sees it: its id, and the message a person wrote the bot in a private chat (if it is one).
 * Only `message.text` enters a turn: a replied-to message, a quote or a caption never does. `privateChat` holds when
 * the chat is the sender's own one-to-one chat with the bot and no channel or group speaks as the sender; `forwarded`
 * when any relay field is present. Both are owner-admission facts (`owner-channel.ts`).
 */
function readUpdate(update: unknown): { readonly id: number; readonly message?: ChannelMessage } | undefined {
	if (!isPlainRecord(update) || !safeInteger(update.update_id) || update.update_id < 0) return undefined;
	const id = update.update_id;
	const message = update.message;
	if (!isPlainRecord(message) || typeof message.text !== "string") return { id };
	const chat = message.chat;
	const from = message.from;
	if (!isPlainRecord(chat) || chat.type !== "private" || !safeInteger(chat.id)) return { id };
	if (!isPlainRecord(from) || from.is_bot === true || !safeInteger(from.id)) return { id };
	const name = [from.first_name, from.last_name].filter((part) => typeof part === "string" && part.trim()).join(" ");
	const label = name || (typeof from.username === "string" && from.username ? `@${from.username}` : undefined);
	const chatId = String(chat.id);
	return {
		id,
		message: {
			conversationKey: `telegram:${chatId}`,
			address: chatId,
			eventId: `tg:${id}`,
			text: message.text,
			kind: "message",
			sender: { id: String(from.id), verified: true, ...(label ? { label } : {}) },
			...(safeInteger(message.date) && message.date > 0 ? { receivedAt: message.date * 1000 } : {}),
			privateChat: chat.id === from.id && message.sender_chat === undefined,
			forwarded: RELAYED_FIELDS.some((field) => message[field] !== undefined),
		},
	};
}

export interface TelegramChannelProviderOptions {
	readonly agentDir: string;
	readonly fetch?: typeof globalThis.fetch;
	readonly warn: (message: string) => void;
	readonly timers?: TimerPort;
}

export function telegramTokenPath(agentDir: string): string {
	return join(agentDir, "channels", "telegram.token");
}

export class TelegramChannelProvider extends ChannelTransport implements ChannelProvider {
	readonly name = TELEGRAM_CHANNEL;
	readonly capabilities: ChannelCapabilities = { maxMessageChars: 4096, markdown: false };
	/** A Telegram user id is a number Telegram assigns. */
	readonly senderIds: ChannelSenderIds = { assignedBy: "platform" };
	private readonly tokenPath: string;
	private readonly warn: (message: string) => void;
	private token: string | undefined;

	constructor(options: TelegramChannelProviderOptions) {
		super(options, SEND_SPACING_MS);
		this.tokenPath = telegramTokenPath(options.agentDir);
		this.warn = options.warn;
	}

	protected readSecrets(): void {
		this.token = readChannelTokenFile({
			path: this.tokenPath,
			label: "Telegram bot token",
			shape: TOKEN_SHAPE,
			shapeHint: "a bot token (digits, a colon, then the secret)",
		});
	}

	protected forgetRun(): void {
		this.token = undefined;
	}

	async send(message: ChannelMessage): Promise<void> {
		const chatId = message.address;
		if (typeof chatId !== "string" || !/^-?\d{1,20}$/.test(chatId))
			throw new Error("A Telegram reply needs the chat id its conversation came from.");
		await sendPaced({
			service: "Telegram",
			destination: chatId,
			signal: this.signal,
			timers: this.timers,
			pacer: this.pacer,
			call: (signal) => this.call("sendMessage", { chat_id: chatId, text: message.text }, signal, SEND_ABORT_MS),
			refusal: (outcome) => this.sendRefusal(outcome.status),
		});
	}

	private sendRefusal(status: number): string {
		if (status === 401 || status === 404)
			return `Telegram rejected the bot token (HTTP ${status}); the reply was not sent.`;
		if (status === 403)
			return "Telegram refused the reply (HTTP 403): the person blocked the bot or never started a chat with it.";
		if (status === 429) return "Telegram kept rate-limiting the reply (HTTP 429); it was not sent.";
		if (status >= 500) return `Telegram answered the reply with HTTP ${status}; it may have been delivered.`;
		return `Telegram refused the reply (HTTP ${status}); it was not sent.`;
	}

	private async call(
		method: "getUpdates" | "sendMessage",
		body: Record<string, unknown>,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<ApiOutcome> {
		const token = this.token;
		if (!token || signal.aborted) return { kind: "stopped" };
		const outcome = await postJsonApi({
			fetch: this.fetch,
			timers: this.timers,
			url: `${API_BASE}/bot${token}/${method}`,
			headers: { "content-type": "application/json" },
			body,
			signal,
			timeoutMs,
		});
		if (outcome.kind !== "refused") return outcome;
		// The Bot API answers a refusal it explains with HTTP 200 and `ok: false`; it says how long to wait in its body.
		const status = outcome.status >= 200 && outcome.status < 300 ? 502 : outcome.status;
		const payload = outcome.payload;
		const parameters = isPlainRecord(payload) ? payload.parameters : undefined;
		const retryAfter =
			status !== 429
				? undefined
				: isPlainRecord(parameters)
					? boundedRetryAfterMs(parameters.retry_after)
					: outcome.retryAfterMs;
		return { kind: "refused", status, payload, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
	}

	/** Long polling: an update is acknowledged (the next `offset`) only after the core's handler resolved. */
	protected async receive(
		onInbound: ChannelInboundHandler,
		reports: ConnectionReport,
		signal: AbortSignal,
	): Promise<void> {
		let offset: number | undefined;
		let conflicts = 0;
		let rejections = 0;
		let handlerFailures = 0;
		let reloadToken = false;
		let warnedUnreadable = false;
		while (!signal.aborted) {
			if (reloadToken) {
				try {
					this.readSecrets();
					reloadToken = false;
				} catch (error) {
					reports.suspend(error instanceof Error ? error.message : TOKEN_REJECTED_REASON);
					await pause(this.timers, backoffDelay(TOKEN_BACKOFF, ++rejections), signal);
					continue;
				}
			}
			const outcome = await this.call(
				"getUpdates",
				{
					...(offset !== undefined ? { offset } : {}),
					timeout: POLL_TIMEOUT_SECONDS,
					allowed_updates: ["message"],
				},
				signal,
				POLL_ABORT_MS,
			);
			if (outcome.kind === "stopped") return;
			const updates = outcome.kind === "ok" ? outcome.payload.result : undefined;
			if (Array.isArray(updates)) {
				conflicts = 0;
				rejections = 0;
				reports.connected();
				let handlerFailed = false;
				const before = offset;
				for (const raw of updates) {
					const update = readUpdate(raw);
					if (!update) {
						if (!warnedUnreadable)
							this.warn("Telegram delivered an update without a readable update id; it is skipped.");
						warnedUnreadable = true;
						continue;
					}
					if (offset !== undefined && update.id < offset) continue;
					if (update.message) {
						try {
							await onInbound(update.message);
						} catch {
							handlerFailed = true;
							break;
						}
					}
					offset = update.id + 1;
				}
				// A batch that moved nothing forward (a rejected handler, or only unreadable updates) is not polled again at once.
				if (handlerFailed || (updates.length > 0 && offset === before)) {
					harnessLog.warn("channels", "an update batch did not advance; polling repeats it", {
						channel: TELEGRAM_CHANNEL,
						handlerFailed,
						failures: handlerFailures + 1,
					});
					await pause(this.timers, backoffDelay(TRANSIENT_BACKOFF, ++handlerFailures), signal);
				} else handlerFailures = 0;
				continue;
			}
			if (outcome.kind === "refused" && outcome.status === 409) {
				reports.suspend(CONFLICT_REASON);
				await pause(this.timers, backoffDelay(CONFLICT_BACKOFF, ++conflicts), signal);
				continue;
			}
			if (outcome.kind === "refused" && (outcome.status === 401 || outcome.status === 404)) {
				reports.suspend(TOKEN_REJECTED_REASON);
				reloadToken = true;
				await pause(this.timers, backoffDelay(TOKEN_BACKOFF, ++rejections), signal);
				continue;
			}
			if (outcome.kind === "refused" && outcome.status === 429) {
				await pause(this.timers, outcome.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, signal);
				continue;
			}
			const failures = reports.failed(
				outcome.kind === "refused"
					? `Telegram's Bot API answered getUpdates with HTTP ${outcome.status}; polling is retried with backoff`
					: UNREACHABLE_REASON,
			);
			await pause(this.timers, backoffDelay(TRANSIENT_BACKOFF, failures), signal);
		}
	}
}
