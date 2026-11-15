/**
 * The opening of a bot's session again after a failure that passes on its own: the process or the system ran out of file
 * handles, a disk, file or lock was busy or failed to read for now, a file was not readable (its permissions can be set
 * right), or a session of the owner holds the bot's conversation open, which the bot's host may not join
 * (`SessionHeldError`). Such a failure is not the bot's definition's, so it does not wait for the definition or the
 * inbox to change: the session is opened again after a backoff that doubles from `BOT_OPEN_RETRY_FIRST_MS` to at most
 * `BOT_OPEN_RETRY_MAX_MS`, for as long as the bot is owed work, until it opens, is released or the host stops.
 */
import { SessionHeldError } from "../../kernel/session/session-bundle-lifecycle.ts";
import { interfaceText } from "../language/interface-text.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "../util/timer-port.ts";

/** The error codes of a read or open that a later attempt can get past. */
const PASSING_CODES: ReadonlySet<string> = new Set(["EMFILE", "ENFILE", "EAGAIN", "EBUSY", "EIO", "EACCES"]);

export const BOT_OPEN_RETRY_FIRST_MS = 2_000;
export const BOT_OPEN_RETRY_MAX_MS = 5 * 60 * 1000;

/** Whether the bot's session failed to open for a cause that passes on its own (see the module comment). */
export function opensLater(error: unknown): boolean {
	if (error instanceof SessionHeldError) return true;
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	return typeof code === "string" && PASSING_CODES.has(code);
}

/** Why the bot's session did not open, in the owner's words: a session of theirs holding it open, else the error's text. */
export function botOpenFailureText(agentId: string, error: unknown): string {
	if (error instanceof SessionHeldError)
		return interfaceText().botTeam.botSessionOpenInSession(
			agentId,
			error.holders.map((holder) => holder.pid).join(", "),
		);
	return error instanceof Error ? error.message : String(error);
}

/** What the retries read from the host. */
export interface BotOpenRetryPorts {
	/** The clock the next attempt is due on. */
	timers(): TimerPort;
	/** Whether the host stopped: nothing is armed after. */
	stopped(): boolean;
	/** Opens the bot's session again when it is still owed work. */
	retry(agentId: string): void;
}

/** The armed next attempt of each bot whose session failed to open for a passing cause, with its backoff. */
export class BotOpenRetries {
	private readonly ports: BotOpenRetryPorts;
	private readonly armed = new Map<string, { readonly failures: number; readonly alarm: WallAlarm }>();

	constructor(ports: BotOpenRetryPorts) {
		this.ports = ports;
	}

	/** Arms the bot's next attempt, a backoff after the last: each failure in a row doubles it, up to the cap. */
	arm(agentId: string): void {
		const previous = this.armed.get(agentId);
		previous?.alarm.stop();
		if (this.ports.stopped()) {
			this.armed.delete(agentId);
			return;
		}
		const failures = (previous?.failures ?? 0) + 1;
		const delay = Math.min(BOT_OPEN_RETRY_FIRST_MS * 2 ** (failures - 1), BOT_OPEN_RETRY_MAX_MS);
		const timers = this.ports.timers();
		const alarm = alarmAt(timers, timers.now() + delay, () => this.ports.retry(agentId));
		this.armed.set(agentId, { failures, alarm });
	}

	/** The bot's session opened, or the bot was released: its backoff starts again from the first. */
	forget(agentId: string): void {
		this.armed.get(agentId)?.alarm.stop();
		this.armed.delete(agentId);
	}

	stop(): void {
		for (const { alarm } of this.armed.values()) alarm.stop();
		this.armed.clear();
	}
}
