/**
 * The one change of a bot's live watches that nothing writes: the first of them expires. The roster counts a bot's live
 * watches as it reads them and notes when the first one ends; at that time the bots whose watch ended are announced, to be
 * read again (which notes their next end). One timer serves every bot, at the earliest time noted.
 */
import type { TimerPort } from "../util/timer-port.ts";

/** The longest one timer waits: a later end is reached in steps, since a timer's delay is bounded. */
const MAX_WAIT_MS = 24 * 60 * 60 * 1000;

export class BotWatchExpiry {
	private readonly timers: () => TimerPort;
	private readonly expired: (agentIds: readonly string[]) => void;
	/** Each bot's first watch end noted and not reached yet. */
	private readonly ends = new Map<string, number>();
	private timer: unknown;
	/** The end the armed timer is for. */
	private timerEnd: number | undefined;
	private stopped = false;

	constructor(timers: () => TimerPort, expired: (agentIds: readonly string[]) => void) {
		this.timers = timers;
		this.expired = expired;
	}

	/** The bot's first live watch ends at `atMs`. */
	note(agentId: string, atMs: number): void {
		const noted = this.ends.get(agentId);
		if (this.stopped || (noted !== undefined && noted <= atMs)) return;
		this.ends.set(agentId, atMs);
		this.arm();
	}

	private arm(): void {
		const next = Math.min(...this.ends.values());
		if (this.timerEnd !== undefined && this.timerEnd <= next) return;
		this.disarm();
		if (!Number.isFinite(next)) return;
		const port = this.timers();
		this.timerEnd = next;
		this.timer = port.setTimeout(() => this.fire(), Math.min(Math.max(0, next - port.now()), MAX_WAIT_MS));
	}

	private disarm(): void {
		if (this.timer !== undefined) this.timers().clearTimeout(this.timer);
		this.timer = undefined;
		this.timerEnd = undefined;
	}

	private fire(): void {
		this.timer = undefined;
		this.timerEnd = undefined;
		const now = this.timers().now();
		const ended = [...this.ends].flatMap(([agentId, end]) => (end <= now ? [agentId] : []));
		for (const agentId of ended) this.ends.delete(agentId);
		this.arm();
		if (ended.length > 0) this.expired(ended);
	}

	/** Ends the timer; nothing is announced after it. */
	stop(): void {
		this.stopped = true;
		this.disarm();
		this.ends.clear();
	}
}
