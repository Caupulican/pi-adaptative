/**
 * The release of a bot's session, once the bot was retired or left the session path: its workers ended for the owner's
 * reason (a loaded session's fleet and the jobs its home's other sessions placed, or a closed session's work under its host
 * lock), the watches its session armed dropped, and the messages waiting in its inbox refused; a loaded session is closed
 * once its workers ended. What a release could not finish stays owed and runs whole again after a backoff, the owner told
 * once, until it is done or the bot is back on the session path.
 */
import type { AgentSession } from "../agent-session.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { OWNER_STOPPED_REASON, type WorkerStopOutcome } from "../delegation/worker-fleet-stop.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { errorText } from "./bot-error-text.ts";
import { botFailureText } from "./bot-failure-words.ts";
import { type BotInboxItem, refuseBotInboxMessage } from "./bot-inbox.ts";
import { BotOpenRetries } from "./bot-open-retry.ts";
import { BotOwnerError } from "./bot-owner-error.ts";
import type { SavedBotSession } from "./bot-remote-view.ts";
import { endClosedBotWork, endLoadedBotWork, readClosedBotSession } from "./bot-stop.ts";

/** What a release reads from the host of the bots' sessions. */
export interface BotReleasePorts {
	agentDir(): string;
	store(): Pick<PersistentBotTeamStore, "getBot" | "listRoutines" | "deleteRoutine">;
	/** The host's timers: the watches are dropped and the retries run on its clock. */
	timers(): TimerPort;
	/** Whether the host stopped: no release runs again after it. */
	stopped(): boolean;
	warn(message: string): void;
	/**
	 * The bot's session this process has loaded, with whether its work holds it loaded (`busy`: the idleness its idle close
	 * reads, so a release waits on what a close waits on); undefined when none is loaded here.
	 */
	loaded(
		agentId: string,
	): { readonly session: Pick<AgentSession, "sessionId" | "backgroundLanes">; readonly busy: boolean } | undefined;
	/** A load or a close of the bot's session this process runs now (it holds the bot's lock), undefined when none. */
	settling(agentId: string): Promise<unknown> | undefined;
	/** The bot's own session as its home saved it, read through a linked pointer or session file; throws when its home does not read. */
	savedSessionOf(agentId: string): SavedBotSession | undefined;
	/**
	 * The bot's own session as the work of its closed session is ended from it: a linked pointer or session file is refused
	 * (`BotSessionLinkError`), since the end is written to the bundle of the session the file names.
	 */
	closedSessionOf(agentId: string): SavedBotSession | undefined;
	/** The messages waiting in the bot's inbox, oldest first. */
	waiting(agentId: string): readonly BotInboxItem[];
	/** Whether the record answers in a session of its own. */
	runsAsSession(record: PersistentBotRecord): boolean;
	/** The bot was released: what it was owed is not taken up. */
	released(agentId: string): void;
	/** The bot's inbox changed. */
	changed(agentId: string): void;
	/** Closes the bot's loaded session. */
	close(agentId: string): Promise<void>;
}

/** The releases of the bots' sessions, and the ones owed (see the module comment). */
export class BotRelease {
	private readonly ports: BotReleasePorts;
	/** Bots whose release failed: it runs again after a backoff until it is done, and the owner was told once. */
	private readonly owed = new Set<string>();
	private readonly retries: BotOpenRetries;

	constructor(ports: BotReleasePorts) {
		this.ports = ports;
		this.retries = new BotOpenRetries({
			timers: () => ports.timers(),
			stopped: () => ports.stopped(),
			retry: (agentId) => this.releaseOwed(agentId),
		});
	}

	/** Releases the bot's session now ({@link prepare}, then its change step). Refuses while it works. */
	release(agentId: string): void {
		this.prepare(agentId)();
	}

	/**
	 * A release in two steps: what it changes is read now (the bot's session, its watches, its inbox), and a refusal or a
	 * failed read throws here, before anything changed; the returned step changes it, once the caller's own change (a
	 * retirement) is made, reading it again then, and never throws: what it could not finish stays owed ({@link finish}).
	 */
	prepare(agentId: string): () => void {
		const { ports } = this;
		const loaded = ports.loaded(agentId);
		if (loaded?.busy) throw new BotOwnerError(interfaceText().botTeam.botHasActiveWork(agentId));
		const sessionId = loaded?.session.sessionId ?? ports.savedSessionOf(agentId)?.id;
		if (sessionId !== undefined) ports.store().listRoutines({ sessionId, scope: "own-watches" });
		ports.waiting(agentId);
		return () => this.finish(agentId, sessionId, loaded !== undefined);
	}

	/**
	 * Releases the bot (it left the session path, or a release it owes runs again): a failure leaves it owed, run again
	 * after a backoff until it is done. A bot back on the session path owes none.
	 */
	releaseOwed(agentId: string): void {
		try {
			const record = this.ports.store().getBot(agentId);
			if (record && !record.retired && this.ports.runsAsSession(record)) {
				this.owed.delete(agentId);
				this.retries.forget(agentId);
				return;
			}
			this.release(agentId);
		} catch (error) {
			this.owe(agentId, error);
		}
	}

	/** The host stopped: no owed release runs again. */
	stop(): void {
		this.retries.stop();
	}

	/**
	 * The change step of a release: the watches and the inbox are read again now, so a watch armed or changed and a message
	 * sent since the preparation go too, each watch dropped at the revision read. A loaded session's workers end first
	 * (`endLoadedBotWork`), and it closes once they did; a closed session's work ends last, under its host lock
	 * (`endClosedBotWork`), once a load or a close of it this process runs settled. A failure (a revision that changed
	 * again, a read, the lock another process holds) leaves the release owed: it runs whole again after a backoff.
	 */
	private finish(agentId: string, sessionId: string | undefined, loaded: boolean): void {
		const { ports } = this;
		const settling = loaded ? undefined : ports.settling(agentId);
		if (settling) {
			void settling.then(
				() => this.releaseOwed(agentId),
				() => this.releaseOwed(agentId),
			);
			return;
		}
		ports.released(agentId);
		const agentDir = ports.agentDir();
		const warnLeft = (left: WorkerStopOutcome | undefined) => {
			if (left && left.failed.length + left.managed.length > 0)
				ports.warn(interfaceText().botTeam.botStopLeftLanes(agentId, left.failed.length, left.managed.length));
		};
		let fleetEnded = !loaded;
		try {
			// Its workers end first, for the owner's reason: no session of it resumes them. It closes only once they did.
			const session = loaded ? ports.loaded(agentId)?.session : undefined;
			if (session)
				warnLeft(
					endLoadedBotWork(agentDir, agentId, session, OWNER_STOPPED_REASON, (message) => ports.warn(message)),
				);
			fleetEnded = true;
			const store = ports.store();
			const nowMs = ports.timers().now();
			const watches = sessionId === undefined ? [] : store.listRoutines({ sessionId, scope: "own-watches" });
			for (const watch of watches) store.deleteRoutine(watch.routineId, watch.revision, nowMs);
			const waiting = ports.waiting(agentId);
			for (const item of waiting)
				refuseBotInboxMessage(agentDir, item, interfaceText().botTeam.botInboxReleased(agentId), Date.now());
			if (waiting.length > 0) ports.changed(agentId);
			if (!loaded)
				warnLeft(
					endClosedBotWork(
						agentDir,
						agentId,
						readClosedBotSession(() => ports.closedSessionOf(agentId)),
						OWNER_STOPPED_REASON,
						(message) => ports.warn(message),
					),
				);
			this.owed.delete(agentId);
			this.retries.forget(agentId);
		} catch (error) {
			this.owe(agentId, error);
		}
		if (!loaded || !fleetEnded) return;
		void ports
			.close(agentId)
			.catch((error: unknown) =>
				ports.warn(interfaceText().botTeam.botSessionCloseFailed(agentId, errorText(error))),
			);
	}

	/** The bot's release failed with `error`: it is run again after a backoff, and the owner is told once. */
	owe(agentId: string, error: unknown): void {
		if (!this.owed.has(agentId))
			this.ports.warn(interfaceText().botTeam.botReleaseOwed(agentId, botFailureText(agentId, error)));
		this.owed.add(agentId);
		this.retries.arm(agentId, false);
	}
}
