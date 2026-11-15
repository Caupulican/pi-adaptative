/**
 * Hosts each bot as an `AgentSession` of its own, in this process: one session per bot, created on its first message
 * (`createAgentSession`, as the daemon's channel sessions are) and loaded under its lock by `bot-session-load.ts`,
 * continued from the session its home's pointer records (`bot-session-open.ts`: one conversation per bot, whatever the
 * working directory, with its bundle, leases and transcripts in the bot's own `orchestration/`), kept while a turn runs
 * or input is queued, and closed after `BOT_SESSION_IDLE_BOUND_MS` of idleness or when the host stops.
 *
 * The session runs on the bot's own model (a profile bot's on the binding its profile admits), never replaced by another: a model that is missing, has no credentials, or that
 * the worker admission refuses (a metered model the owner did not choose, one the owner's model policy disallows) refuses
 * the message. The bot has an identity of its own: its name and its soul replace the main agent's in the system prompt
 * (the soul is judged again here because a stored record can have been edited by hand). It works in the owner's project
 * directory under a worker's private-path scope, with a settings manager of its own over the main session's settings
 * storage. It is a child session (no memory writes, no channels, and of the routines only the watches it arms itself)
 * that runs System One as the main session does (on or off, provider, transport), keeping its System One evidence in its
 * home; it is a session of its own, so its edge grants are its own conversation's plus the settings', never another
 * session's. Its tools are the read tools, System One's tool, a shell, `self_compact` and `task_watch` for its own waits,
 * plus the file tools and python when the record grants `canWrite`, and the director tools (`delegate`, `assign`,
 * `plan`) that direct workers of its own (a profile bot's only when its profile names one); a read-only bot's shell
 * runs only commands the read-only shell line admits. A bot made from a worker profile runs on the contract its profile compiles to, again at
 * every run, by the resolution a fresh worker of it takes and none of a worker run's admission gates (`bot-session-profile.ts`): the resolved model, the plan's tools, read and write roots and read-only grant,
 * a capability ceiling held by the session's tool gate, the profile's soul and resources; a profile that needs what only
 * a worker's run has keeps it a worker (`runsAsSession`). Its spend per request it serves, its workers' included,
 * is held to the worker, session and profile ceilings, and charged to the main session's cost view (`bot-session-spend.ts`). Its goals, a usage limit's kept reset and its queued workers resume when its session loads.
 *
 * One process hosts a bot's session at a time (`bots/<id>/host.lock`): a second process is refused, naming the session
 * that hosts the bot, rather than appending to the same file. Every process still sees the bot: its conversation is read
 * from the home's session files, and its state from `host-state.json`, which the hosting process publishes on each change
 * of state. What the host reads of a bot it does not run, with the watch over the bot homes that tells an open roster
 * and an open chat when either changed whichever process wrote it, is `BotRemoteView` (`stateOf`, `readMessages`,
 * `subscribe`). A change of the bot's record rebuilds an idle session on the next message and is refused while a turn
 * runs. A finished turn records its outcome in the store as a worker's did, so the roster's unread mark and summary keep
 * working; what its session raises for the owner (a warning, a failed turn, a turn stopped at its bound) is a notice in the
 * bot's chat that marks it unread. This host only reads and writes the bot's own home and session.
 */

import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import type { SpawnedUsageReceiptDisposition } from "../cost/spawned-usage-receipt.ts";
import type {
	BotDeliveryOptions,
	BotDeliveryOrigin,
	BotOperatorMessageDispatchResult,
	BotOperatorMessageOptions,
} from "../delegation/bot-operator-message-options.ts";
import type { BotSessionCompilation } from "../delegation/bot-session-compile.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { OWNER_STOPPED_REASON, WHOLE_FLEET_STOP_SCOPE } from "../delegation/worker-fleet-stop.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { liveOwnWatches } from "../routines/routine-holder.ts";
import { onlyWorkerRetriesWaitBeyond } from "../session-work-state.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SystemOneHostSource } from "../system-one/session-source.ts";
import { branchHoldsTurnRef, recordedMessageOrigin } from "../turn-origin.ts";
import { runAsyncReleaseSteps } from "../util/resource-release.ts";
import { OWNER_STOP_CLOCK, type TimerPort, type TimerSource } from "../util/timer-port.ts";
import { readSessionWatchWork, type SessionWatchWork } from "../watches/session-watch-ledger.ts";
import type { BotChargesHeld } from "./bot-charges-held.ts";
import { errorText } from "./bot-error-text.ts";
import { botFailureCause, botFailureText, inOwnerWords } from "./bot-failure-words.ts";
import { BotHistory, type BotHistoryRead } from "./bot-history.ts";
import { botHomeOf, ensureBotHome } from "./bot-home.ts";
import { tellUnreadableHomeRecord } from "./bot-home-records.ts";
import type { BotSessionState } from "./bot-host-state.ts";
import {
	type BotInboxItem,
	type BotInboxRefusal,
	botInboxStopWaiting,
	botInboxWaiting,
	readBotInbox,
	readBotInboxRefusals,
} from "./bot-inbox.ts";
import { BotInboxDrain } from "./bot-inbox-drain.ts";
import { BotSessionHeldError, queueInBotInbox, sendToBotHost } from "./bot-inbox-send.ts";
import { type LinkedSessionNotices, stopOperation } from "./bot-link-notices.ts";
import type { BotModelRefusal } from "./bot-model-refusal.ts";
import { type BotNotice, keepBotNotice, readBotNotices } from "./bot-notices.ts";
import { BotOpenRetries, botOpenFailure } from "./bot-open-retry.ts";
import { BotOwnerError } from "./bot-owner-error.ts";
import { BotRelease } from "./bot-release.ts";
import { BotRemoteView, remoteHostActive, savedSessionFile } from "./bot-remote-view.ts";
import { BotSessionAdmission } from "./bot-session-admission.ts";
import { type BotSessionEntry, BotSessionLoader } from "./bot-session-load.ts";
import { BotOwedWork, owesWatchWork, type SavedUsageResumeRules } from "./bot-session-owed-work.ts";
import { botMayRunAsSession, profileBotSession } from "./bot-session-profile.ts";
import type { BotSpendCeiling } from "./bot-session-turns.ts";
import type { BotChargeReport } from "./bot-spend-ledger.ts";
import {
	type BotStopPorts,
	endUnrecordedStopWork,
	type OwnerStop,
	STOP_TAKE,
	stopLoadedBot,
	type UnrecordedBotStops,
	writeOwnerStop,
} from "./bot-stop.ts";
import { BotWatchExpiry } from "./bot-watch-expiry.ts";

/** How long a bot's session stays loaded with no turn running and no input queued. */
export const BOT_SESSION_IDLE_BOUND_MS = 10 * 60 * 1000;
/** How long a message waits for an earlier session of its bot, or the stop of the host this one replaced, to end. */
export const BOT_SESSION_CLOSE_WAIT_MS = 30 * 1000;

/**
 * What a process keeps for an agent directory across the bot session hosts that replace one another there
 * (`bot-session-registry.ts`: a new, resumed or forked root session stops the old host before the next one starts).
 */
export interface BotHostProcessKeeps {
	/** The owner's stops the process could not record. */
	readonly unrecorded: UnrecordedBotStops;
	/** What the owner was told of the work a stop or a release left behind a symbolic link. */
	readonly links: LinkedSessionNotices;
	/** Why each bot's session state was told as kept in the owner's home (`BotSessionLoadPorts.toldNotMoved`). */
	readonly notMoved: Set<string>;
}

export type { BotSessionState };

/** What the host reads from and asks of the coordinator. */
export interface BotSessionHostPorts {
	agentDir(): string;
	/** The root session a bot works for when no delivery names one (a wake, a stop): the one attached last. */
	sender(): BotSender;
	/** An attached root session working in `cwd`, which a bot whose session worked there is opened again for. */
	senderIn(cwd: string): BotSender | undefined;
	store(): PersistentBotTeamStore;
	modelRegistry(): ModelRegistry;
	/** The main session's System One as it is now: a bot's session follows it at each use, as the main session runs it. */
	systemOne(): SystemOneHostSource;
	timers(): TimerSource;
	/** An owner-facing warning that no bot turn's sender owns (a session that did not close cleanly, a lost watch). */
	warn(message: string): void;
	/** Why the worker admission refuses the bot's model now, with when that ends when known; undefined when it may run. */
	modelRefusal(record: PersistentBotRecord, model: Model<Api>): BotModelRefusal | undefined;
	/**
	 * The root's dollar ceilings over spend, as a worker's budget holds it: the owner's worker bound and the main session's
	 * autonomy bound on all spend, and its metered-only ceiling; empty when none is set.
	 */
	spendCeilings(): readonly BotSpendCeiling[];
	/** What reads when a closed bot's saved session continues what a usage limit stopped (`savedUsageResumeAt`). */
	usageRules(): SavedUsageResumeRules;
}

/**
 * The root session a bot's message came from: the owner's project directory a bot it loads works in, what a bot made from
 * a profile compiles to and the settings a bot reads there, the pi session named as its host, and where its turns' spend
 * goes. Once that root detaches, the root attached last answers. What the bot's own session raises for the owner goes to
 * the bot's chat instead (`bot-notices.ts`).
 */
export interface BotSender {
	cwd(): string;
	/** What a bot made from a profile compiles to for this root, by the resolution a fresh worker of it takes (`bot-session-compile.ts`). */
	compileProfile(record: PersistentBotRecord & { readonly profileId: string }): BotSessionCompilation;
	/**
	 * A settings manager of the bot's own over the storage this root reads (`SettingsManager.sibling`), reading again each
	 * change an attached root's manager makes until `release`.
	 */
	settings(): { readonly settings: SettingsManager; release(): void };
	/** The pi session that hosts the bot, named to the owner of a message another process sends it. */
	hostSessionId(): string;
	/** Whether that session keeps a session file (none with `--no-session` or an in-memory SDK session). */
	hostKeepsFile(): boolean;
	/** An owner-facing warning about this root's own record of the bot's turn (its spend could not be recorded). */
	warn(message: string): void;
	/**
	 * Delivers a charge of the bot's spend to the root session's cost view, once per `reportId`: `persisted` once the
	 * root's file holds it.
	 */
	reportUsage(usage: Usage, report: BotChargeReport): SpawnedUsageReceiptDisposition;
	/**
	 * How far the root sessions of the process hold the charges of file instance `instance` of bot session `sessionId` in
	 * the files changed since `since`, and the charges they hold unwritten (`botChargesHeld`).
	 */
	chargesHeld(sessionId: string, instance: string, since: number): Promise<BotChargesHeld>;
	/**
	 * Calls `listener` with the bot charges (their report ids) the root session's file holds, as each write lands, with
	 * the session written to; returns the unsubscribe.
	 */
	chargesPersisted(listener: (rootSessionId: string, reportIds: readonly string[]) => void): () => void;
}

/** What a root session's message dispatch asks of the host: its deliveries carry that root as their sender. */
export interface BotSessionDelivery extends Pick<BotSessionHost, "noteHistoryRun" | "runsAsSession"> {
	deliver(
		agentId: string,
		message: string,
		options: BotDeliveryOptions,
		origin: BotDeliveryOrigin,
	): Promise<BotOperatorMessageDispatchResult>;
}

export class BotSessionHost {
	private readonly ports: BotSessionHostPorts;
	/** The bot's earlier worker conversations, indexed in its home. */
	private readonly history: BotHistory;
	private readonly entries = new Map<string, BotSessionEntry>();
	/** Bots whose change the host noticed itself was not applied (`applyRecordChange`): told once until one applies. */
	private readonly toldChangeNotApplied = new Set<string>();
	/** Bots whose home's session did not read at the last roster count: told once until it reads again. */
	private readonly toldWatchesNotCounted = new Set<string>();
	/** Sessions being built, so two messages in a row build one. */
	private readonly loading = new Map<string, Promise<BotSessionEntry>>();
	/** Opens the session of a bot owed work that no process hosts. */
	private readonly owed: BotOwedWork;
	/** What defines each bot's session and whether its model may run now. */
	private readonly admission: BotSessionAdmission;
	/** Bots whose loaded session failed to take the owner's stop: taken again after a backoff until it is. */
	private readonly stopRetries = new BotOpenRetries({
		timers: () => this.idleTimers(),
		stopped: () => this.stopped,
		retry: (agentId) => this.takeInbox(agentId),
	});
	/** The cause last told of a bot's stop that its loaded session could not take (`botFailureCause`): told once per cause. */
	private readonly stopTold = new Map<string, string>();
	/** Sessions being closed: the next one of that bot opens once the file and the lock are free. */
	private readonly closing = new Map<string, Promise<void>>();
	private readonly listeners = new Set<(change: readonly string[]) => void>();
	private stopped = false;
	/** The releases of bots retired or off the session path, and the ones owed. */
	private readonly releases: BotRelease;
	/** This host among any other in its process: the bots' locks and published states name it (`HostLockRecord.holder`). */
	private readonly holder = randomBytes(8).toString("hex");
	/** The bots this host does not run, as their homes say (see `BotRemoteView`). */
	private readonly view: BotRemoteView;
	/** Announces a bot whose first live watch ended, which nothing writes (see `BotWatchExpiry`). */
	private readonly watchExpiry = new BotWatchExpiry(
		() => this.idleTimers(),
		(agentIds) => this.changedMany(agentIds),
	);

	/** The stop of the host this one replaced in its process, which no session is built before. */
	private readonly previousStop: Promise<void>;
	/** Takes the inboxes of the bots this host runs: the owner's messages sent from other processes. */
	private readonly inbox: BotInboxDrain;
	/** Builds the bots' sessions this host loads. */
	private readonly loader: BotSessionLoader;

	/** What the host keeps for its process and agent directory, across the hosts that replace it there. */
	private readonly keeps: BotHostProcessKeeps;

	/**
	 * `keeps` is what its process keeps for the agent directory across its hosts (`bot-session-registry.ts`): the owner's
	 * stops it could not record, what the owner was told of the work a stop or release left behind a symbolic link, and
	 * why each bot's session state was told as kept in the owner's home.
	 */
	constructor(ports: BotSessionHostPorts, keeps: BotHostProcessKeeps, previousStop?: Promise<void>) {
		this.ports = ports;
		this.keeps = keeps;
		this.previousStop = previousStop ?? Promise.resolve();
		this.admission = new BotSessionAdmission({
			store: () => ports.store(),
			modelRegistry: () => ports.modelRegistry(),
			modelRefusal: (record, model) => ports.modelRefusal(record, model),
			spendCeilings: () => ports.spendCeilings(),
			recheck: (record) => this.applyRecordChange(record.agentId),
		});
		this.history = new BotHistory({
			agentDir: () => ports.agentDir(),
			store: () => ports.store(),
			warn: (message) => ports.warn(message),
		});
		this.view = new BotRemoteView(
			{
				agentDir: () => ports.agentDir(),
				store: () => ports.store(),
				timers: () => ports.timers(),
				warn: (message) => ports.warn(message),
				runsLocally: (agentId) => this.entries.has(agentId),
				// A host that let a bot go leaves its watches and its inbox to no one until a process opens its session again.
				hostChanged: (agentId) => this.owed.unhosted(agentId),
				changed: (agentIds) => this.changedMany(agentIds),
				inboxChanged: (agentId) => this.takeInbox(agentId),
			},
			this.holder,
		);
		this.owed = new BotOwedWork(
			{
				agentDir: () => ports.agentDir(),
				store: () => ports.store(),
				timers: () => this.idleTimers(),
				warn: (message) => ports.warn(message),
				stopped: () => this.stopped,
				hostedHere: (agentId) => this.entries.has(agentId),
				heldElsewhere: (agentId) => this.view.heldElsewhere(agentId),
				hostOf: (agentId) => this.view.hostOf(agentId),
				savedSessionOf: (agentId) => this.view.savedSessionOf(agentId),
				waiting: (agentId) => this.readInbox(agentId).waiting,
				runsAsSession: (record) => this.runsAsSession(record),
				definedCwd: (record, sender) => this.admission.define(record, sender).cwd,
				currentKey: (record, sender) => this.admission.currentKey(record, sender),
				modelRefusal: (record, sender) =>
					this.admission.modelRefusal(record, this.admission.define(record, sender)),
				admissionTimers: () => ports.timers().port("provider-admission"),
				retake: (agentId) => this.retakeRefused(agentId),
				takeInbox: (agentId) => this.takeInbox(agentId),
				sender: () => ports.sender(),
				senderIn: (cwd) => ports.senderIn(cwd),
				open: (agentId, sender) => this.open(agentId, sender),
				usageRules: () => ports.usageRules(),
				stopPorts: () => this.stopPorts(),
			},
			keeps.unrecorded,
		);
		this.inbox = new BotInboxDrain({
			agentDir: () => ports.agentDir(),
			timers: () => this.idleTimers(),
			watching: () => this.view.watching(),
			hosted: () => [...this.entries.keys()],
			give: async (agentId, message) => {
				const entry = this.entries.get(agentId);
				if (!entry || this.stopped) return false;
				await this.give(entry, message.text, message.mode, message.origin ?? "owner");
				return true;
			},
			takeStops: (agentId) => this.takeStops(agentId),
			warn: (message) => ports.warn(message),
			changed: (agentId) => this.changed(agentId),
		});
		this.releases = new BotRelease({
			agentDir: () => ports.agentDir(),
			store: () => ports.store(),
			timers: () => this.idleTimers(),
			stopped: () => this.stopped,
			warn: (message) => ports.warn(message),
			links: keeps.links,
			loaded: (agentId) => {
				const entry = this.entries.get(agentId);
				return entry && { session: entry.session, busy: this.holdsLoaded(entry) };
			},
			settling: (agentId) => this.loading.get(agentId) ?? this.closing.get(agentId),
			// Read through a link: a release only reads, so a linked pointer or session file never keeps the bot.
			savedSessionOf: (agentId) => savedSessionFile(ports.agentDir(), agentId, "follow"),
			closedSessionOf: (agentId) => this.view.savedSessionOf(agentId),
			waiting: (agentId) => this.readInbox(agentId).waiting,
			runsAsSession: (record) => this.runsAsSession(record),
			hasHome: (agentId) => this.hasHome(agentId),
			heldElsewhere: (agentId) => this.view.heldElsewhere(agentId),
			released: (agentId) => this.owed.released(agentId),
			changed: (agentId) => this.changed(agentId),
			close: (agentId) => this.close(agentId),
		});
		this.loader = new BotSessionLoader(
			{
				agentDir: () => ports.agentDir(),
				store: () => ports.store(),
				modelRegistry: () => ports.modelRegistry(),
				systemOne: () => ports.systemOne(),
				timers: () => ports.timers(),
				idleTimers: () => this.idleTimers(),
				spendCeilings: () => ports.spendCeilings(),
				warn: (message) => ports.warn(message),
				admission: this.admission,
				owed: this.owed,
				takeLock: (agentId) => this.view.takeLock(agentId),
				stopPorts: () => this.stopPorts(),
				toldNotMoved: keeps.notMoved,
				notify: (agentId, text, mark, deliveryId) => this.notify(agentId, text, mark, deliveryId),
				recordOutcome: (agentId, summary) => this.recordOutcome(agentId, summary),
				settle: (entry) => this.settle(entry),
				register: (entry, continued) => this.register(entry, continued),
				drainInbox: (agentId) => this.inbox.drain(agentId),
				forget: (entry) => {
					if (this.entries.get(entry.agentId) === entry) this.entries.delete(entry.agentId);
				},
			},
			this.holder,
		);
	}

	/** Takes the owner's stops waiting for the bot this host runs: false when its session is not loaded here or they failed. */
	private takeStops(agentId: string): boolean {
		const entry = this.entries.get(agentId);
		return entry !== undefined && this.applyWaitingStops(agentId, entry).failure === undefined;
	}

	/**
	 * Takes the owner's stops waiting for the bot whose session `entry` holds (`stopLoadedBot`), with what the stop ended;
	 * a take that failed is told to the owner and tried again later.
	 */
	private applyWaitingStops(agentId: string, entry: BotSessionEntry): ReturnType<typeof stopLoadedBot> {
		const taken = stopLoadedBot(
			this.ports.agentDir(),
			agentId,
			entry,
			(stop) => this.stopTurn(entry, stop),
			this.stopPorts(),
		);
		if (taken.failure === undefined) {
			this.stopRetries.forget(agentId);
			this.stopTold.delete(agentId);
			return taken;
		}
		const cause = botFailureCause(STOP_TAKE, agentId, taken.failure.cause);
		if (this.stopTold.get(agentId) !== cause)
			this.ports.warn(
				interfaceText().botTeam.botStopNotApplied(agentId, botFailureText(agentId, taken.failure.cause)),
			);
		this.stopTold.set(agentId, cause);
		this.stopRetries.arm(agentId, false);
		return taken;
	}

	/**
	 * Aborts the turn the bot's session works on, for the owner's stop `stop`: one recorded late (`scoped`) only when the
	 * turn began by the time it was made (`turnSince`, the wall clock its `at` is on). The words given next wait for its end.
	 */
	private stopTurn(entry: BotSessionEntry, stop: OwnerStop): void {
		if (!this.isBusy(entry)) return;
		if (stop.scope.kind === "scoped" && (entry.turnSince === undefined || entry.turnSince > stop.at)) return;
		entry.turnEnding = entry.session
			.abort(interfaceText().botTeam.botTurnAbortReasons.ownerStopped)
			.catch((error: unknown) =>
				this.ports.warn(interfaceText().botTeam.botTurnFailed(entry.agentId, errorText(error))),
			);
	}

	/**
	 * What applying a stop reads: the owner's warnings, the provider admission clock a usage wait is dated on, and what the
	 * owner was told of the work a stop left behind a symbolic link.
	 */
	private stopPorts(): BotStopPorts {
		return {
			warn: (message) => this.ports.warn(message),
			now: () => this.ports.timers().port("provider-admission").now(),
			routineClock: this.ports.timers().port("routines"),
			links: this.keeps.links,
			watches: () => this.ports.store(),
		};
	}

	/** Takes the messages written to the inbox of a bot this host runs; a failure reaches the owner as a warning. */
	private takeInbox(agentId: string): void {
		void this.inbox
			.drain(agentId)
			.catch((error: unknown) =>
				this.ports.warn(interfaceText().botTeam.botInboxNotTaken(agentId, errorText(error))),
			);
	}

	/**
	 * What waits in the bot's inbox for the host of its session, and what that session refused of it, oldest first: every
	 * session's chat shows both.
	 */
	readInbox(agentId: string): {
		readonly waiting: readonly BotInboxItem[];
		readonly refused: readonly BotInboxItem<BotInboxRefusal>[];
	} {
		const agentDir = this.ports.agentDir();
		const unreadable = tellUnreadableHomeRecord(agentId, "inboxMessage", (message) => this.ports.warn(message));
		return {
			waiting: readBotInbox(agentDir, agentId, unreadable),
			refused: readBotInboxRefusals(agentDir, agentId, unreadable),
		};
	}

	/** What the bot's own session told the owner, oldest first (the newest few): every session's chat shows it. */
	readNotices(agentId: string): readonly BotNotice[] {
		const unreadable = tellUnreadableHomeRecord(agentId, "notice", (message) => this.ports.warn(message));
		return readBotNotices(this.ports.agentDir(), agentId, unreadable).map(({ message }) => message);
	}

	/** Tells the owner what the bot's own session raised for them, in the bot's chat (see `keepBotNotice`); true when kept. */
	private notify(agentId: string, text: string, mark = true, deliveryId?: string): boolean {
		const notice = { agentId, text, at: Date.now(), deliveryId };
		const kept = keepBotNotice(this.ports.agentDir(), this.ports.store(), notice, mark, (line) =>
			this.ports.warn(line),
		);
		if (kept) this.changed(agentId);
		return kept;
	}

	/** The bot's earlier worker conversations, whichever session ran them (see `BotHistory`). */
	readHistory(agentId: string): BotHistoryRead {
		return this.history.read(agentId);
	}

	/** A worker-path start of the bot's direct conversation was bound: its run joins the bot's history. */
	noteHistoryRun(agentId: string, parentSessionId: string, runtime: string): void {
		try {
			this.history.noteRun(agentId, parentSessionId, runtime);
		} catch (error) {
			// The run itself is unaffected; the index is rebuilt by the next scan only if it was never finished.
			this.ports.warn(interfaceText().botTeam.botHistoryRunNotRecorded(agentId, errorText(error)));
		}
	}

	private idleTimers(): TimerPort {
		return this.ports.timers().port("bot-sessions");
	}

	/** Observe a bot whose session state changed (the roster and an open chat follow it). Returns the unsubscribe. */
	subscribe(listener: (change: readonly string[]) => void): () => void {
		this.listeners.add(listener);
		return () => void this.listeners.delete(listener);
	}

	private changed(agentId: string): void {
		this.changedMany([agentId]);
	}

	private changedMany(agentIds: readonly string[]): void {
		for (const listener of [...this.listeners]) listener(agentIds);
	}

	private localState(entry: BotSessionEntry): BotSessionState {
		if (this.isRunning(entry)) return "running";
		return entry.session.deliverablePendingMessageCount > 0 ? "queued" : "idle";
	}

	/** Tells the other processes what the bot's session is doing now. */
	private publishState(entry: BotSessionEntry): void {
		try {
			entry.stateWriter.publish(this.localState(entry));
		} catch (error) {
			this.ports.warn(interfaceText().botTeam.botStateNotPublished(entry.agentId, errorText(error)));
		}
	}

	private isRunning(entry: BotSessionEntry): boolean {
		return entry.inFlight > 0 || entry.session.getSessionWorkState().busy;
	}

	private isBusy(entry: BotSessionEntry): boolean {
		return this.isRunning(entry) || entry.session.deliverablePendingMessageCount > 0;
	}

	/**
	 * The state of the bot's session: this process's own, from memory, else what the process hosting it says; undefined when
	 * no loaded session exists anywhere.
	 */
	stateOf(agentId: string): BotSessionState | undefined {
		const entry = this.entries.get(agentId);
		if (entry) return this.localState(entry);
		return this.view.hostOf(agentId)?.state;
	}

	/** Whether the bot's session, here or in the process hosting it, is running a turn or holds queued input. */
	isActive(agentId: string): boolean {
		const entry = this.entries.get(agentId);
		return entry === undefined ? remoteHostActive(this.view.hostOf(agentId)) : this.isBusy(entry);
	}

	/**
	 * Gives words to the bot's own session, building it first when it is not loaded: the owner's, or words under the origin
	 * the sender recorded (`origin`: an agent's mail, a routine's prompt). An idle session starts a turn ("started" on a new
	 * conversation, "followed_up" on a continued one); a running one takes the words as a steer, or behind the turn when
	 * `mode` is `queue`. Returns once the session accepted the words, not when the turn ends.
	 */
	async deliver(
		agentId: string,
		message: string,
		{ mode, showsWaits }: BotDeliveryOptions,
		origin: BotDeliveryOrigin,
		sender: BotSender = this.ports.sender(),
	): Promise<BotOperatorMessageDispatchResult> {
		let entry: BotSessionEntry;
		try {
			entry = await this.open(agentId, sender);
		} catch (error) {
			// Another host runs it, or it may open later (a holder keeps its host out, a passing read failure): the words wait
			// in its inbox, taken by that host or by this one's next open, which the send arms (`BotOwedWork.openLater`).
			if (!(error instanceof BotSessionHeldError) && botOpenFailure(error) === undefined)
				throw inOwnerWords(agentId, error);
			return sendToBotHost(
				{
					agentDir: this.ports.agentDir(),
					holder: this.holder,
					store: () => this.ports.store(),
					changed: (changedId) => this.changed(changedId),
					open: (openedId) => this.open(openedId, sender),
					owed: this.owed,
				},
				agentId,
				message,
				{ mode, showsWaits },
				{ sessionId: sender.hostSessionId(), cwd: sender.cwd() },
				origin,
			);
		}
		entry.sender = sender;
		// The owner's words never start a turn while a stop of the bot waits: it is taken first, or they wait behind it.
		const agentDir = this.ports.agentDir();
		const behindStop = botInboxStopWaiting(agentDir, agentId) && !this.takeStops(agentId);
		// Words its inbox holds (left behind a stop since taken) go first, and these follow them in order.
		if (!behindStop && botInboxWaiting(agentDir, agentId)) await this.inbox.drain(agentId);
		if (!behindStop && !botInboxWaiting(agentDir, agentId)) return this.give(entry, message, mode, origin);
		const from = { sessionId: sender.hostSessionId(), cwd: sender.cwd() };
		const result = queueInBotInbox(agentDir, agentId, message, mode, from, entry.modelRef, behindStop, origin);
		// A sender that does not show why the words wait (`showsWaits`) leaves the owner to be told here.
		if (result.waitsFor !== undefined && !showsWaits) this.ports.warn(result.waitsFor);
		this.changed(agentId);
		return result;
	}

	/**
	 * Gives the words to the bot's loaded session: an idle one starts a turn, a running one takes them as a steer, or behind
	 * the turn when `mode` is `queue`. The owner's words are given as written; words under a recorded origin as no
	 * owner's (`recordedMessageOrigin`), and not again once its transcript holds their reference (an inbox record given
	 * twice, a reply sent again). Returns once the session accepted them; throws its refusal.
	 */
	private async give(
		entry: BotSessionEntry,
		message: string,
		mode: BotOperatorMessageOptions["mode"],
		origin: BotDeliveryOrigin,
	): Promise<BotOperatorMessageDispatchResult> {
		const { agentId } = entry;
		const recorded = origin === "owner" ? undefined : origin;
		if (recorded?.ref !== undefined && branchHoldsTurnRef(entry.sessionManager.getBranch(), recorded.ref))
			return { agentId, mode: "queued", messageId: recorded.ref, modelRef: entry.modelRef };
		// A turn the owner's stop aborted ends first: the words start the next turn, never steer the one dying.
		await entry.turnEnding;
		// Admitted here as well as at the run's start: a refusal answers the owner's send itself, not a failed turn.
		this.admission.admit(
			agentId,
			entry.session.model,
			{ key: entry.profileKey, spendBudget: entry.spendBudget },
			entry.builtFor,
		);
		const queued = mode === "queue";
		const wasRunning = this.isBusy(entry);
		const continued = entry.session.messages.length > 0;
		let accept: (accepted: boolean, reason?: string) => void = () => {};
		let wasAccepted = false;
		const accepted = new Promise<{ accepted: boolean; reason?: string }>((resolve) => {
			accept = (value, reason) => {
				wasAccepted ||= value;
				resolve({ accepted: value, ...(reason ? { reason } : {}) });
			};
		});
		this.touch(entry);
		entry.inFlight++;
		this.changed(agentId);
		void entry.session
			.prompt(message, {
				// The owner's words reach the bot as written: no slash command or template of the bot's own session runs them.
				expandPromptTemplates: false,
				processSlashCommands: false,
				streamingBehavior: queued ? "followUp" : "steer",
				...(recorded ? { source: "extension" as const, origin: recordedMessageOrigin(recorded) } : {}),
				preflightResult: (success, ended) => accept(success, ended?.reason),
			})
			.then(
				() => accept(false),
				(error: unknown) => {
					// Before acceptance the refusal is the send's own error; after it the turn failed and the owner is told.
					if (wasAccepted) this.notify(agentId, interfaceText().botTeam.botTurnFailed(agentId, errorText(error)));
					else accept(false, errorText(error));
				},
			)
			.finally(() => {
				entry.inFlight--;
				this.settle(entry);
			});
		const outcome = await accepted;
		if (!outcome.accepted) {
			const words = interfaceText().botTeam;
			throw new BotOwnerError(
				outcome.reason === undefined
					? words.botMessageNotTaken(agentId)
					: words.botMessageRefused(agentId, outcome.reason),
			);
		}
		return {
			agentId,
			mode: wasRunning ? (queued ? "queued" : "steered") : queued ? "queued" : continued ? "followed_up" : "started",
			messageId: `bot-msg-${Date.now()}`,
			modelRef: entry.modelRef,
		};
	}

	/**
	 * Whether the bot answers in a session of its own: never a leader or a bot a leader made (`botMayRunAsSession`), and a
	 * bot made from a profile unless its profile, compiled for the root its session is defined for (`senderFor`), needs what
	 * only a worker's run has (an independent verifier, a tool a session does not hold). A profile the resolution refuses is
	 * refused by the session, in the owner's words.
	 */
	runsAsSession(record: PersistentBotRecord, sender?: BotSender): boolean {
		const { profileId } = record;
		if (!botMayRunAsSession(record)) return false;
		if (profileId === undefined) return true;
		const compiled = this.senderFor(record.agentId, sender).compileProfile({ ...record, profileId });
		return !compiled.ok || profileBotSession(compiled).route === "session";
	}

	/**
	 * The root a bot's session is defined for: the one its loaded session was built for, else `sender` (a message's), else
	 * the root attached last.
	 */
	private senderFor(agentId: string, sender?: BotSender): BotSender {
		return this.entries.get(agentId)?.builtFor ?? sender ?? this.ports.sender();
	}

	/** The bot's loaded session, built or continued as the record defines it. */
	private async open(agentId: string, sender: BotSender): Promise<BotSessionEntry> {
		const stopped = () => new Error(interfaceText().botTeam.botSessionsClosing(agentId));
		if (this.stopped) throw stopped();
		// A close that never ends (a disposal that hangs) refuses the message instead of holding it, and every later one, forever.
		if (!(await this.endedWithinCloseWait([this.previousStop, this.closing.get(agentId)])))
			throw new BotOwnerError(interfaceText().botTeam.botSessionStillClosing(agentId));
		// A stop that came while the previous session closed has already counted the sessions it must close: none is built now.
		if (this.stopped) throw stopped();
		const record = this.ports.store().getBot(agentId);
		if (!record || record.retired) throw new BotOwnerError(interfaceText().botTeam.botMissing(agentId));
		// The one predicate the dispatch routes by: a bot it sends to a worker has no session here to diverge from it.
		const existing = this.entries.get(agentId);
		if (!this.runsAsSession(record, sender))
			throw new BotOwnerError(interfaceText().botTeam.botRunsAsWorker(agentId));
		if (existing) {
			// A record changed since the session was built (by another process, say): an idle session is rebuilt on it.
			if (this.isBusy(existing) || existing.profileKey === this.admission.keyOf(record, existing.builtFor))
				return existing;
			// The close is waited for, failure included, where every close is: under the bound of the next open.
			void this.close(agentId);
			return this.open(agentId, sender);
		}
		const pending = this.loading.get(agentId);
		if (pending) return pending;
		const built = this.loader.load(record, sender).finally(() => this.loading.delete(agentId));
		this.loading.set(agentId, built);
		return built;
	}

	/** Whether `closes` all ended within `BOT_SESSION_CLOSE_WAIT_MS` on the host's timers; a close that failed rejects. */
	private async endedWithinCloseWait(closes: readonly (Promise<void> | undefined)[]): Promise<boolean> {
		const timers = this.idleTimers();
		let alarm: unknown;
		const expired = new Promise<false>((resolve) => {
			alarm = timers.setTimeout(() => resolve(false), BOT_SESSION_CLOSE_WAIT_MS);
		});
		try {
			return await Promise.race([Promise.all(closes).then(() => true), expired]);
		} finally {
			timers.clearTimeout(alarm);
		}
	}

	/**
	 * Puts a bot's session just built (`BotSessionLoader`) to work here: kept, its state published, its saved note handed
	 * off, its idle bound armed, and the home watch and the inbox timer on.
	 */
	private register(entry: BotSessionEntry, continued: boolean): void {
		const { agentId, session } = entry;
		this.entries.set(agentId, entry);
		this.owed.loaded(agentId);
		this.publishState(entry);
		// A saved note an earlier holder left (pending or compacted) is handed off now, on the bounds and relay above.
		session.resumeSelfCompaction();
		this.armIdle(entry);
		harnessLog.info("bots", "a bot session was loaded", () => ({ agentId, continued }));
		this.changed(agentId);
		// Its watches live in its session's watch ledger, not the bot store: the roster's count follows the ledger's changes.
		const unwatch = session.backgroundLanes.ownWatches().subscribe(() => this.changed(agentId));
		const unobserve = entry.unsubscribe;
		entry.unsubscribe = () => {
			unwatch();
			unobserve();
		};
		// The home watch announces the inbox's next messages (the timer reads them while it does not run).
		this.view.watch();
		this.inbox.arm();
	}

	/** After an event: a busy session is not idle, an idle one starts its bound. */
	private settle(entry: BotSessionEntry): void {
		if (this.entries.get(entry.agentId) !== entry) return;
		if (this.holdsLoaded(entry)) this.touch(entry);
		else this.armIdle(entry);
		this.publishState(entry);
		this.changed(entry.agentId);
		this.recheckIfIdle(entry);
	}

	/**
	 * Applies a record change, or a refusal off the session path, that came while the session worked, once it is idle: by
	 * the idleness its idle close reads ({@link holdsLoaded}), so a change never waits on work that does not hold it open.
	 */
	private recheckIfIdle(entry: BotSessionEntry): boolean {
		if (!entry.recheckWhenIdle || this.holdsLoaded(entry) || this.entries.get(entry.agentId) !== entry) return false;
		entry.recheckWhenIdle = false;
		this.applyRecordChange(entry.agentId);
		return true;
	}

	/**
	 * Whether the session's work keeps it loaded past its idle bound: a turn or input, a worker running, or a worker retry
	 * due within the bound. A retry due later opens it again at its time (`BotOwedWork`), so it does not hold it. The one
	 * idleness every change of the loaded session waits on: its idle close, a record change, a refusal's retake, a release.
	 */
	private holdsLoaded(entry: BotSessionEntry): boolean {
		const state = entry.session.getSessionWorkState();
		const closesAt = this.idleTimers().now() + BOT_SESSION_IDLE_BOUND_MS;
		return (
			entry.inFlight > 0 ||
			entry.session.deliverablePendingMessageCount > 0 ||
			state.busyBesideWorkers ||
			state.hasRunningWorker ||
			!onlyWorkerRetriesWaitBeyond(state, closesAt)
		);
	}

	private touch(entry: BotSessionEntry): void {
		if (entry.idleTimer === undefined) return;
		this.idleTimers().clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}

	private armIdle(entry: BotSessionEntry): void {
		this.touch(entry);
		if (this.stopped || this.entries.get(entry.agentId) !== entry) return;
		// A home watch that failed since the session loaded leaves the inbox to the timer.
		this.inbox.arm();
		entry.idleTimer = this.idleTimers().setTimeout(() => {
			entry.idleTimer = undefined;
			if (this.entries.get(entry.agentId) !== entry || this.holdsLoaded(entry)) return;
			// A message or a stop another process sent is taken before the session may close (the watch may have missed it).
			const agentDir = this.ports.agentDir();
			if (botInboxWaiting(agentDir, entry.agentId) || botInboxStopWaiting(agentDir, entry.agentId)) {
				this.takeInbox(entry.agentId);
				return this.armIdle(entry);
			}
			if (this.recheckIfIdle(entry)) return this.armIdle(entry);
			// Its watches are sampled and their wakes taken only while it is loaded: it stays until they are woken, end or are dropped.
			const session = { id: entry.session.sessionId, file: entry.sessionManager.getSessionFile() };
			let owesWatches: boolean;
			try {
				owesWatches = owesWatchWork(this.ports.store(), session, this.idleTimers().now());
			} catch (error) {
				// What it is owed did not read: it stays loaded and is asked again at the next tick, the owner told once.
				if (!this.toldWatchesNotCounted.has(entry.agentId))
					this.ports.warn(interfaceText().botTeam.botWatchesNotCounted(entry.agentId, errorText(error)));
				this.toldWatchesNotCounted.add(entry.agentId);
				return this.armIdle(entry);
			}
			if (owesWatches) return this.armIdle(entry);
			// Its workers' owed execution (queued work, a retry due, a lease to take back) runs only while it is loaded.
			const { orchestrationHome } = entry.sessionManager.getStorageRoots();
			if (this.owed.owesLoadedExecution(entry.agentId, orchestrationHome, entry.session.sessionId))
				return this.armIdle(entry);
			void this.close(entry.agentId).catch((error: unknown) =>
				this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(entry.agentId, errorText(error))),
			);
		}, BOT_SESSION_IDLE_BOUND_MS);
	}

	/**
	 * The live watches the bot's own session holds, as the store and the session's watch ledger (`core/watches/`) say now: the loaded session's here, else the one its home
	 * saved last, which another process may be hosting. The bot is announced again when the first of them expires.
	 */
	liveWatches(agentId: string): number {
		let sessionId: string | undefined;
		let own: SessionWatchWork | undefined;
		try {
			const loaded = this.entries.get(agentId);
			const saved = loaded ? undefined : this.view.savedSessionOf(agentId);
			sessionId = loaded?.session.sessionId ?? saved?.id;
			const file = loaded ? loaded.sessionManager.getSessionFile() : saved?.file;
			own = file === undefined ? undefined : readSessionWatchWork(file, this.idleTimers().now());
		} catch (error) {
			// The roster draws what reads: a home whose session does not read now counts no watches, and says why once.
			if (!this.toldWatchesNotCounted.has(agentId))
				this.ports.warn(interfaceText().botTeam.botWatchesNotCounted(agentId, errorText(error)));
			this.toldWatchesNotCounted.add(agentId);
			return 0;
		}
		this.toldWatchesNotCounted.delete(agentId);
		if (sessionId === undefined) return 0;
		const live = liveOwnWatches(this.ports.store(), sessionId, this.idleTimers().now());
		const ends = [live.firstExpiresAt, own?.firstExpiresAt].filter((end): end is number => end !== undefined);
		if (ends.length > 0) this.watchExpiry.note(agentId, Math.min(...ends));
		return live.count + (own?.live ?? 0);
	}

	/**
	 * Takes up the releases a process left owed when it ended (`BotRelease.recoverOwed`), opens every bot whose own session
	 * is owed work that no process takes (see `BotOwedWork.openIfOwed`), and from then on lists the bots' inboxes on a slow
	 * cadence (`BotOwedWork.sweepInboxes`).
	 */
	openOwed(): void {
		this.owed.sweepInboxes();
		this.releases.recoverOwed();
		const bots = this.ports.store().listBots();
		if (bots.length === 0) return;
		this.view.watch();
		for (const bot of bots) this.owed.unhosted(bot.agentId);
	}

	/** A turn ended with words: they are the bot's summary in the roster, and its time marks the chat as unread. */
	private recordOutcome(agentId: string, summary: string): void {
		if (this.stopped) return;
		try {
			this.ports.store().recordBotTurnOutcome({ agentId, summary });
		} catch (error) {
			this.ports.warn(interfaceText().botTeam.botTurnOutcomeNotRecorded(agentId, errorText(error)));
		}
	}

	/**
	 * Closes the bot's session and gives its lock back; the next message builds a new one. Every step runs whatever an
	 * earlier one threw, in order: the lock is given back only once the session's disposal settled, so no other host
	 * builds a session of the bot while this one still writes its files.
	 */
	private close(agentId: string): Promise<void> {
		const entry = this.entries.get(agentId);
		const previous = this.closing.get(agentId);
		if (!entry) return previous ?? Promise.resolve();
		this.entries.delete(agentId);
		this.touch(entry);
		const closing = runAsyncReleaseSteps(
			[
				() => entry.session.abort(interfaceText().botTeam.botTurnAbortReasons.sessionClosing),
				// A turn still open ends here: its spend, then its answer, once, whether or not its end reached the subscription
				// first (a run end that announced a retry that never began leaves it open).
				() => entry.turns.ended(),
				() => entry.turns.close(),
				() => entry.unsubscribe(),
				() => entry.session.disposeAndWait(),
				() => entry.releaseSettings(),
				() => entry.stateWriter.clear(),
				() => entry.lock.release(),
			],
			interfaceText().botTeam.botSessionNotClosed,
		).finally(() => {
			this.changed(agentId);
			if (this.closing.get(agentId) === closing) this.closing.delete(agentId);
			// A change that waited for the session to be idle applies now it closed (a release among them, owed nothing below).
			if (entry.recheckWhenIdle && !this.stopped) {
				entry.recheckWhenIdle = false;
				this.applyRecordChange(agentId);
			}
			// Its bundle's writes done: what it could not deliver, its usage wait and its workers' next time are owed here now.
			this.owed.closed(agentId);
		});
		this.closing.set(agentId, closing);
		return closing;
	}

	/**
	 * The owner's stop of the bot's session (`bot-stop.ts`), written to its home dated now (`requestBotStop`) and taken by
	 * whichever process can: here when this host runs it (its turn and workers stopped; `stopped` says whether it ended a
	 * turn or input in flight, or at least one worker lane in flight), else by this process while no process hosts it, else by the
	 * process hosting it, which `elsewhere` names for the owner ({@link BotOwedWork.ownerStopped}). A bot that runs as no
	 * session of its own is not written to. A stop that could not be written is told to the owner; here it still ends the
	 * turn and the bot's work this host runs, whole (`endUnrecordedStopWork`).
	 */
	interrupt(agentId: string): { readonly stopped: boolean; readonly elsewhere?: string } {
		const entry = this.entries.get(agentId);
		const record = this.ports.store().getBot(agentId);
		if (!entry && (!record || record.retired || !this.runsAsSession(record))) return { stopped: false };
		const sender = this.ports.sender();
		const from = { pid: process.pid, sessionId: sender.hostSessionId(), cwd: sender.cwd() };
		if (!entry) {
			// Applied here while no process hosts it (then opened for the owner's words sent after it); its host takes it.
			const host = this.owed.ownerStopped(agentId, from);
			this.changed(agentId);
			const elsewhere = host && interfaceText().botTeam.botStopSentElsewhere(agentId, host.pid, host.hostSessionId);
			return elsewhere ? { stopped: false, elsewhere } : { stopped: false };
		}
		const stop = {
			agentId,
			reasonCode: OWNER_STOPPED_REASON,
			from,
			at: OWNER_STOP_CLOCK.now(),
			scope: WHOLE_FLEET_STOP_SCOPE,
		};
		const unwritten = writeOwnerStop(this.ports.agentDir(), stop, (message) => this.ports.warn(message));
		const state = entry.session.getSessionWorkState();
		// What the stop ends: a turn or input in flight, and every worker lane in flight (one waiting for its retry included).
		const turn = entry.inFlight > 0 || entry.session.deliverablePendingMessageCount > 0 || state.busyBesideWorkers;
		// Not taken from its record, the stop still ends the turn and own work; held in memory, it also applies whole.
		const taken = unwritten === undefined ? this.applyWaitingStops(agentId, entry) : undefined;
		const memory = taken?.stop || taken?.failure ? undefined : stop;
		const [dir, end] = [this.ports.agentDir(), () => this.stopTurn(entry, stop)];
		// What a failed take ended before it failed counts with what the fallback ends after it.
		const rest = taken?.stop
			? undefined
			: endUnrecordedStopWork(dir, agentId, entry, end, memory, stopOperation(stop.at), this.stopPorts());
		if (unwritten !== undefined) this.ports.warn(interfaceText().botTeam.botStopNotRecordedHere(agentId, unwritten));
		this.takeInbox(agentId);
		return { stopped: turn || (taken?.outcome.stopped ?? 0) + (rest?.stopped ?? 0) > 0 };
	}

	/**
	 * The bot's record changed: its profile follows it, and an idle session is closed so the next message builds one on the
	 * new record. A change while the session works is applied when it is idle; meanwhile a run on what no longer defines it
	 * is refused (`admit`), as it is for a worker. A record that left the session path (it became a leader's, a leader, or
	 * a profile only a worker's run holds) releases its session and the watches it armed: its messages now go to a worker,
	 * and two conversations of one bot never run side by side.
	 */
	recordChanged(record: PersistentBotRecord): void {
		const entry = this.entries.get(record.agentId);
		if (!entry && !this.hasHome(record.agentId)) return;
		ensureBotHome(this.ports.agentDir(), record);
		if (entry && this.holdsLoaded(entry)) {
			entry.recheckWhenIdle = true;
			return;
		}
		if (!this.runsAsSession(record)) {
			this.releases.releaseOwed(record.agentId);
			return;
		}
		if (entry && entry.profileKey !== this.admission.currentKey(record, entry.builtFor))
			void this.close(record.agentId).then(
				() => this.owed.openIfOwed(record.agentId),
				(error: unknown) =>
					this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(record.agentId, errorText(error))),
			);
		// A closed session owed work the old record could not run (a wake refused at its start) is taken up on the new one.
		else if (!entry) this.owed.openIfOwed(record.agentId);
	}

	/**
	 * {@link recordChanged} for a change the host noticed itself (a run refused on an outdated or off-path definition, a
	 * change that came while the session worked), with no caller to throw to. A failure for a bot whose record read as off
	 * the session path leaves its release owed (retried after a backoff); any other, an unread record among them, is told
	 * once until a change applies, and is applied again once the session is idle or at the bot's next change or message.
	 */
	private applyRecordChange(agentId: string): void {
		let offPath = false;
		try {
			const record = this.ports.store().getBot(agentId);
			offPath = record === undefined || record.retired || !this.runsAsSession(record);
			if (record) this.recordChanged(record);
			this.toldChangeNotApplied.delete(agentId);
		} catch (error) {
			const entry = this.entries.get(agentId);
			if (offPath) this.releases.owe(agentId, error);
			else if (entry) entry.recheckWhenIdle = true;
			if (offPath || this.toldChangeNotApplied.has(agentId)) return;
			this.toldChangeNotApplied.add(agentId);
			this.ports.warn(interfaceText().botTeam.botRecordChangeNotApplied(agentId, botFailureText(agentId, error)));
		}
	}

	/**
	 * The cause a run of the bot was refused for may have cleared (its model's quota reset): a closed session is opened
	 * again, and an idle one closed first, for its reopening's recovery runs the wakes it holds. A busy one ran since.
	 */
	private retakeRefused(agentId: string): void {
		const entry = this.entries.get(agentId);
		if (!entry) this.owed.openIfOwed(agentId);
		else if (!this.holdsLoaded(entry))
			void this.close(agentId).then(
				() => this.owed.openIfOwed(agentId),
				(error: unknown) =>
					this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(agentId, errorText(error))),
			);
	}

	private hasHome(agentId: string): boolean {
		return existsSync(botHomeOf(this.ports.agentDir(), agentId).profileFile);
	}

	/**
	 * Ends the bot's workers and closes its idle session (the bot was retired, or left the session path), and drops the
	 * watches its session armed: it is never woken there again, as a worker's watches go with the runtime that armed them.
	 * The messages waiting in its inbox are refused with the reason, which its chat shows: no session of it takes them now.
	 * Refuses while it works (`BotRelease`).
	 */
	release(agentId: string): void {
		this.releases.release(agentId);
	}

	/** {@link release} in two steps (`BotRelease.prepare`): the returned step runs once the caller's own change is made. */
	prepareRelease(agentId: string): () => void {
		return this.releases.prepare(agentId);
	}

	/**
	 * The bot's own conversation: its loaded session's messages (a running turn included), else the newest session file of
	 * its home read without opening it for writing. Undefined when the bot has no session of its own yet.
	 */
	readMessages(agentId: string): AgentMessage[] | undefined {
		const entry = this.entries.get(agentId);
		return entry ? [...entry.session.messages] : this.view.readMessages(agentId);
	}

	/**
	 * Closes every session and gives the locks back, all of them whichever fails, then ends the home watch and the history
	 * scan. After it no session is built.
	 */
	async stop(): Promise<void> {
		this.stopped = true;
		try {
			await Promise.allSettled([...this.loading.values()]);
			const ids = [...this.entries.keys()];
			const closed = await Promise.allSettled(ids.map((agentId) => this.close(agentId)));
			await Promise.allSettled([...this.closing.values()]);
			const words = interfaceText().botTeam;
			const failures = closed.flatMap((result, index) =>
				result.status === "rejected"
					? [new Error(words.botSessionCloseFailed(ids[index] ?? "", errorText(result.reason)))]
					: [],
			);
			if (failures.length > 0) throw new AggregateError(failures, words.botSessionsNotClosed);
		} finally {
			this.inbox.stop();
			this.stopRetries.stop();
			this.owed.stop();
			this.releases.stop();
			this.view.stop();
			this.watchExpiry.stop();
			this.listeners.clear();
			await this.history.stop();
		}
	}
}
