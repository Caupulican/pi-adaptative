/**
 * The pieces every shipped channel transport shares: its token files, its HTTPS calls, its retry pacing and the way it
 * tells the core that it lost or regained its connection. Every text built here is Pi's own words: a token, a URL or
 * an error the runtime or the remote side produced never enters one.
 */

import { statSync } from "node:fs";
import type { ChannelStatusReporter } from "../gateways/channel-provider.ts";
import { readOptionalBoundedTextFileSync } from "../util/bounded-file.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { isPlainRecord } from "../util/value-guards.ts";

const MAX_TOKEN_FILE_BYTES = 256;
const MAX_RETRY_AFTER_MS = 5 * 60_000;
/** The wait after a 429 that named none. */
export const DEFAULT_RETRY_AFTER_MS = 5000;
const MAX_SEND_ATTEMPTS = 3;
const MAX_PACED_DESTINATIONS = 256;
/** Transport failures in a row before the owner is told the channel is not receiving. */
const FAILURES_BEFORE_REPORT = 3;

export interface Backoff {
	readonly baseMs: number;
	readonly maxMs: number;
}

/** Exponential delay with jitter: half the step plus up to the other half at random. */
export function backoffDelay(backoff: Backoff, attempt: number): number {
	const step = Math.min(backoff.maxMs, backoff.baseMs * 2 ** Math.min(Math.max(0, attempt - 1), 20));
	return Math.round(step / 2 + Math.random() * (step / 2));
}

/** Resolves after `ms`, or at once when `signal` aborts; leaves no timer or listener behind either way. */
export function pause(timers: TimerPort, ms: number, signal: AbortSignal): Promise<void> {
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

/** A wait the remote side asked for, in seconds, bounded; undefined when it is not a usable number. */
export function boundedRetryAfterMs(seconds: unknown): number | undefined {
	if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
	return Math.min(MAX_RETRY_AFTER_MS, Math.ceil(seconds * 1000));
}

/** One secret a transport reads from its own file under `<agentDir>/channels/`. */
export interface ChannelTokenFile {
	readonly path: string;
	/** What the owner calls the file's content, e.g. "Telegram bot token". */
	readonly label: string;
	readonly shape: RegExp;
	/** What the content must be, e.g. "a bot token (digits, a colon, then the secret)". */
	readonly shapeHint: string;
}

/** The token, or a throw naming the file and what is wrong with it (never its content). */
export function readChannelTokenFile(file: ChannelTokenFile): string {
	const { path, label } = file;
	let text: string | undefined;
	try {
		text = readOptionalBoundedTextFileSync(path, MAX_TOKEN_FILE_BYTES, `${label} file`);
	} catch {
		throw new Error(`the ${label} file ${path} cannot be read; it must be a small file holding only the token`);
	}
	if (text === undefined) throw new Error(`no ${label}: write it to ${path} (readable by you only)`);
	if (process.platform !== "win32") {
		let mode: number;
		try {
			mode = statSync(path).mode;
		} catch {
			throw new Error(`the ${label} file ${path} cannot be read`);
		}
		if ((mode & 0o077) !== 0)
			throw new Error(`the ${label} file ${path} is readable by other users; run chmod 600 on it`);
	}
	const token = text.trim();
	if (!file.shape.test(token)) throw new Error(`the ${label} file ${path} does not hold ${file.shapeHint}`);
	return token;
}

/** How one call of a JSON Web API ended. Both shipped APIs answer `{ "ok": true, ... }` on success. */
export type ApiOutcome =
	| { readonly kind: "ok"; readonly payload: Record<string, unknown> }
	| {
			readonly kind: "refused";
			readonly status: number;
			/** The parsed answer, for the provider's own reading of its error fields; never shown. */
			readonly payload: unknown;
			readonly retryAfterMs?: number;
	  }
	| { readonly kind: "unreachable" }
	| { readonly kind: "stopped" };

export type RefusedApiOutcome = Extract<ApiOutcome, { kind: "refused" }>;

export interface JsonApiCall {
	readonly fetch: typeof globalThis.fetch;
	readonly timers: TimerPort;
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
	/** Sent as JSON; omitted sends no body. */
	readonly body?: Readonly<Record<string, unknown>>;
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
}

/** One POST, bounded by `timeoutMs` and ended by `signal`. A refusal carries the HTTP status and any `Retry-After`. */
export async function postJsonApi(call: JsonApiCall): Promise<ApiOutcome> {
	const { signal } = call;
	if (signal.aborted) return { kind: "stopped" };
	const timeout = new AbortController();
	const handle = call.timers.setTimeout(() => timeout.abort(), call.timeoutMs);
	try {
		const response = await call.fetch(call.url, {
			method: "POST",
			headers: {
				...(call.body !== undefined ? { "content-type": "application/json; charset=utf-8" } : {}),
				...call.headers,
			},
			...(call.body !== undefined ? { body: JSON.stringify(call.body) } : {}),
			signal: AbortSignal.any([signal, timeout.signal]),
		});
		let payload: unknown;
		try {
			payload = await response.json();
		} catch {
			payload = undefined;
		}
		if (signal.aborted) return { kind: "stopped" };
		if (response.ok && isPlainRecord(payload) && payload.ok === true) return { kind: "ok", payload };
		const retryAfter =
			response.status === 429 ? boundedRetryAfterMs(Number(response.headers.get("retry-after"))) : undefined;
		return {
			kind: "refused",
			status: response.status,
			payload,
			...(retryAfter !== undefined ? { retryAfterMs: retryAfter } : {}),
		};
	} catch {
		return signal.aborted ? { kind: "stopped" } : { kind: "unreachable" };
	} finally {
		call.timers.clearTimeout(handle);
	}
}

/** When each destination (a chat, a conversation) may receive its next message. */
export class SendPacer {
	private readonly timers: TimerPort;
	private readonly spacingMs: number;
	private readonly nextSendAt = new Map<string, number>();

	constructor(timers: TimerPort, spacingMs: number) {
		this.timers = timers;
		this.spacingMs = spacingMs;
	}

	async wait(destination: string, signal: AbortSignal): Promise<void> {
		const wait = (this.nextSendAt.get(destination) ?? 0) - this.timers.now();
		if (wait > 0) await pause(this.timers, wait, signal);
	}

	sent(destination: string): void {
		const now = this.timers.now();
		if (this.nextSendAt.size >= MAX_PACED_DESTINATIONS)
			for (const [entry, at] of this.nextSendAt) if (at <= now) this.nextSendAt.delete(entry);
		this.nextSendAt.set(destination, now + this.spacingMs);
	}

	clear(): void {
		this.nextSendAt.clear();
	}
}

export interface PacedSend {
	/** The service's name in the texts, e.g. "Telegram". */
	readonly service: string;
	readonly destination: string;
	/** The running transport's stop signal; undefined while it is not running. */
	readonly signal: AbortSignal | undefined;
	readonly timers: TimerPort;
	readonly pacer: SendPacer;
	readonly call: (signal: AbortSignal) => Promise<ApiOutcome>;
	/** Why a final refusal sent nothing (or may have), in the provider's own words. */
	readonly refusal: (outcome: RefusedApiOutcome) => string;
}

/**
 * One outbound message: paced per destination, retried after a 429 (at most three tries). Every other failure throws;
 * an unconfirmed one says the message may have been delivered, so the core keeps the draft and never sends it twice.
 */
export async function sendPaced(send: PacedSend): Promise<void> {
	const { signal, service } = send;
	if (!signal || signal.aborted) throw new Error(`The ${service} channel is not running; nothing was sent.`);
	await send.pacer.wait(send.destination, signal);
	for (let attempt = 1; ; attempt++) {
		const outcome = await send.call(signal);
		if (outcome.kind === "ok") {
			send.pacer.sent(send.destination);
			return;
		}
		if (outcome.kind === "stopped") throw new Error(`The ${service} channel stopped before the reply was sent.`);
		if (outcome.kind === "unreachable")
			throw new Error(
				`${service} did not confirm the reply (network error or timeout); it may have been delivered.`,
			);
		if (outcome.status === 429 && attempt < MAX_SEND_ATTEMPTS) {
			await pause(send.timers, outcome.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, signal);
			if (signal.aborted) throw new Error(`The ${service} channel stopped before the reply was sent.`);
			continue;
		}
		throw new Error(send.refusal(outcome));
	}
}

/**
 * One run of a transport's receive loop as the core hears of it: each distinct suspension once, `connected` once after
 * one, and transient failures only once they repeat.
 */
export class ConnectionReport {
	private readonly report: ChannelStatusReporter | undefined;
	private reported: string | undefined;
	private failures = 0;

	constructor(report: ChannelStatusReporter | undefined) {
		this.report = report;
	}

	suspend(reason: string): void {
		if (this.reported === reason) return;
		this.reported = reason;
		this.report?.({ state: "suspended", reason });
	}

	/** The transport receives again: the failure count restarts and a reported suspension ends. */
	connected(): void {
		this.failures = 0;
		if (this.reported === undefined) return;
		this.reported = undefined;
		this.report?.({ state: "connected" });
	}

	/** One more transient failure in a row; from the third on the owner is told `reason`. Returns the count. */
	failed(reason: string): number {
		this.failures++;
		if (this.failures >= FAILURES_BEFORE_REPORT) this.suspend(reason);
		return this.failures;
	}
}
