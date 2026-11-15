/**
 * The opening of a bot's session again after a failure that passes on its own, judged by where it came from: a read of
 * the bot's session store (its pointer, its session file, the move of its state, its lease registry) that found the
 * process or the system out of file handles, a file busy, or a file replaced while it was read, or that waited past a
 * lock another process holds, wherever the lock lies (the bot team's store, a session file) (`busy`), a disk
 * that failed to read (`failing`), a file this process may not read (`permission`), or a holder of the bot's
 * conversation that keeps its host out (`held`: `SessionHeldError`). Such a failure is not the bot's definition's, so
 * it does not wait for the definition or the inbox to change: the session is opened again after a backoff that doubles
 * from `BOT_OPEN_RETRY_FIRST_MS` to at most `BOT_OPEN_RETRY_MAX_MS`, for as long as the bot is owed work, until it
 * opens, is released or the host stops. A failing disk or a permission is tried `BOT_OPEN_RETRY_CAPPED` times in a
 * row, then not again until something asks (an owner's send, which fails with the cause, or a change of the bot).
 */
import { isAbsolute, relative } from "node:path";
import { SessionHeldError } from "../../kernel/session/session-bundle-lifecycle.ts";
import { FileSnapshotChangedError } from "../../kernel/storage/bounded-file.ts";
import { interfaceText } from "../language/interface-text.ts";
import { alarmAt, type TimerPort, type WallAlarm } from "../util/timer-port.ts";
import { isLockBusy } from "./bot-failure-words.ts";
import { BotOwnerError } from "./bot-owner-error.ts";

export const BOT_OPEN_RETRY_FIRST_MS = 2_000;
export const BOT_OPEN_RETRY_MAX_MS = 5 * 60 * 1000;
/** How many times in a row a failing disk or a permission is tried again (2 s to 32 s, a minute in all). */
export const BOT_OPEN_RETRY_CAPPED = 5;

/** Why the bot's session opens later (see the module comment). */
export type BotOpenFailure = "busy" | "failing" | "permission" | "held";

const STORE_CODES: ReadonlyMap<string, Exclude<BotOpenFailure, "held">> = new Map([
	["EMFILE", "busy"],
	["ENFILE", "busy"],
	["EAGAIN", "busy"],
	["EBUSY", "busy"],
	["EIO", "failing"],
	["EACCES", "permission"],
	["EPERM", "permission"],
]);

/** A read of the bot's session store failed for a cause that passes on its own; its message is the owner's words. */
export class BotSessionStoreError extends BotOwnerError {
	readonly failure: Exclude<BotOpenFailure, "held">;
	constructor(agentId: string, failure: Exclude<BotOpenFailure, "held">, cause: unknown) {
		const words = interfaceText().botTeam;
		super(
			failure === "busy"
				? words.botSessionStoreBusy(agentId)
				: failure === "failing"
					? words.botSessionStoreFailing(agentId)
					: words.botSessionStorePermission(agentId),
			{ cause },
		);
		this.name = "BotSessionStoreError";
		this.failure = failure;
	}
}

/**
 * `error` as {@link BotSessionStoreError} when it is a read of bot `agentId`'s session store that passes on its own,
 * else `error` itself. `within`: the directory the store's files of this step lie in (a step that does other work
 * too: only a file error on a path inside it is the store's); undefined when the whole step reads the store. A lock
 * another process holds past the wait (`isLockBusy`) is busy wherever it lies: it passes on its own, and a Windows
 * `EPERM` that is such contention is not a permission.
 */
export function storeFailure(agentId: string, error: unknown, within: string | undefined): unknown {
	if (isLockBusy(error)) return new BotSessionStoreError(agentId, "busy", error);
	if (error instanceof FileSnapshotChangedError)
		return within === undefined ? new BotSessionStoreError(agentId, "busy", error) : error;
	const { code, path } = (error ?? {}) as NodeJS.ErrnoException;
	const failure = typeof code === "string" ? STORE_CODES.get(code) : undefined;
	if (failure === undefined) return error;
	if (within !== undefined) {
		const offset = typeof path === "string" ? relative(within, path) : "..";
		if (offset.startsWith("..") || isAbsolute(offset)) return error;
	}
	return new BotSessionStoreError(agentId, failure, error);
}

/** Whether `failure` is tried again only `BOT_OPEN_RETRY_CAPPED` times in a row: a failing disk or a permission. */
export function cappedFailure(failure: BotOpenFailure): boolean {
	return failure === "failing" || failure === "permission";
}

/** Why the bot's session failed to open, when it is for a cause that passes on its own. */
export function botOpenFailure(error: unknown): BotOpenFailure | undefined {
	if (error instanceof SessionHeldError) return "held";
	return error instanceof BotSessionStoreError ? error.failure : undefined;
}

/** What the retries read from the host. */
export interface BotOpenRetryPorts {
	/** The clock the next attempt is due on. */
	timers(): TimerPort;
	/** Whether the host stopped: nothing is armed after. */
	stopped(): boolean;
	/** Asks again for the bot (opens its session, or runs its owed release). */
	retry(agentId: string): void;
}

/** One bot's attempts: how many failed in a row, how many of them for a capped cause, and the next one, while it is due. */
interface Attempts {
	readonly failures: number;
	readonly capped: number;
	alarm: WallAlarm | undefined;
}

/** The armed next attempt of each bot whose session failed to open for a passing cause, with its backoff. */
export class BotOpenRetries {
	private readonly ports: BotOpenRetryPorts;
	private readonly attempts = new Map<string, Attempts>();

	constructor(ports: BotOpenRetryPorts) {
		this.ports = ports;
	}

	/**
	 * Arms the bot's next attempt after a failure, a backoff after the last: each failure in a row doubles it, up to the
	 * cap. False, and nothing armed, when the host stopped or `capped` failures (`cappedFailure`) failed
	 * `BOT_OPEN_RETRY_CAPPED` times in a row before this one.
	 */
	arm(agentId: string, capped: boolean): boolean {
		const previous = this.attempts.get(agentId);
		previous?.alarm?.stop();
		if (this.ports.stopped()) {
			this.attempts.delete(agentId);
			return false;
		}
		const failures = (previous?.failures ?? 0) + 1;
		// Only failures for a capped cause in a row count to the cap: any other failure, like an open, starts it again.
		const cappedInRow = capped ? (previous?.capped ?? 0) + 1 : 0;
		const next: Attempts = { failures, capped: cappedInRow, alarm: undefined };
		this.attempts.set(agentId, next);
		if (cappedInRow > BOT_OPEN_RETRY_CAPPED) return false;
		const delay = Math.min(BOT_OPEN_RETRY_FIRST_MS * 2 ** (failures - 1), BOT_OPEN_RETRY_MAX_MS);
		const timers = this.ports.timers();
		next.alarm = alarmAt(timers, timers.now() + delay, () => {
			next.alarm = undefined;
			this.ports.retry(agentId);
		});
		return true;
	}

	/** Whether the bot's next attempt is armed and not yet due: nothing else needs to ask for it meanwhile. */
	pending(agentId: string): boolean {
		return this.attempts.get(agentId)?.alarm !== undefined;
	}

	/** The bot's session opened, it is owed nothing, or it was released: its backoff starts again from the first. */
	forget(agentId: string): void {
		this.attempts.get(agentId)?.alarm?.stop();
		this.attempts.delete(agentId);
	}

	stop(): void {
		for (const { alarm } of this.attempts.values()) alarm?.stop();
		this.attempts.clear();
	}
}
