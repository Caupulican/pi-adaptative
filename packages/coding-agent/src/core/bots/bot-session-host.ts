/**
 * Hosts each bot as an `AgentSession` of its own, in this process: one session per bot, created on its first message
 * (`createAgentSession`, as the daemon's channel sessions are), continued from the session its home's pointer records
 * (`bot-session-open.ts`: one conversation per bot, whatever the working directory, with its bundle, leases and
 * transcripts in the bot's own `orchestration/`), kept while a turn runs or input is
 * queued, and closed after `BOT_SESSION_IDLE_BOUND_MS` of idleness or when the host stops.
 *
 * The session runs on the bot's own model (a profile bot's on the binding its profile admits), never replaced by another: a model that is missing, has no credentials, or that
 * the worker admission refuses (a metered model the owner did not choose, one the owner's model policy disallows) refuses
 * the message. The bot has an identity of its own: its name and its soul replace the main agent's in the system prompt
 * (the soul is judged again here because a stored record can have been edited by hand). It works in the owner's project
 * directory under a worker's private-path scope, with a settings manager of its own over the main session's settings
 * storage. It is a child session (no memory writes, no channels, and of the routines only the watches it arms itself)
 * that runs System One as the main session does (on or off, provider, transport), keeping its System One evidence in its
 * home; it is a session of its own, so its edge grants are its own conversation's plus the settings', never another
 * session's. Its tools are the read tools, System One's tool and a
 * shell, plus the file tools and python when the record grants `canWrite`; a read-only bot's shell runs only commands the
 * read-only shell line admits. A bot made from a worker profile runs on the contract its profile compiles to, again at
 * every run, by the resolution a fresh worker of it takes and none of a worker run's admission gates (`bot-session-profile.ts`): the resolved model, the plan's tools, read and write roots and read-only grant,
 * a capability ceiling held by the session's tool gate, the profile's soul and resources; a profile that needs what only
 * a worker's run has keeps it a worker (`runsAsSession`). Its spend per request it serves, its workers' included,
 * is held to the worker, session and profile ceilings, and charged to the main session's cost view (`bot-session-spend.ts`). Subagents, routines of
 * its own and goals belong to a later phase.
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
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import { harnessLog } from "../../kernel/harness-log.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { botHostLockFile } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { unpricedModelRefusal } from "../cost/session-turn-spend-bound.ts";
import type { SpawnedUsageReceiptDisposition } from "../cost/spawned-usage-receipt.ts";
import type {
	BotOperatorMessageDispatchResult,
	BotOperatorMessageOptions,
} from "../delegation/bot-operator-message-options.ts";
import type { BotSessionCompilation } from "../delegation/bot-session-compile.ts";
import type { PersistentBotRecord, PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { type HostLock, takeProcessLock } from "../remote/host-lock.ts";
import { liveOwnWatches } from "../routines/routine-holder.ts";
import type { SettingsManager } from "../settings-manager.ts";
import type { SystemOneHostSource } from "../system-one/session-source.ts";
import { runAsyncReleaseSteps } from "../util/resource-release.ts";
import type { TimerPort, TimerSource } from "../util/timer-port.ts";
import type { BotChargesHeld } from "./bot-charges-held.ts";
import { BotOwnerError, botFailureText } from "./bot-failure-words.ts";
import { BotHistory, type BotHistoryRead } from "./bot-history.ts";
import { botHomeOf, ensureBotHome } from "./bot-home.ts";
import { BotHostStateWriter, type BotSessionState, readRemoteBotHost } from "./bot-host-state.ts";
import {
	type BotInboxItem,
	type BotInboxRefusal,
	botInboxWaiting,
	readBotInbox,
	readBotInboxRefusals,
	refuseBotInboxMessage,
} from "./bot-inbox.ts";
import { BotInboxDrain } from "./bot-inbox-drain.ts";
import { BotSessionHeldError, sendToBotHost } from "./bot-inbox-send.ts";
import { type BotModelRefusal, BotModelRefusedError } from "./bot-model-refusal.ts";
import { type BotNotice, botNoticeLine, keepBotNotice, readBotNotices } from "./bot-notices.ts";
import { BotOpenRetries, botOpenFailure, storeFailure } from "./bot-open-retry.ts";
import { BotRemoteView, remoteHostActive } from "./bot-remote-view.ts";
import { createBotAgentSession } from "./bot-session-build.ts";
import { openHostedBotSession } from "./bot-session-open.ts";
import { BotOwedWork, cancelOtherSessionsWatches, owesWatchWork } from "./bot-session-owed-work.ts";
import {
	type BotSessionDefinition,
	botMayRunAsSession,
	ownBotSession,
	ownBotSessionKey,
	profileBotSession,
} from "./bot-session-profile.ts";
import { BotSessionSpend, botSpendCeilingsOn } from "./bot-session-spend.ts";
import { type BotSpendCeiling, observeBotSessionTurns } from "./bot-session-turns.ts";
import type { BotChargeReport } from "./bot-spend-ledger.ts";
import type { BotTurnAccounting } from "./bot-turn-report.ts";
import { BotWatchExpiry } from "./bot-watch-expiry.ts";

/** How long a bot's session stays loaded with no turn running and no input queued. */
export const BOT_SESSION_IDLE_BOUND_MS = 10 * 60 * 1000;
/** How long a message waits for an earlier session of its bot, or the stop of the host this one replaced, to end. */
export const BOT_SESSION_CLOSE_WAIT_MS = 30 * 1000;

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
		mode: BotOperatorMessageOptions["mode"],
	): Promise<BotOperatorMessageDispatchResult>;
}

interface BotSessionEntry {
	readonly agentId: string;
	readonly session: AgentSession;
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
	/** A record change, or a run refused off the session path, came while it worked: applied once it is idle. */
	recheckWhenIdle: boolean;
	/** Its turns' spend and outcome, each reported once per turn. */
	readonly turns: BotTurnAccounting;
	idleTimer: unknown;
}

/** What failed, in its own words: each cause of a failure that gathers several. */
function errorText(error: unknown): string {
	if (error instanceof AggregateError)
		return [error.message, ...error.errors.map(errorText)].filter(Boolean).join("; ");
	return error instanceof Error ? error.message : String(error);
}

export class BotSessionHost {
	private readonly ports: BotSessionHostPorts;
	/** The bot's earlier worker conversations, indexed in its home. */
	private readonly history: BotHistory;
	private readonly entries = new Map<string, BotSessionEntry>();
	/** The bots whose session state was told as kept in the owner's home: told once per process. */
	private readonly toldNotMoved = new Set<string>();
	/** Bots whose change the host noticed itself was not applied (`applyRecordChange`): told once until one applies. */
	private readonly toldChangeNotApplied = new Set<string>();
	/** Bots whose home's session did not read at the last roster count: told once until it reads again. */
	private readonly toldWatchesNotCounted = new Set<string>();
	/** Sessions being built, so two messages in a row build one. */
	private readonly loading = new Map<string, Promise<BotSessionEntry>>();
	/** Opens the session of a bot owed work that no process hosts. */
	private readonly owed: BotOwedWork;
	/** Sessions being closed: the next one of that bot opens once the file and the lock are free. */
	private readonly closing = new Map<string, Promise<void>>();
	private readonly listeners = new Set<(change: readonly string[]) => void>();
	private stopped = false;
	/** Bots whose release failed: it runs again after a backoff until it is done, and the owner was told once. */
	private readonly owedReleases = new Set<string>();
	private readonly releaseRetries = new BotOpenRetries({
		timers: () => this.idleTimers(),
		stopped: () => this.stopped,
		retry: (agentId) => this.releaseOwed(agentId),
	});
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

	constructor(ports: BotSessionHostPorts, previousStop?: Promise<void>) {
		this.ports = ports;
		this.previousStop = previousStop ?? Promise.resolve();
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
				hostChanged: (agentId) => this.owed.openIfOwed(agentId),
				changed: (agentIds) => this.changedMany(agentIds),
				inboxChanged: (agentId) => this.takeInbox(agentId),
			},
			this.holder,
		);
		this.owed = new BotOwedWork({
			agentDir: () => ports.agentDir(),
			store: () => ports.store(),
			timers: () => this.idleTimers(),
			warn: (message) => ports.warn(message),
			stopped: () => this.stopped,
			hostedHere: (agentId) => this.entries.has(agentId),
			heldElsewhere: (agentId) => readRemoteBotHost(ports.agentDir(), agentId, this.holder) !== undefined,
			savedSessionOf: (agentId) => this.view.savedSessionOf(agentId),
			waiting: (agentId) => this.readInbox(agentId).waiting,
			runsAsSession: (record) => this.runsAsSession(record),
			definedCwd: (record, sender) => this.define(record, sender).cwd,
			currentKey: (record, sender) => this.currentKey(record, sender),
			modelRefusal: (record, sender) => this.modelRefusal(record, this.define(record, sender)),
			admissionTimers: () => ports.timers().port("provider-admission"),
			retake: (agentId) => this.retakeRefused(agentId),
			takeInbox: (agentId) => this.takeInbox(agentId),
			sender: () => ports.sender(),
			senderIn: (cwd) => ports.senderIn(cwd),
			open: (agentId, sender) => this.open(agentId, sender),
		});
		this.inbox = new BotInboxDrain({
			agentDir: () => ports.agentDir(),
			timers: () => this.idleTimers(),
			watching: () => this.view.watching(),
			hosted: () => [...this.entries.keys()],
			give: async (agentId, message) => {
				const entry = this.entries.get(agentId);
				if (!entry || this.stopped) return false;
				await this.give(entry, message.text, message.mode);
				return true;
			},
			warn: (message) => ports.warn(message),
			changed: (agentId) => this.changed(agentId),
		});
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
		const unreadable = (file: string, reason: string) =>
			this.ports.warn(interfaceText().botTeam.botInboxUnreadable(agentId, file, reason));
		return {
			waiting: readBotInbox(agentDir, agentId, unreadable),
			refused: readBotInboxRefusals(agentDir, agentId, unreadable),
		};
	}

	/** What the bot's own session told the owner, oldest first (the newest few): every session's chat shows it. */
	readNotices(agentId: string): readonly BotNotice[] {
		return readBotNotices(this.ports.agentDir(), agentId, (file, reason) =>
			this.ports.warn(interfaceText().botTeam.botNoticeUnreadable(agentId, file, reason)),
		).map(({ message }) => message);
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
	 * Gives the owner's words to the bot's own session, building it first when it is not loaded. An idle session starts a
	 * turn ("started" on a new conversation, "followed_up" on a continued one); a running one takes the words as a steer, or
	 * behind the turn when `mode` is `queue`. Returns once the session accepted the words, not when the turn ends.
	 */
	async deliver(
		agentId: string,
		message: string,
		mode: BotOperatorMessageOptions["mode"],
		sender: BotSender = this.ports.sender(),
	): Promise<BotOperatorMessageDispatchResult> {
		let entry: BotSessionEntry;
		try {
			entry = await this.open(agentId, sender);
		} catch (error) {
			// Another host runs it, or it may open later (a holder keeps its host out, a passing read failure): the words wait
			// in its inbox, taken by that host or by this one's next open, which the send arms (`BotOwedWork.openLater`).
			if (!(error instanceof BotSessionHeldError) && botOpenFailure(error) === undefined) throw error;
			return sendToBotHost(
				{
					agentDir: this.ports.agentDir(),
					holder: this.holder,
					store: () => this.ports.store(),
					changed: (changedId) => this.changed(changedId),
					open: (openedId) => this.open(openedId, sender),
					openLater: (openedId, openError) => this.owed.openLater(openedId, openError),
				},
				agentId,
				message,
				mode,
				{ sessionId: sender.hostSessionId(), cwd: sender.cwd() },
			);
		}
		entry.sender = sender;
		return this.give(entry, message, mode);
	}

	/**
	 * Gives the words to the bot's loaded session: an idle one starts a turn, a running one takes them as a steer, or behind
	 * the turn when `mode` is `queue`. Returns once the session accepted them; throws its refusal.
	 */
	private async give(
		entry: BotSessionEntry,
		message: string,
		mode: BotOperatorMessageOptions["mode"],
	): Promise<BotOperatorMessageDispatchResult> {
		const { agentId } = entry;
		// Admitted here as well as at the run's start: a refusal answers the owner's send itself, not a failed turn.
		this.admit(
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
	 * Whether the bot's model may run now: the worker admission's rules for an explicitly requested model (read again each
	 * time, since the owner's policy changes), and a model that declares a price when a dollar bound applies. Asked before a
	 * session is built, and by the session at the start of every run, whatever opened it (the owner, a wake). A bot made
	 * from a profile is compiled again: a run on a session built from an older definition (a profile, pin or policy that
	 * changed since, which no record change announces) is refused, and the idle session is rebuilt on the new one. A run
	 * on another model than the one the bot is defined on is refused, and so is one on a model that cannot run now.
	 */
	private admit(
		agentId: string,
		model: Model<Api> | undefined,
		built: Pick<BotSessionDefinition, "key" | "spendBudget">,
		builtFor: BotSender,
	): void {
		const record = this.ports.store().getBot(agentId);
		const words = interfaceText().botTeam;
		if (!record || !model) throw new BotOwnerError(words.botMissing(agentId));
		const defined = this.route(record, builtFor);
		// A record that left the session path (a leader's, a leader, a profile only a worker's run holds) runs here no more:
		// the session is released once its work settles, and its messages go to a worker.
		if (defined === "worker") {
			queueMicrotask(() => this.applyRecordChange(agentId, true));
			throw new BotOwnerError(words.botRunsAsWorker(agentId));
		}
		if (defined.key !== built.key) {
			queueMicrotask(() => this.applyRecordChange(agentId, false));
			throw new BotOwnerError(words.botSessionOutdated(agentId));
		}
		// The session never leaves its model (`pinnedModel`); a run on any other is refused, never moved.
		if (!modelsAreEqual(model, defined.model))
			throw new BotOwnerError(
				words.botModelMoved(
					agentId,
					`${model.provider}/${model.id}`,
					`${defined.model.provider}/${defined.model.id}`,
				),
			);
		const refusal = this.modelRefusal(record, { model, spendBudget: built.spendBudget });
		if (refusal) throw new BotModelRefusedError(agentId, refusal);
	}

	/**
	 * Why the model may not run now under the record's rules and the bound that applies; undefined when it may. A metered
	 * model that declares no price is refused while a dollar ceiling holds it (`botSpendCeilingsOn`): its requests cannot
	 * be priced against it. A subscription model with no price is held by none, so none refuses it.
	 */
	private modelRefusal(
		record: PersistentBotRecord,
		{ model, spendBudget }: Pick<BotSessionDefinition, "model" | "spendBudget">,
	): BotModelRefusal | undefined {
		if (record.profileId === undefined) {
			const refused = this.ports.modelRefusal(record, model);
			if (refused) return refused;
		}
		const bounded = botSpendCeilingsOn(this.ports.spendCeilings(), spendBudget, model, this.ports.modelRegistry());
		const unpriced = bounded.length === 0 ? undefined : unpricedModelRefusal(model);
		return unpriced === undefined ? undefined : { cause: "model_unpriced", reason: unpriced };
	}

	/**
	 * Where the record answers now: the session it defines (a bot of its own on its record, a bot made from a profile on
	 * what the worker resolution compiles for it), or a worker's run (`runsAsSession` false). Throws the owner's words when
	 * it would run as a session and cannot.
	 */
	private route(record: PersistentBotRecord, sender: BotSender): BotSessionDefinition | "worker" {
		if (!botMayRunAsSession(record)) return "worker";
		const { profileId } = record;
		if (profileId === undefined) return ownBotSession(record, sender.cwd(), this.ports.modelRegistry());
		const compiled = sender.compileProfile({ ...record, profileId });
		if (!compiled.ok)
			throw new BotOwnerError(
				interfaceText().botTeam.botProfileRefused(record.agentId, profileId, compiled.skipReason),
			);
		const session = profileBotSession(compiled);
		return session.route === "worker" ? "worker" : session.definition;
	}

	/** The session the record defines now; throws the owner's words when it cannot run as one. */
	private define(record: PersistentBotRecord, sender: BotSender): BotSessionDefinition {
		const defined = this.route(record, sender);
		if (defined === "worker") throw new BotOwnerError(interfaceText().botTeam.botRunsAsWorker(record.agentId));
		return defined;
	}

	/** What defines the bot's session now; a bot of its own's is read from its record alone. */
	private keyOf(record: PersistentBotRecord, sender: BotSender): string {
		return record.profileId === undefined ? ownBotSessionKey(record) : this.define(record, sender).key;
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
			if (this.isBusy(existing) || existing.profileKey === this.keyOf(record, existing.builtFor)) return existing;
			// The close is waited for, failure included, where every close is: under the bound of the next open.
			void this.close(agentId);
			return this.open(agentId, sender);
		}
		const pending = this.loading.get(agentId);
		if (pending) return pending;
		const built = this.load(record, sender).finally(() => this.loading.delete(agentId));
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

	private async load(record: PersistentBotRecord, sender: BotSender): Promise<BotSessionEntry> {
		const agentDir = this.ports.agentDir();
		const { agentId } = record;
		const words = interfaceText().botTeam;
		const { home, profile } = ensureBotHome(agentDir, record);
		const definition = this.define(record, sender);
		const { model, cwd } = definition;
		// A model refused now builds no session and takes no lock.
		this.admit(agentId, model, definition, sender);
		const taken = takeProcessLock(botHostLockFile(agentDir, agentId), this.holder);
		if (!taken.held) {
			const sessionId = readRemoteBotHost(agentDir, agentId, this.holder)?.hostSessionId;
			throw new BotSessionHeldError(words.botSessionHeld(agentId, taken.owner.pid, sessionId));
		}
		const { lock } = taken;
		let session: AgentSession | undefined;
		let settings: ReturnType<BotSender["settings"]> | undefined;
		let built: BotSessionEntry | undefined;
		// Until its file is open, a failure is a read of the bot's session store; after, only one in its orchestration home
		// (its lease) is (`storeFailure`).
		let storeWithin: string | undefined;
		try {
			// The session the bot's home records, whatever directory it worked in: a bot keeps one conversation.
			const { sessionManager, continued } = openHostedBotSession(agentDir, home, cwd, {
				pointerSetAside: (file, reason) => this.ports.warn(words.botSessionPointerSetAside(agentId, file, reason)),
				notMoved: (kept) => {
					if (this.toldNotMoved.has(agentId)) return;
					this.toldNotMoved.add(agentId);
					this.ports.warn(
						kept.reason === "in-both-homes"
							? words.botSessionStateInBothHomes(agentId, kept.ownerBundle)
							: kept.reason === "worker-records"
								? words.botSessionStateKeptForWorkers(agentId)
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
				this.idleTimers().now(),
			);
			if (cancelled > 0) this.ports.warn(interfaceText().botTeam.botWatchesCancelled(agentId, cancelled));
			settings = sender.settings();
			const settingsManager = settings.settings;
			const registry = this.ports.modelRegistry();
			// The bot's spend per request it serves: its turns and the runs of the workers they start share one bound.
			const spend = new BotSessionSpend(agentId, home, sessionManager, definition, registry, {
				rootCeilings: () => this.ports.spendCeilings(),
				snapshot: () => session?.backgroundLanes.getTaskRuntimeSnapshot(),
				now: () => this.idleTimers().now(),
				warn: (message) => this.ports.warn(message),
			});
			session = await createBotAgentSession({
				agentId,
				agentDir,
				definition,
				displayName: profile.displayName,
				memoryBlock: this.ports.store().composeBotUnifiedMemoryContext(agentId, undefined, undefined, "session")
					.promptBlock,
				sessionManager,
				settingsManager,
				registry,
				systemOne: () => this.ports.systemOne(),
				timers: this.ports.timers(),
				host: {
					workerRunCostBound: spend.workerRunCostBound,
					// Its notices (a lost watch, System One without an engine) reach the owner in the bot's chat.
					ownerNoticeLine: botNoticeLine(agentDir, agentId, {
						keep: (text, deliveryId) => this.notify(agentId, text, true, deliveryId),
						warn: (line) => this.ports.warn(line),
					}),
					// Every run is admitted at its start, whatever opened it: a wake's turn is held to the owner's rules too.
					admitRun: () => {
						try {
							this.admit(agentId, session?.model, definition, sender);
						} catch (error) {
							// The wakes it holds are refused with this run, for this cause: they are taken up again once it clears.
							this.owed.refused(agentId, definition.key, sessionManager, error);
							throw error;
						}
						this.owed.admitted(agentId);
					},
					onClosingWarnings: (warnings) => {
						for (const warning of warnings)
							this.notify(agentId, interfaceText().botTeam.botWarning(agentId, warning));
					},
				},
			});
			const entry: BotSessionEntry = {
				agentId,
				session,
				lock,
				releaseSettings: settings.release,
				stateWriter: new BotHostStateWriter(agentDir, {
					agentId,
					hostKind: "session",
					hostSessionId: sender.hostSessionId(),
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
				recheckWhenIdle: false,
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
					outcome: (summary) => this.recordOutcome(agentId, summary),
				}),
				idleTimer: undefined,
			};
			built = entry;
			entry.unsubscribe = observeBotSessionTurns(session, entry.turns, {
				agentId,
				role: definition.role,
				cwd,
				timers: this.idleTimers(),
				...spend.turnBound(),
				maxWallClockMs: () => settingsManager.getWorkerDelegationSettings().maxWallClockMs,
				notify: (text, mark) => this.notify(agentId, text, mark),
				settle: () => this.settle(entry),
			});
			session.startBackgroundInputs();
			this.entries.set(agentId, entry);
			this.owed.loaded(agentId);
			this.publishState(entry);
			// A saved note an earlier holder left (pending or compacted) is handed off now, on the bounds and relay above.
			session.resumeSelfCompaction();
			this.armIdle(entry);
			harnessLog.info("bots", "a bot session was loaded", () => ({ agentId, continued }));
			this.changed(agentId);
			// What other processes sent while another host held the bot is given first, before the message that opened it;
			// the home watch announces the next ones (the timer reads them while it does not run).
			this.view.watch();
			this.inbox.arm();
			await this.inbox
				.drain(agentId)
				.catch((error: unknown) => this.ports.warn(words.botInboxNotTaken(agentId, errorText(error))));
			return entry;
		} catch (error) {
			// Released as a close releases, in its order and every step whatever an earlier one threw, the lock last: a
			// session still disposing never loses its lock to the next one built.
			if (built && this.entries.get(agentId) === built) this.entries.delete(agentId);
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

	/** After an event: a busy session is not idle, an idle one starts its bound. */
	private settle(entry: BotSessionEntry): void {
		if (this.entries.get(entry.agentId) !== entry) return;
		if (this.isBusy(entry)) this.touch(entry);
		else this.armIdle(entry);
		this.publishState(entry);
		this.changed(entry.agentId);
		this.recheckIfIdle(entry);
	}

	/** Applies a record change, or a refusal off the session path, that came while the session worked, once it is idle. */
	private recheckIfIdle(entry: BotSessionEntry): boolean {
		if (!entry.recheckWhenIdle || this.isBusy(entry) || this.entries.get(entry.agentId) !== entry) return false;
		entry.recheckWhenIdle = false;
		this.applyRecordChange(entry.agentId, false);
		return true;
	}

	private touch(entry: BotSessionEntry): void {
		if (entry.idleTimer === undefined) return;
		this.idleTimers().clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}

	private armIdle(entry: BotSessionEntry): void {
		this.touch(entry);
		if (this.stopped) return;
		// A home watch that failed since the session loaded leaves the inbox to the timer.
		this.inbox.arm();
		entry.idleTimer = this.idleTimers().setTimeout(() => {
			entry.idleTimer = undefined;
			if (this.entries.get(entry.agentId) !== entry || this.isBusy(entry)) return;
			// A message another process sent is given before the session may close (the watch may have missed it).
			if (botInboxWaiting(this.ports.agentDir(), entry.agentId)) {
				this.takeInbox(entry.agentId);
				return this.armIdle(entry);
			}
			if (this.recheckIfIdle(entry)) return;
			// Its watches are sampled and their wakes taken only while it is loaded: it stays until they are woken, end or are dropped.
			if (owesWatchWork(this.ports.store(), entry.session.sessionId, this.idleTimers().now()))
				return this.armIdle(entry);
			void this.close(entry.agentId).catch((error: unknown) =>
				this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(entry.agentId, errorText(error))),
			);
		}, BOT_SESSION_IDLE_BOUND_MS);
	}

	/**
	 * The live watches the bot's own session holds, as the store says now: the loaded session's here, else the one its home
	 * saved last, which another process may be hosting. The bot is announced again when the first of them expires.
	 */
	liveWatches(agentId: string): number {
		let sessionId: string | undefined;
		try {
			sessionId = this.entries.get(agentId)?.session.sessionId ?? this.view.savedSessionOf(agentId)?.id;
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
		if (live.firstExpiresAt !== undefined) this.watchExpiry.note(agentId, live.firstExpiresAt);
		return live.count;
	}

	/**
	 * Opens every bot whose own session is owed work that no process takes (see `BotOwedWork.openIfOwed`), and from then on
	 * lists the bots' inboxes on a slow cadence (`BotOwedWork.sweepInboxes`).
	 */
	openOwed(): void {
		this.owed.sweepInboxes();
		const bots = this.ports.store().listBots();
		if (bots.length === 0) return;
		this.view.watch();
		for (const bot of bots) this.owed.openIfOwed(bot.agentId);
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
		});
		this.closing.set(agentId, closing);
		return closing;
	}

	/**
	 * Stops the turn the bot's session is running here. `stopped` says whether there was one: the session settles the stop
	 * itself, and a failure to stop reaches the owner as a warning. A turn another host runs is stopped only from the
	 * session hosting it: `elsewhere` names that session, for the owner.
	 */
	interrupt(agentId: string): { readonly stopped: boolean; readonly elsewhere?: string } {
		const entry = this.entries.get(agentId);
		if (!entry) {
			const host = this.view.hostOf(agentId);
			return remoteHostActive(host)
				? {
						stopped: false,
						elsewhere: interfaceText().botTeam.botRunsElsewhere(agentId, host.pid, host.hostSessionId),
					}
				: { stopped: false };
		}
		if (!this.isBusy(entry)) return { stopped: false };
		void entry.session
			.abort(interfaceText().botTeam.botTurnAbortReasons.ownerStopped)
			.catch((error: unknown) => this.ports.warn(interfaceText().botTeam.botTurnFailed(agentId, errorText(error))));
		return { stopped: true };
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
		if (entry && this.isBusy(entry)) {
			entry.recheckWhenIdle = true;
			return;
		}
		if (!this.runsAsSession(record)) {
			this.releaseOwed(record.agentId);
			return;
		}
		if (entry && entry.profileKey !== this.currentKey(record, entry.builtFor))
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
	 * change that came while the session worked), from a microtask or a settle with no caller to throw to: a failure of a
	 * bot that left the session path (`leftPath`) leaves its release owed, run again after a backoff; any other is told
	 * once until a change applies, and applies at the bot's next change or message.
	 */
	private applyRecordChange(agentId: string, leftPath: boolean): void {
		try {
			const record = this.ports.store().getBot(agentId);
			if (record) this.recordChanged(record);
			this.toldChangeNotApplied.delete(agentId);
		} catch (error) {
			if (leftPath) {
				this.oweRelease(agentId, error);
				return;
			}
			if (this.toldChangeNotApplied.has(agentId)) return;
			this.toldChangeNotApplied.add(agentId);
			this.ports.warn(interfaceText().botTeam.botRecordChangeNotApplied(agentId, botFailureText(agentId, error)));
		}
	}

	/** What defines the bot's session now; undefined when its profile no longer admits it as one (it is refused when opened). */
	private currentKey(record: PersistentBotRecord, sender: BotSender): string | undefined {
		try {
			return this.keyOf(record, sender);
		} catch {
			return undefined;
		}
	}

	/**
	 * The cause a run of the bot was refused for may have cleared (its model's quota reset): a closed session is opened
	 * again, and an idle one closed first, for its reopening's recovery runs the wakes it holds. A busy one ran since.
	 */
	private retakeRefused(agentId: string): void {
		const entry = this.entries.get(agentId);
		if (!entry) this.owed.openIfOwed(agentId);
		else if (!this.isBusy(entry))
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
	 * Closes the bot's idle session (the bot was retired, or left the session path) and drops the watches its session armed:
	 * it is never woken there again, as a worker's watches go with the runtime that armed them. The messages waiting in its
	 * inbox are refused with the reason, which its chat shows: no session of it takes them now. Refuses while it works.
	 */
	release(agentId: string): void {
		this.prepareRelease(agentId)();
	}

	/**
	 * {@link release} in two steps: what it changes is read now (the bot's session, its watches, its inbox), and a refusal or
	 * a failed read throws here, before anything changed; the returned step changes it, once the caller's own change (a
	 * retirement) is made, reading it again then, and never throws: what it could not finish stays owed
	 * ({@link finishRelease}).
	 */
	prepareRelease(agentId: string): () => void {
		const entry = this.entries.get(agentId);
		if (entry && this.isBusy(entry)) throw new BotOwnerError(interfaceText().botTeam.botHasActiveWork(agentId));
		const sessionId = entry?.session.sessionId ?? this.view.savedSessionOf(agentId)?.id;
		if (sessionId !== undefined) this.ports.store().listRoutines({ sessionId, scope: "own-watches" });
		this.readInbox(agentId);
		return () => this.finishRelease(agentId, sessionId, entry !== undefined);
	}

	/**
	 * The change step of a release: the watches and the inbox are read again now, so a watch armed or changed and a
	 * message sent since the preparation go too, each watch dropped at the revision read. A failure (a revision that
	 * changed again, a read) leaves the release owed: it runs whole again after a backoff ({@link releaseOwed}).
	 */
	private finishRelease(agentId: string, sessionId: string | undefined, loaded: boolean): void {
		this.owed.released(agentId);
		try {
			const store = this.ports.store();
			const nowMs = this.idleTimers().now();
			const watches = sessionId === undefined ? [] : store.listRoutines({ sessionId, scope: "own-watches" });
			for (const watch of watches) store.deleteRoutine(watch.routineId, watch.revision, nowMs);
			const { waiting } = this.readInbox(agentId);
			const agentDir = this.ports.agentDir();
			for (const item of waiting)
				refuseBotInboxMessage(agentDir, item, interfaceText().botTeam.botInboxReleased(agentId), Date.now());
			if (waiting.length > 0) this.changed(agentId);
			this.owedReleases.delete(agentId);
			this.releaseRetries.forget(agentId);
		} catch (error) {
			this.oweRelease(agentId, error);
		}
		if (!loaded) return;
		void this.close(agentId).catch((error: unknown) =>
			this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(agentId, errorText(error))),
		);
	}

	/**
	 * Releases the bot (it left the session path, or a release it owes runs again): a failure leaves it owed, run again
	 * after a backoff until it is done. A bot back on the session path owes none.
	 */
	private releaseOwed(agentId: string): void {
		try {
			const record = this.ports.store().getBot(agentId);
			if (record && !record.retired && this.runsAsSession(record)) {
				this.owedReleases.delete(agentId);
				this.releaseRetries.forget(agentId);
				return;
			}
			this.release(agentId);
		} catch (error) {
			this.oweRelease(agentId, error);
		}
	}

	/** The bot's release failed with `error`: it is run again after a backoff, and the owner is told once. */
	private oweRelease(agentId: string, error: unknown): void {
		if (!this.owedReleases.has(agentId))
			this.ports.warn(interfaceText().botTeam.botReleaseOwed(agentId, botFailureText(agentId, error)));
		this.owedReleases.add(agentId);
		this.releaseRetries.arm(agentId, false);
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
			this.owed.stop();
			this.releaseRetries.stop();
			this.view.stop();
			this.watchExpiry.stop();
			this.listeners.clear();
			await this.history.stop();
		}
	}
}
