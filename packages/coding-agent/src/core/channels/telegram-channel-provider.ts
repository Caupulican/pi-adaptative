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

import { statSync } from "node:fs";
import { join } from "node:path";
import type {
	ChannelCapabilities,
	ChannelInboundHandler,
	ChannelMessage,
	ChannelProvider,
	ChannelStatusReporter,
} from "../gateways/channel-provider.ts";
import { readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import { isPlainRecord } from "../util/value-guards.ts";

export const TELEGRAM_CHANNEL = "telegram";

const API_BASE = "https://api.telegram.org";
/** The server holds a poll this long; the client gives up well after it, so a normal empty poll never aborts. */
const POLL_TIMEOUT_SECONDS = 25;
const POLL_ABORT_MS = 40_000;
const SEND_ABORT_MS = 30_000;
const MAX_TOKEN_FILE_BYTES = 256;
/** The same shape the diagnostic redaction masks (`core/security/secret-text.ts`). */
const TOKEN_SHAPE = /^\d{6,12}:[A-Za-z0-9_-]{30,64}$/;
/** Telegram allows about one message a second into one chat. */
const SEND_SPACING_MS = 1000;
const MAX_SEND_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
const DEFAULT_RETRY_AFTER_MS = 5000;
/** Transport failures in a row before the owner is told the channel is not receiving. */
const FAILURES_BEFORE_REPORT = 3;
const MAX_PACED_CHATS = 256;

const CONFLICT_REASON =
	"Telegram refused long polling (HTTP 409): another program polls this bot, or a webhook is set for it; stop it or delete the webhook. Polling is retried with backoff";
const TOKEN_REJECTED_REASON =
	"Telegram rejected the bot token (HTTP 401 or 404). Replace the token file; it is read again on each retry";
const UNREACHABLE_REASON = "Telegram's Bot API cannot be reached; polling is retried with backoff";

interface Backoff {
	readonly baseMs: number;
	readonly maxMs: number;
}
const TRANSIENT_BACKOFF: Backoff = { baseMs: 1000, maxMs: 5 * 60_000 };
const CONFLICT_BACKOFF: Backoff = { baseMs: 5000, maxMs: 5 * 60_000 };
const TOKEN_BACKOFF: Backoff = { baseMs: 60_000, maxMs: 30 * 60_000 };

/** Exponential delay with jitter: half the step plus up to the other half at random. */
function backoffDelay(backoff: Backoff, attempt: number): number {
	const step = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(Math.max(0, attempt - 1), 20));
	return Math.round(step / 2 + Math.random() * (step / 2));
}

type ApiOutcome =
	| { readonly kind: "ok"; readonly result: unknown }
	| { readonly kind: "refused"; readonly status: number; readonly retryAfterMs?: number }
	| { readonly kind: "unreachable" }
	| { readonly kind: "stopped" };

/** Resolves after `ms`, or at once when `signal` aborts; leaves no timer or listener behind either way. */
function pause(timers: TimerPort, ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal.aborted) {
			resolve();
			return;
		}
		const done = (): void => {
			timers.clearTimeout(handle);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const handle = timers.setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
	});
}

function retryAfterMs(payload: unknown, response: Response): number | undefined {
	const parameters = isPlainRecord(payload) ? payload.parameters : undefined;
	const seconds = isPlainRecord(parameters) ? parameters.retry_after : Number(response.headers.get("retry-after"));
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
	return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
}

const safeInteger = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);

/** One update as the core sees it: its id, and the message a person wrote the bot in a private chat (if it is one). */
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

export class TelegramChannelProvider implements ChannelProvider {
	readonly name = TELEGRAM_CHANNEL;
	readonly capabilities: ChannelCapabilities = { maxMessageChars: 4096, markdown: false };
	private readonly tokenPath: string;
	private readonly fetchOverride: typeof globalThis.fetch | undefined;
	private readonly warn: (message: string) => void;
	private readonly timers: TimerPort;
	private token: string | undefined;
	private abort: AbortController | undefined;
	private loop: Promise<void> | undefined;
	private reported: string | undefined;
	/** When each chat may receive its next message. */
	private readonly nextSendAt = new Map<string, number>();

	constructor(options: TelegramChannelProviderOptions) {
		this.tokenPath = telegramTokenPath(options.agentDir);
		this.fetchOverride = options.fetch;
		this.warn = options.warn;
		this.timers = options.timers ?? SYSTEM_TIMER_PORT;
	}

	/** Reads the token and starts polling; rejects with what the owner has to fix when the token file is not usable. */
	start(onInbound: ChannelInboundHandler, report?: ChannelStatusReporter): void {
		if (this.loop) return;
		this.token = this.readToken();
		const abort = new AbortController();
		this.abort = abort;
		this.loop = this.poll(onInbound, report, abort.signal);
	}

	async stop(): Promise<void> {
		this.abort?.abort();
		this.abort = undefined;
		const loop = this.loop;
		this.loop = undefined;
		await loop;
		this.token = undefined;
		this.reported = undefined;
		this.nextSendAt.clear();
	}

	async send(message: ChannelMessage): Promise<void> {
		const chatId = message.address;
		if (typeof chatId !== "string" || !/^-?\d{1,20}$/.test(chatId))
			throw new Error("A Telegram reply needs the chat id its conversation came from.");
		const signal = this.abort?.signal;
		if (!signal || signal.aborted) throw new Error("The Telegram channel is not running; nothing was sent.");
		const wait = (this.nextSendAt.get(chatId) ?? 0) - this.timers.now();
		if (wait > 0) await pause(this.timers, wait, signal);
		for (let attempt = 1; ; attempt++) {
			const outcome = await this.call("sendMessage", { chat_id: chatId, text: message.text }, signal, SEND_ABORT_MS);
			if (outcome.kind === "ok") {
				this.paced(chatId);
				return;
			}
			if (outcome.kind === "stopped") throw new Error("The Telegram channel stopped before the reply was sent.");
			if (outcome.kind === "unreachable")
				throw new Error(
					"Telegram did not confirm the reply (network error or timeout); it may have been delivered.",
				);
			if (outcome.status === 429 && attempt < MAX_SEND_ATTEMPTS) {
				await pause(this.timers, outcome.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, signal);
				if (signal.aborted) throw new Error("The Telegram channel stopped before the reply was sent.");
				continue;
			}
			throw new Error(this.sendRefusal(outcome.status));
		}
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

	private paced(chatId: string): void {
		const now = this.timers.now();
		if (this.nextSendAt.size >= MAX_PACED_CHATS)
			for (const [chat, at] of this.nextSendAt) if (at <= now) this.nextSendAt.delete(chat);
		this.nextSendAt.set(chatId, now + SEND_SPACING_MS);
	}

	/** The token, or a throw naming the file and what is wrong with it (never its content). */
	private readToken(): string {
		const path = this.tokenPath;
		let text: string | undefined;
		try {
			text = readOptionalBoundedTextFileSync(path, MAX_TOKEN_FILE_BYTES, "Telegram bot token file");
		} catch {
			throw new Error(
				`the Telegram bot token file ${path} cannot be read; it must be a small file holding only the token`,
			);
		}
		if (text === undefined) throw new Error(`no Telegram bot token: write it to ${path} (readable by you only)`);
		if (process.platform !== "win32") {
			let mode: number;
			try {
				mode = statSync(path).mode;
			} catch {
				throw new Error(`the Telegram bot token file ${path} cannot be read`);
			}
			if ((mode & 0o077) !== 0)
				throw new Error(`the Telegram bot token file ${path} is readable by other users; run chmod 600 on it`);
		}
		const token = text.trim();
		if (!TOKEN_SHAPE.test(token))
			throw new Error(
				`the Telegram bot token file ${path} does not hold a bot token (digits, a colon, then the secret)`,
			);
		return token;
	}

	private async call(
		method: "getUpdates" | "sendMessage",
		body: Record<string, unknown>,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<ApiOutcome> {
		const token = this.token;
		if (!token || signal.aborted) return { kind: "stopped" };
		const timeout = new AbortController();
		const handle = this.timers.setTimeout(() => timeout.abort(), timeoutMs);
		try {
			const response = await (this.fetchOverride ?? globalThis.fetch)(`${API_BASE}/bot${token}/${method}`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
				signal: AbortSignal.any([signal, timeout.signal]),
			});
			let payload: unknown;
			try {
				payload = await response.json();
			} catch {
				payload = undefined;
			}
			if (signal.aborted) return { kind: "stopped" };
			if (response.ok && isPlainRecord(payload) && payload.ok === true)
				return { kind: "ok", result: payload.result };
			const status = response.ok ? 502 : response.status;
			const retryAfter = status === 429 ? retryAfterMs(payload, response) : undefined;
			return { kind: "refused", status, ...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}) };
		} catch {
			return signal.aborted ? { kind: "stopped" } : { kind: "unreachable" };
		} finally {
			this.timers.clearTimeout(handle);
		}
	}

	private async poll(
		onInbound: ChannelInboundHandler,
		report: ChannelStatusReporter | undefined,
		signal: AbortSignal,
	): Promise<void> {
		const suspend = (reason: string): void => {
			if (this.reported === reason) return;
			this.reported = reason;
			report?.({ state: "suspended", reason });
		};
		let offset: number | undefined;
		let transient = 0;
		let conflicts = 0;
		let rejections = 0;
		let handlerFailures = 0;
		let reloadToken = false;
		let warnedUnreadable = false;
		while (!signal.aborted) {
			if (reloadToken) {
				try {
					this.token = this.readToken();
					reloadToken = false;
				} catch (error) {
					suspend(error instanceof Error ? error.message : TOKEN_REJECTED_REASON);
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
			if (outcome.kind === "ok" && Array.isArray(outcome.result)) {
				transient = 0;
				conflicts = 0;
				rejections = 0;
				if (this.reported !== undefined) {
					this.reported = undefined;
					report?.({ state: "connected" });
				}
				let handlerFailed = false;
				const before = offset;
				for (const raw of outcome.result) {
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
				if (handlerFailed || (outcome.result.length > 0 && offset === before))
					await pause(this.timers, backoffDelay(TRANSIENT_BACKOFF, ++handlerFailures), signal);
				else handlerFailures = 0;
				continue;
			}
			if (outcome.kind === "refused" && outcome.status === 409) {
				suspend(CONFLICT_REASON);
				await pause(this.timers, backoffDelay(CONFLICT_BACKOFF, ++conflicts), signal);
				continue;
			}
			if (outcome.kind === "refused" && (outcome.status === 401 || outcome.status === 404)) {
				suspend(TOKEN_REJECTED_REASON);
				reloadToken = true;
				await pause(this.timers, backoffDelay(TOKEN_BACKOFF, ++rejections), signal);
				continue;
			}
			if (outcome.kind === "refused" && outcome.status === 429) {
				await pause(this.timers, outcome.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, signal);
				continue;
			}
			transient++;
			if (transient >= FAILURES_BEFORE_REPORT)
				suspend(
					outcome.kind === "refused"
						? `Telegram's Bot API answered getUpdates with HTTP ${outcome.status}; polling is retried with backoff`
						: UNREACHABLE_REASON,
				);
			await pause(this.timers, backoffDelay(TRANSIENT_BACKOFF, transient), signal);
		}
	}
}
