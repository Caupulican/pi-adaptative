/**
 * Loads a bot's own session for its host (`BotSessionLoader`): the bot's `host.lock`, refused with the session that
 * holds it, then under it the owner's stop waiting for the closed session, the session its home records
 * (`bot-session-open.ts`), the cancelling of the watches its home's other sessions armed, its spend per request
 * (`bot-session-spend.ts`), the `AgentSession` (`bot-session-build.ts`) with each run admitted at its start, and the
 * entry the host keeps of it (`BotSessionEntry`) with its turns observed. A stop made since is taken before what the
 * saved session waits for resumes; the host then registers the entry and the bot's inbox is taken. A failure at any step
 * releases what was built as a close releases it, the lock last.
 */

import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentSession } from "../agent-session.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import type { ToolDefinition } from "../extensions/types.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import type { HostLock } from "../remote/host-lock.ts";
import type { AwayMeteredRunHold } from "../routines/away-metered-runs.ts";
import { observeSessionTurns } from "../session-turn-boundary.ts";
import type { SystemOneHostSource } from "../system-one/session-source.ts";
import { runAsyncReleaseSteps } from "../util/resource-release.ts";
import type { TimerPort, TimerSource } from "../util/timer-port.ts";
import { errorText } from "./bot-error-text.ts";
import { ensureBotHome } from "./bot-home.ts";
import { type BotHostKind, BotHostStateWriter, readRemoteBotHost } from "./bot-host-state.ts";
import { BotSessionHeldError } from "./bot-inbox-send.ts";
import { botNoticeLine } from "./bot-notices.ts";
import { storeFailure } from "./bot-open-retry.ts";
import type { BotRemoteView } from "./bot-remote-view.ts";
import type { BotSessionAdmission } from "./bot-session-admission.ts";
import { createBotAgentSession } from "./bot-session-build.ts";
import type { BotSender } from "./bot-session-host-ports.ts";
import { openHostedBotSession } from "./bot-session-open.ts";
import { type BotOwedWork, cancelOtherSessionsWatches } from "./bot-session-owed-work.ts";
import type { BotSessionDefinition } from "./bot-session-profile.ts";
import { BotSessionSpend } from "./bot-session-spend.ts";
import { type BotSpendCeiling, observeBotSessionTurns } from "./bot-session-turns.ts";
import type { BotMeteredRuns } from "./bot-spend-window.ts";
import type { BotStopPorts } from "./bot-stop.ts";
import type { BotTurnAccounting } from "./bot-turn-report.ts";

/** A bot's session loaded in its host, with what the host keeps of it. */
export interface BotSessionEntry {
	readonly agentId: string;
	readonly session: AgentSession;
	/** The session's transcript and storage roots (its bundle's orchestration home). */
	readonly sessionManager: SessionManager;
	readonly lock: HostLock;
	/** Ends the following of the main session's settings. */
	readonly releaseSettings: () => void;
	/** Publishes the session's state for the other processes. */
	readonly stateWriter: BotHostStateWriter;
	readonly modelRef: string;
	/** The root its last message came from: its turns' spend goes there. */
	sender: BotSender;
	/** The root it was built for: what defines it is compiled, and its settings read, as that root's (another root's message does not rebuild it). */
	readonly builtFor: BotSender;
	/** What defined the session when it was built (`BotSessionDefinition.key`). */
	readonly profileKey: string;
	/** The bot's own dollar ceilings (`BotSessionDefinition.spendBudget`). */
	readonly spendBudget: BotSessionDefinition["spendBudget"];
	unsubscribe: () => void;
	/** Prompts submitted and not yet settled. */
	inFlight: number;
	/** The end of the turn the owner's stop last aborted: the words given next wait on it, not steering a dying turn. */
	turnEnding: Promise<void>;
	/** When the turn running began, on the wall clock a stop's `at` is on (`observeSessionTurns`); undefined between turns. */
	turnSince: number | undefined;
	/** A record change, or a run refused off the session path, came while it worked: applied once it is idle. */
	recheckWhenIdle: boolean;
	/** Its turns' spend and outcome, each reported once per turn. */
	readonly turns: BotTurnAccounting;
	/** The metered spend of the window a transcript entry opened (`BotSessionSpend.meteredSpendOfEntry`). */
	readonly meteredSpendOf: (entryId: string) => number;
	/** Its runs whose spend counts as metered now (`BotSessionSpend.meteredRuns`). */
	readonly meteredRuns: () => BotMeteredRuns;
	idleTimer: unknown;
}

/** What a load reads from and asks of the host. */
export interface BotSessionLoadPorts {
	agentDir(): string;
	store(): PersistentBotTeamStore;
	modelRegistry(): ModelRegistry;
	/** The main session's System One as it is now. */
	systemOne(): SystemOneHostSource;
	timers(): TimerSource;
	/** The host's own timers, which its sessions' idle bounds run on. */
	idleTimers(): TimerPort;
	/** The root's dollar ceilings over spend (`BotSessionHostPorts.spendCeilings`). */
	spendCeilings(): readonly BotSpendCeiling[];
	/** What kind of process hosts the bots (`BotSessionHostPorts.hostKind`). */
	hostKind(): BotHostKind;
	/** Why a metered worker run of the bot does not fit the host's wider spend bound now (`BotSessionHostPorts.meteredRunHold`). */
	meteredRunHold(agentId: string, runId: string): AwayMeteredRunHold | undefined;
	warn(message: string): void;
	/** What defines the bot's session and whether its model may run now. */
	readonly admission: BotSessionAdmission;
	/** The work owed to the bot's session: the stops its process could not record, and its refused and admitted runs. */
	readonly owed: BotOwedWork;
	/** Takes the bot's `host.lock` for this host (`BotRemoteView.takeLock`). */
	takeLock: BotRemoteView["takeLock"];
	/** What applying a stop reads. */
	stopPorts(): BotStopPorts;
	/**
	 * Why each bot's session state was told as kept in the owner's home (`<agentId>\0<reason>`), kept by the process for
	 * its agent directory across its hosts (`BotHostProcessKeeps.notMoved`): each bot's reason is told once per process.
	 */
	readonly toldNotMoved: Set<string>;
	/** Tells the owner what the bot's own session raised, in its chat (marked unread unless `mark` is false); true if kept. */
	notify(agentId: string, text: string, mark?: boolean, deliveryId?: string): boolean;
	/** A turn ended with words: the bot's summary in the roster. */
	recordOutcome(agentId: string, summary: string): void;
	/** The `bot_mail` tool of the bot's session: its mail goes through the host, which names it the sender. */
	mailTool(agentId: string): ToolDefinition;
	/** The session's turn that began at `since` ended: its answers to the mail it took go back (`bot-mail-replies.ts`). */
	turnEnded(entry: BotSessionEntry, since: number): void;
	/** After an event of the session: its idle bound and published state follow it. */
	settle(entry: BotSessionEntry): void;
	/** Puts the built session to work in the host: kept, published, its idle bound armed and its inbox watched. */
	register(entry: BotSessionEntry, continued: boolean): void;
	/** Takes the messages waiting in the bot's inbox. */
	drainInbox(agentId: string): Promise<void>;
	/** Drops the entry of a load that failed, if the host still keeps it. */
	forget(entry: BotSessionEntry): void;
}

/** Builds each bot's loaded session for one host, whose locks and published states name `holder`. */
export class BotSessionLoader {
	private readonly ports: BotSessionLoadPorts;
	private readonly holder: string;

	constructor(ports: BotSessionLoadPorts, holder: string) {
		this.ports = ports;
		this.holder = holder;
	}

	/** The bot's session built or continued as its record defines it for `sender`, registered in the host. */
	async load(record: PersistentBotRecord, sender: BotSender): Promise<BotSessionEntry> {
		const agentDir = this.ports.agentDir();
		const { agentId } = record;
		const words = interfaceText().botTeam;
		const { home, profile } = ensureBotHome(agentDir, record);
		const definition = this.ports.admission.define(record, sender);
		const { model, cwd } = definition;
		// A model refused now builds no session and takes no lock.
		this.ports.admission.admit(agentId, model, definition, sender);
		const taken = this.ports.takeLock(agentId);
		if (!taken.held) {
			const sessionId = readRemoteBotHost(agentDir, agentId, this.holder)?.hostSessionId;
			throw new BotSessionHeldError((text) => text.botTeam.botSessionHeld(agentId, taken.owner.pid, sessionId));
		}
		const { lock } = taken;
		let session: AgentSession | undefined;
		let settings: ReturnType<BotSender["settings"]> | undefined;
		let built: BotSessionEntry | undefined;
		// Until its file is open, a failure is a read of the bot's session store; after, only one in its orchestration home
		// (its lease) is (`storeFailure`).
		let storeWithin: string | undefined;
		try {
			// The owner's stop waiting for it is applied to its closed session under the lock first: nothing it stopped resumes.
			this.ports.owed.unrecorded.underLock(agentId, this.ports.stopPorts());
			// The session the bot's home records, whatever directory it worked in: a bot keeps one conversation.
			const { sessionManager, continued } = openHostedBotSession(agentDir, home, cwd, {
				pointerSetAside: (file, reason) => this.ports.warn(words.botSessionPointerSetAside(agentId, file, reason)),
				notMoved: (kept) => {
					const told = `${agentId}\0${kept.reason}`;
					if (this.ports.toldNotMoved.has(told)) return;
					this.ports.toldNotMoved.add(told);
					this.ports.warn(
						kept.reason === "in-both-homes"
							? words.botSessionStateInBothHomes(agentId, kept.ownerBundle)
							: kept.reason === "worker-records"
								? words.botSessionStateKeptForWorkers(agentId)
								: kept.reason === "workers-open"
									? words.botSessionStateKeptForOpenWorkers(agentId)
									: kept.reason === "records-unreadable"
										? words.botSessionStateMoveUndecided(agentId, kept.error)
										: kept.reason === "still-held"
											? words.botSessionStateStillHeld(agentId, kept.pids.join(", "))
											: words.botSessionStateNotMoved(agentId),
					);
				},
			});
			storeWithin = sessionManager.getStorageRoots().orchestrationHome.root;
			const cancelled = cancelOtherSessionsWatches(
				this.ports.store(),
				home.sessionsDir,
				sessionManager.getSessionId(),
				this.ports.idleTimers().now(),
			);
			if (cancelled > 0) this.ports.warn(interfaceText().botTeam.botWatchesCancelled(agentId, cancelled));
			settings = sender.settings();
			const settingsManager = settings.settings;
			const registry = this.ports.modelRegistry();
			// The bot's spend per request it serves: its turns and the runs of the workers they start share one bound.
			const spend = new BotSessionSpend(agentId, home, sessionManager, definition, registry, {
				rootCeilings: () => this.ports.spendCeilings(),
				snapshot: () => session?.backgroundLanes.getTaskRuntimeSnapshot(),
				now: () => this.ports.idleTimers().now(),
				warn: (message) => this.ports.warn(message),
				meteredRunHold: (runId) => this.ports.meteredRunHold(agentId, runId),
			});
			session = await createBotAgentSession({
				agentId,
				agentDir,
				definition,
				displayName: profile.displayName,
				memoryBlock: this.ports.store().composeBotUnifiedMemoryContext(agentId, undefined, undefined, "session")
					.promptBlock,
				customTools: [this.ports.mailTool(agentId)],
				sessionManager,
				settingsManager,
				registry,
				systemOne: () => this.ports.systemOne(),
				timers: this.ports.timers(),
				host: {
					workerRunCostBound: spend.workerRunCostBound,
					workerRunModelHold: spend.workerRunModelHold,
					// The bot daemon's watched commands start from the environment a root recorded where the bot works.
					watchCommandBase: sender.watchCommandBase,
					// Its notices (a lost watch, System One without an engine) reach the owner in the bot's chat.
					ownerNoticeLine: botNoticeLine(agentDir, agentId, {
						keep: (text, deliveryId) => this.ports.notify(agentId, text, true, deliveryId),
						warn: (line) => this.ports.warn(line),
					}),
					// Every run is admitted at its start, whatever opened it: a wake's turn is held to the owner's rules too.
					admitRun: () => {
						try {
							this.ports.admission.admit(agentId, session?.model, definition, sender);
						} catch (error) {
							// The wakes it holds are refused with this run, for this cause: they are taken up again once it clears.
							this.ports.owed.refused(agentId, definition.key, sessionManager, error);
							throw error;
						}
						this.ports.owed.admitted(agentId);
					},
					onClosingWarnings: (warnings) => {
						for (const warning of warnings)
							this.ports.notify(agentId, interfaceText().botTeam.botWarning(agentId, warning));
					},
				},
			});
			const hostSessionId = sender.hostSessionId();
			const entry: BotSessionEntry = {
				agentId,
				session,
				sessionManager,
				lock,
				releaseSettings: settings.release,
				stateWriter: new BotHostStateWriter(agentDir, {
					agentId,
					hostKind: this.ports.hostKind(),
					...(hostSessionId !== undefined ? { hostSessionId } : {}),
					botSessionId: session.sessionId,
					holder: this.holder,
				}),
				modelRef: `${model.provider}/${model.id}`,
				sender,
				builtFor: sender,
				profileKey: definition.key,
				spendBudget: definition.spendBudget,
				unsubscribe: () => {},
				inFlight: 0,
				turnEnding: Promise.resolve(),
				turnSince: undefined,
				recheckWhenIdle: false,
				meteredSpendOf: (entryId) => spend.meteredSpendOfEntry(entryId),
				meteredRuns: () => spend.meteredRuns(),
				turns: spend.accounting(session, {
					charge: (usage, report) => entry.sender.reportUsage(usage, report),
					chargesHeld: (sessionId, instance, since) => entry.sender.chargesHeld(sessionId, instance, since),
					chargesPersisted: (listener) => entry.sender.chargesPersisted(listener),
					rootSessionId: () => entry.sender.hostSessionId(),
					rootKeepsFile: () => entry.sender.hostKeepsFile(),
					chargeNotRecorded: (reason) =>
						entry.sender.warn(interfaceText().botTeam.botTurnSpendNotRecorded(agentId, reason)),
					chargesUnread: (named, more) =>
						entry.sender.warn(interfaceText().botTeam.botChargeFilesUnread(agentId, named, more)),
					markNotKept: (reason) =>
						entry.sender.warn(interfaceText().botTeam.botChargeMarkNotKept(agentId, reason)),
					outcome: (summary) => this.ports.recordOutcome(agentId, summary),
				}),
				idleTimer: undefined,
			};
			built = entry;
			const unobserveSince = observeSessionTurns(session, {
				started: () => {
					entry.turnSince = Date.now();
				},
				ended: () => {
					const since = entry.turnSince;
					entry.turnSince = undefined;
					if (since !== undefined) this.ports.turnEnded(entry, since);
				},
			});
			entry.unsubscribe = unobserveSince;
			const unobserveTurns = observeBotSessionTurns(session, entry.turns, {
				agentId,
				role: definition.role,
				cwd,
				timers: this.ports.idleTimers(),
				...spend.turnBound(),
				maxWallClockMs: () => settingsManager.getWorkerDelegationSettings().maxWallClockMs,
				notify: (text, mark) => this.ports.notify(agentId, text, mark),
				settle: () => this.ports.settle(entry),
			});
			entry.unsubscribe = () => {
				unobserveTurns();
				unobserveSince();
			};
			session.startBackgroundInputs();
			// A stop made since the one taken under the lock is taken first: nothing it stops resumes below. No turn runs yet.
			const loadStop = this.ports.owed.unrecorded.loaded(
				agentId,
				{ session, sessionManager },
				this.ports.stopPorts(),
			);
			if (loadStop.failure) throw loadStop.failure.cause;
			// What its saved session waits for resumes in it now: a usage limit's kept reset, and its queued workers.
			session.restoreGoalRuntimeAfterResume();
			session.backgroundLanes.drainQueuedWorkerDelegations();
			this.ports.register(entry, continued);
			// What other processes sent while another host held the bot is given first, before the message that opened it.
			await this.ports
				.drainInbox(agentId)
				.catch((error: unknown) => this.ports.warn(words.botInboxNotTaken(agentId, errorText(error))));
			return entry;
		} catch (error) {
			// Released as a close releases, in its order and every step whatever an earlier one threw, the lock last: a
			// session still disposing never loses its lock to the next one built.
			if (built) this.ports.forget(built);
			await runAsyncReleaseSteps(
				[
					() => built?.unsubscribe(),
					() => session?.disposeAndWait(),
					() => settings?.release(),
					() => built?.stateWriter.clear(),
					() => lock.release(),
				],
				words.botSessionNotClosed,
				{ error },
			);
			throw storeFailure(agentId, error, storeWithin);
		}
	}
}
