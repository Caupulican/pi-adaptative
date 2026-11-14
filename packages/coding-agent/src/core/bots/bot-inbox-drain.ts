/**
 * How the host holding a bot's lock takes the bot's inbox (`bot-inbox.ts`): every waiting message, oldest first, given to
 * the bot's loaded session as the owner's words. A message the session accepted leaves the queue; one it refused is kept as
 * a refused record with its reason, which every session's chat shows, and the host's own session is warned. One pass runs
 * per bot at a time; a change during a pass reads the inbox again when it ends. Passes start when the session is loaded,
 * when the home watch sees a message written and, while that watch does not run, on a timer.
 */
import { interfaceText } from "../language/interface-text.ts";
import type { TimerPort } from "../util/timer-port.ts";
import {
	type BotInboxMessage,
	botInboxWaiting,
	readBotInbox,
	refuseBotInboxMessage,
	takeBotInboxMessage,
} from "./bot-inbox.ts";

/** How often the inboxes of the hosted bots are read while the home watch does not run. */
const INBOX_POLL_MS = 5 * 1000;

export interface BotInboxDrainPorts {
	agentDir(): string;
	timers(): TimerPort;
	/** Whether the home watch runs (it announces each message written). */
	watching(): boolean;
	/** The bots whose sessions this host runs now. */
	hosted(): readonly string[];
	/**
	 * Gives one message to the bot's loaded session. Resolves true once the session accepted it, false when no session of
	 * the bot is loaded here any more (the message waits for the next host); rejects with the session's refusal.
	 */
	give(agentId: string, message: BotInboxMessage): Promise<boolean>;
	/** An owner-facing warning of the host's own session. */
	warn(message: string): void;
	/** The bot's chat changed (a message left the queue). */
	changed(agentId: string): void;
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export class BotInboxDrain {
	private readonly ports: BotInboxDrainPorts;
	/** The bots whose inbox a pass is taking now, and whether a change asked for another read when it ends. */
	private readonly passes = new Map<string, boolean>();
	private poll: unknown;
	private stopped = false;

	constructor(ports: BotInboxDrainPorts) {
		this.ports = ports;
	}

	/** Takes the bot's inbox now; a pass already running reads it again when it ends. */
	async drain(agentId: string): Promise<void> {
		if (this.stopped) return;
		if (this.passes.has(agentId)) {
			this.passes.set(agentId, true);
			return;
		}
		try {
			do {
				this.passes.set(agentId, false);
				if (!(await this.pass(agentId))) return;
			} while (this.passes.get(agentId) === true && !this.stopped);
		} finally {
			this.passes.delete(agentId);
		}
	}

	/** One read of the inbox, every message given in order; false when the bot's session is no longer loaded here. */
	private async pass(agentId: string): Promise<boolean> {
		const agentDir = this.ports.agentDir();
		const words = interfaceText().botTeam;
		const items = readBotInbox(agentDir, agentId, (file, reason) =>
			this.ports.warn(words.botInboxUnreadable(agentId, file, reason)),
		);
		for (const item of items) {
			if (this.stopped) return false;
			let accepted: boolean;
			try {
				accepted = await this.ports.give(agentId, item.message);
			} catch (error) {
				const reason = errorText(error);
				refuseBotInboxMessage(agentDir, item, reason, this.ports.timers().now());
				this.ports.warn(words.botInboxRefused(agentId, reason));
				this.ports.changed(agentId);
				continue;
			}
			if (!accepted) return false;
			takeBotInboxMessage(item);
			this.ports.changed(agentId);
		}
		return true;
	}

	/**
	 * While the home watch does not run, reads the hosted bots' inboxes on a timer: nothing else tells this host a message
	 * was written. Armed again after each read while it hosts a bot.
	 */
	arm(): void {
		if (this.poll !== undefined || this.stopped || this.ports.hosted().length === 0 || this.ports.watching()) return;
		const timers = this.ports.timers();
		this.poll = timers.setTimeout(() => {
			this.poll = undefined;
			const agentDir = this.ports.agentDir();
			for (const agentId of this.ports.hosted())
				if (botInboxWaiting(agentDir, agentId))
					void this.drain(agentId).catch((error: unknown) =>
						this.ports.warn(interfaceText().botTeam.botInboxNotTaken(agentId, errorText(error))),
					);
			this.arm();
		}, INBOX_POLL_MS);
	}

	/** No pass starts after it, and the timer ends. */
	stop(): void {
		this.stopped = true;
		if (this.poll !== undefined) this.ports.timers().clearTimeout(this.poll);
		this.poll = undefined;
	}
}
