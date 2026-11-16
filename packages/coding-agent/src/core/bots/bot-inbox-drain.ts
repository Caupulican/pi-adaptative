/**
 * How the host holding a bot's lock takes the bot's inbox (`bot-inbox.ts`): every waiting message, oldest first, given to
 * the bot's loaded session, the owner's words as the owner's and a mail record under its origin. A mail record is given
 * only to an idle session and stays until the turn that took it is over, so a mail that waits behind a running turn is
 * never held in the session's own queue, whose record keeps no origin, and is given under its origin after a restart. A message the session accepted leaves the queue; one it refused is kept as
 * a refused record with its reason, which every session's chat shows, and the host's own session is warned. The owner's
 * stop is taken before any message, at every pass while one waits: a message waits behind a stop not taken. One pass runs
 * per bot at a time; a change during a pass reads the inbox again when it ends. Passes start when the session is loaded,
 * when the home watch sees a message written and, while that watch does not run, on a timer.
 */
import { interfaceText } from "../language/interface-text.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { errorText } from "./bot-error-text.ts";
import { tellUnreadableHomeRecord } from "./bot-home-records.ts";
import {
	type BotInboxMessage,
	botInboxStopWaiting,
	botInboxWaiting,
	markBotInboxMailGiven,
	readBotInbox,
	readBotInboxGiven,
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
	 * Gives one message to the bot's loaded session, or leaves it waiting. Resolves `take` once the record may leave the
	 * queue (given, or a mail its transcript already holds), `given` for a mail record the session took, kept as given
	 * until its turn ends, `keep` for a mail record that waits while the session runs, `gone` when no session of the bot
	 * is loaded here any more (the message waits for the next host); rejects with the session's refusal.
	 */
	give(agentId: string, message: BotInboxMessage): Promise<BotInboxGiven>;
	/** Whether the bot's loaded session runs a turn or holds input; undefined when none is loaded here. */
	busy(agentId: string): boolean | undefined;
	/**
	 * Takes the owner's stops waiting for the bot (`bot-stop.ts`) in its loaded session: false when none is loaded here or
	 * they could not be taken (the host tells the owner and tries again); the bot's messages wait then.
	 */
	takeStops(agentId: string): boolean;
	/** An owner-facing warning of the host's own session. */
	warn(message: string): void;
	/** The bot's chat changed (a message left the queue). */
	changed(agentId: string): void;
}

/** What became of one message a pass gave (`BotInboxDrainPorts.give`). */
export type BotInboxGiven = "take" | "given" | "keep" | "gone";

export class BotInboxDrain {
	private readonly ports: BotInboxDrainPorts;
	/** The bots whose inbox a pass is taking now: whether a change asked for another read when it ends, and its end. */
	private readonly passes = new Map<string, { again: boolean; done?: Promise<void> }>();
	private poll: unknown;
	private stopped = false;

	constructor(ports: BotInboxDrainPorts) {
		this.ports = ports;
	}

	/**
	 * Takes the bot's inbox now, resolving once it was taken; a pass already running reads it again when it ends, and this
	 * resolves then.
	 */
	async drain(agentId: string): Promise<void> {
		if (this.stopped) return;
		const running = this.passes.get(agentId);
		if (running) {
			running.again = true;
			return running.done;
		}
		const pass: { again: boolean; done?: Promise<void> } = { again: false };
		this.passes.set(agentId, pass);
		pass.done = this.passesOf(agentId, pass).finally(() => this.passes.delete(agentId));
		return pass.done;
	}

	/** The passes of one drain: again while a change asked for another read during the last. */
	private async passesOf(agentId: string, pass: { again: boolean }): Promise<void> {
		do {
			pass.again = false;
			if (!(await this.pass(agentId))) return;
		} while (pass.again && !this.stopped);
	}

	/** One read of the inbox, every message given in order; false when the bot's session is no longer loaded here. */
	private async pass(agentId: string): Promise<boolean> {
		const agentDir = this.ports.agentDir();
		const words = interfaceText().botTeam;
		if (botInboxStopWaiting(agentDir, agentId) && !this.ports.takeStops(agentId)) return false;
		const busy = this.ports.busy(agentId);
		if (busy === undefined) return false;
		const unreadable = tellUnreadableHomeRecord(agentId, "inboxMessage", (message) => this.ports.warn(message));
		// The mail given before this pass: an idle session has ended the turns that took it.
		if (!busy) for (const item of readBotInboxGiven(agentDir, agentId, unreadable)) takeBotInboxMessage(item);
		const items = readBotInbox(agentDir, agentId, unreadable);
		for (const item of items) {
			if (this.stopped) return false;
			let given: BotInboxGiven;
			try {
				given = await this.ports.give(agentId, item.message);
			} catch (error) {
				const reason = errorText(error);
				refuseBotInboxMessage(agentDir, item, reason, this.ports.timers().now());
				this.ports.warn(words.botInboxRefused(agentId, reason));
				this.ports.changed(agentId);
				continue;
			}
			if (given === "gone") return false;
			if (given === "keep") continue;
			if (given === "given") markBotInboxMailGiven(item);
			else takeBotInboxMessage(item);
			this.ports.changed(agentId);
		}
		return true;
	}

	/**
	 * While the home watch does not run, reads the hosted bots' inboxes on a timer: nothing else tells this host a message
	 * or a stop was written. Armed again after each read while it hosts a bot.
	 */
	arm(): void {
		if (this.poll !== undefined || this.stopped || this.ports.hosted().length === 0 || this.ports.watching()) return;
		const timers = this.ports.timers();
		this.poll = timers.setTimeout(() => {
			this.poll = undefined;
			const agentDir = this.ports.agentDir();
			for (const agentId of this.ports.hosted())
				if (botInboxWaiting(agentDir, agentId) || botInboxStopWaiting(agentDir, agentId))
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
