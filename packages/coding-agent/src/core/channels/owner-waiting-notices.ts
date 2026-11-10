/**
 * Tells the owner's chats of the calls that wait on the owner in the session that hosts their work: a held action, a
 * question, a held plan step, a decision left for later. A call that has waited `OWNER_WAITING_NOTICE_AFTER_MS` is told
 * once, in the one line the session's status shows it by and with the directory the session works in, so an owner who
 * left the terminal hears of it on the phone. Nothing is told while the owner answers within that time.
 *
 * It tells the end of work the same way: a session read working for that long and then at rest for as long is told
 * once, with why it rests (its goal is complete or blocked, a question waits at the terminal, or nothing is left to do).
 * A short turn, or an owner who gives the session its next work within that time, hears nothing.
 *
 * The session's waiting calls are read at most once per `READ_SPACING_MS` however often the session reports a change,
 * never inside the write that reported it, and one alarm reads them again when the next call comes of age, so a session
 * at rest reads nothing.
 */

import { basename } from "node:path";
import { oneLine, truncateWithEllipsis } from "../provider-tool-text.ts";
import { hasMaskableSecretText } from "../security/secret-text.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { digest } from "./channel-journal.ts";
import type { OwnerWaitingCall, OwnerWaitingView } from "./owner-channel-types.ts";
import type { OwnerPush } from "./owner-push.ts";

/** A call that has waited on the owner this long is told to the owner's chats. A constant: no setting. */
export const OWNER_WAITING_NOTICE_AFTER_MS = 2 * 60_000;
/** The waiting calls are read at most once in this long, and a working session is read again after this long. */
export const OWNER_WAITING_READ_SPACING_MS = 30_000;
const READ_SPACING_MS = OWNER_WAITING_READ_SPACING_MS;
const SPACE_MAX_CHARS = 48;
/** Waiting calls one `status` reply lists; the rest are counted. */
const MAX_STATUS_CALLS = 5;

export interface OwnerWaitingNoticesDeps {
	/** The owner's chats: whether any channel carries owner authority now, and the notices told and taken back. */
	readonly push: Pick<OwnerPush, "hasOwnerChannel" | "tell" | "retract">;
	/** The calls waiting on the owner in the session that hosts the owner's work; undefined when no session does. */
	waiting(): OwnerWaitingView | undefined;
	/** The clock the ages are measured on and the alarm waits on. */
	readonly timers: TimerPort;
	warn(message: string): void;
}

/** The push key of one waiting call: the session, the call, and when it started waiting (a call held again is told again). */
function noticeKey(sessionId: string, call: OwnerWaitingCall): string {
	return `waiting:${digest(sessionId).slice(0, 12)}:${call.key}${call.since === undefined ? "" : `:${call.since}`}`;
}

/** The directory a session works in, as a chat names it; a name that looks like it holds a secret is not sent. */
function spaceName(cwd: string): string {
	const named = truncateWithEllipsis(oneLine(basename(cwd)), SPACE_MAX_CHARS);
	return named === "" || hasMaskableSecretText(named) ? "a session" : named;
}

/** A waiting call's one line, as a chat is told it; a line that looks like it holds a secret is not sent. */
function callLine(call: OwnerWaitingCall): string {
	const what = oneLine(call.what);
	return what === "" || hasMaskableSecretText(what)
		? "a call only you can decide (its text is shown at the terminal only)"
		: what;
}

/** The notice of one waiting call: the directory its session works in and the call's one line. */
export function waitingNoticeText(cwd: string, call: OwnerWaitingCall): string {
	return `Waiting on you in ${spaceName(cwd)}: ${callLine(call)}`;
}

/** The push key of a session come to rest after a stretch of work. */
function restKey(sessionId: string, restAt: number): string {
	return `rest:${digest(sessionId).slice(0, 12)}:${restAt}`;
}

/** The notice of a session at rest after `workedMs` of work: why it rests, and how many calls wait on the owner there. */
export function restNoticeText(view: OwnerWaitingView, workedMs: number): string {
	const space = spaceName(view.cwd);
	const minutes = Math.max(1, Math.floor(workedMs / 60_000));
	const waits = view.calls.length === 0 ? "" : ` ${view.calls.length} call(s) wait on you.`;
	switch (view.work.phase) {
		case "done":
			return `Finished in ${space} after ${minutes} min: the goal is complete.${waits}`;
		case "blocked":
			return `Stopped in ${space} after ${minutes} min: the goal is blocked.${waits}`;
		case "waiting_user":
			return `Stopped in ${space} after ${minutes} min: a question waits for you at the terminal.${waits}`;
		default:
			return `At rest in ${space} after ${minutes} min of work.${waits}`;
	}
}

/** The `status` line of the calls waiting on the owner in the hosting session; none while nothing waits. */
export function waitingStatusLine(view: OwnerWaitingView | undefined): string | undefined {
	if (view === undefined || view.calls.length === 0) return undefined;
	const listed = view.calls.slice(0, MAX_STATUS_CALLS).map(callLine);
	const more = view.calls.length - listed.length;
	return `Waiting on you in ${spaceName(view.cwd)}: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}`;
}

export class OwnerWaitingNotices {
	private readonly deps: OwnerWaitingNoticesDeps;
	/** When each waiting call with no recorded time was first read as waiting, by its key. */
	private readonly firstRead = new Map<string, number>();
	/** The push key each waiting call was told under, by the call's key. */
	private readonly told = new Map<string, string>();
	/** The stretch of work in progress: when the session was first read working, and first read at rest after it. */
	private stretch: { readonly since: number; readonly restAt?: number } | undefined;
	private lastReadAt: number | undefined;
	private alarm: { readonly at: number; readonly handle: unknown } | undefined;
	/** The last reading found a channel that carries owner authority and a session to read: only then does an alarm wait. */
	private listening = false;
	/** The reading queued past the caller's stack; `stop` leaves it nothing to do. */
	private queued: object | undefined;
	private failure: string | undefined;

	constructor(deps: OwnerWaitingNoticesDeps) {
		this.deps = deps;
	}

	/**
	 * The session's waiting calls may have changed: read them past the caller's stack (a session reports a change from
	 * inside its own write), or once the reading spacing allows.
	 */
	touch(): void {
		const now = this.deps.timers.now();
		const allowedAt = this.lastReadAt === undefined ? now : this.lastReadAt + READ_SPACING_MS;
		if (now < allowedAt) {
			// While no chat would hear of it, a change inside the spacing arms nothing: the next one past it reads again.
			if (this.listening && (this.alarm === undefined || this.alarm.at > allowedAt)) this.arm(allowedAt, now);
			return;
		}
		if (this.queued !== undefined) return;
		const queued = {};
		this.queued = queued;
		queueMicrotask(() => {
			if (this.queued !== queued) return;
			this.queued = undefined;
			this.read(this.deps.timers.now());
		});
	}

	/** The session stopped serving channels: nothing is read or armed until it is touched again. */
	stop(): void {
		this.disarm();
		this.queued = undefined;
		this.listening = false;
		this.firstRead.clear();
		this.told.clear();
		this.stretch = undefined;
		this.lastReadAt = undefined;
	}

	/** Tell the calls that came of age, take back the told ones that no longer wait, and arm the next reading. */
	private read(now: number): void {
		this.lastReadAt = now;
		this.disarm();
		let view: OwnerWaitingView | undefined;
		try {
			// Nothing is read while no channel carries owner authority: no chat would hear of it.
			view = this.deps.push.hasOwnerChannel() ? this.deps.waiting() : undefined;
			this.failure = undefined;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (this.failure !== reason)
				this.deps.warn(`The calls waiting on the owner could not be read for the owner's chat: ${reason}`);
			this.failure = reason;
			return;
		}
		this.listening = view !== undefined;
		const waiting = new Set(view?.calls.map((call) => call.key));
		for (const [key, pushKey] of this.told) {
			if (waiting.has(key)) continue;
			this.told.delete(key);
			this.deps.push.retract(pushKey);
		}
		for (const key of this.firstRead.keys()) if (!waiting.has(key)) this.firstRead.delete(key);
		if (view === undefined) {
			this.stretch = undefined;
			return;
		}
		let nextAt = this.readWork(view, now);
		for (const call of view.calls) {
			if (this.told.has(call.key)) continue;
			const since = call.since ?? this.firstRead.get(call.key) ?? now;
			if (call.since === undefined) this.firstRead.set(call.key, since);
			const dueAt = since + OWNER_WAITING_NOTICE_AFTER_MS;
			if (now < dueAt) {
				nextAt = nextAt === undefined ? dueAt : Math.min(nextAt, dueAt);
				continue;
			}
			const pushKey = noticeKey(view.sessionId, call);
			this.told.set(call.key, pushKey);
			this.deps.push.tell(pushKey, waitingNoticeText(view.cwd, call));
		}
		if (nextAt !== undefined) this.arm(nextAt, now);
	}

	/**
	 * Follow the session's work. A stretch read working for `OWNER_WAITING_NOTICE_AFTER_MS` and then at rest for as long
	 * is told once. Returns when to read again: the next heartbeat while it works (its end may write nothing to the
	 * session), the moment its rest comes of age, or nothing at rest with nothing to tell.
	 */
	private readWork(view: OwnerWaitingView, now: number): number | undefined {
		const stretch = this.stretch;
		if (view.work.busy) {
			this.stretch = { since: stretch?.since ?? now };
			return now + READ_SPACING_MS;
		}
		this.stretch = undefined;
		if (stretch === undefined) return undefined;
		const restAt = stretch.restAt ?? now;
		if (restAt - stretch.since < OWNER_WAITING_NOTICE_AFTER_MS) return undefined;
		if (now - restAt < OWNER_WAITING_NOTICE_AFTER_MS) {
			this.stretch = { since: stretch.since, restAt };
			return restAt + OWNER_WAITING_NOTICE_AFTER_MS;
		}
		this.deps.push.tell(restKey(view.sessionId, restAt), restNoticeText(view, restAt - stretch.since));
		return undefined;
	}

	private arm(at: number, now: number): void {
		this.disarm();
		const handle = this.deps.timers.setTimeout(
			() => {
				if (this.alarm?.handle !== handle) return;
				this.alarm = undefined;
				this.read(this.deps.timers.now());
			},
			Math.max(0, at - now),
		);
		this.alarm = { at, handle };
	}

	private disarm(): void {
		if (this.alarm === undefined) return;
		this.deps.timers.clearTimeout(this.alarm.handle);
		this.alarm = undefined;
	}
}
