/**
 * Hosts each bot as an `AgentSession` of its own, in this process: one session per bot, created on its first message
 * (`createAgentSession`, as the daemon's channel sessions are), continued from the newest file of the bot's own
 * `sessions/` directory (one conversation per bot, whatever the working directory), kept while a turn runs or input is
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
 * read-only shell line admits. A bot made from a worker profile runs on what the worker admission compiles for it, again
 * at every run (`bot-session-profile.ts`): the admitted model, the plan's tools, read and write roots and read-only grant,
 * a capability ceiling held by the session's tool gate, the profile's soul and resources; a profile that needs what only
 * a worker's run has keeps it a worker (`runsAsSession`). Each turn is bounded by the worker spend bound (and the
 * profile's cost budget, when lower) and its usage is reported to the main session's cost view. Subagents, routines of
 * its own and goals belong to a later phase.
 *
 * One process hosts a bot's session at a time (`bots/<id>/host.lock`): a second process is refused, naming the session
 * that hosts the bot, rather than appending to the same file. Every process still sees the bot: its conversation is read
 * from the home's session files, and its state from `host-state.json`, which the hosting process publishes on each change
 * of state. What the host reads of a bot it does not run, with the watch over the bot homes that tells an open roster
 * and an open chat when either changed whichever process wrote it, is `BotRemoteView` (`stateOf`, `readMessages`,
 * `subscribe`). A change of the bot's record rebuilds an idle session on the next message and is refused while a turn
 * runs. A finished turn records its outcome in the store as a worker's did, so the roster's unread mark and summary keep
 * working. This host only reads and writes the bot's own home and session.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model, Usage } from "@caupulican/pi-ai";
import { modelsAreEqual } from "@caupulican/pi-ai/models";
import { harnessLog } from "../../kernel/harness-log.ts";
import { readSessionHeader } from "../../kernel/session/session-file-reading.ts";
import { findMostRecentSessionInDirs } from "../../kernel/session/session-listing.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { namedAgentIdentity } from "../agent-identity.ts";
import { botHostLockFile, botSystemOneEvidenceDir } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { boundSessionTurnSpend, unpricedModelRefusal } from "../cost/session-turn-spend-bound.ts";
import { usageSince } from "../cost/usage-delta.ts";
import type { BotOperatorMessageOptions } from "../delegation/bot-operator-message-options.ts";
import type { BotSessionCompilation } from "../delegation/bot-worker-start.ts";
import type {
	BotOperatorMessageDispatchResult,
	PersistentBotRecord,
	PersistentBotTeamStore,
} from "../delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { type HostLock, takeProcessLock } from "../remote/host-lock.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { liveOwnWatches } from "../routines/routine-holder.ts";
import { createAgentSession } from "../sdk.ts";
import type { SettingsManager } from "../settings-manager.ts";
import { deriveSpawnedUsageReportId, hasReportableUsage } from "../spawned-usage.ts";
import type { SystemOneHostSource } from "../system-one/session-source.ts";
import { runAsyncReleaseSteps } from "../util/resource-release.ts";
import type { TimerPort, TimerSource } from "../util/timer-port.ts";
import { BotHistory, type BotHistoryRead } from "./bot-history.ts";
import { botHomeOf, ensureBotHome } from "./bot-home.ts";
import { BotHostStateWriter, type BotSessionState, readRemoteBotHost } from "./bot-host-state.ts";
import { BotRemoteView, remoteHostActive } from "./bot-remote-view.ts";
import {
	type BotSessionDefinition,
	botMayRunAsSession,
	ownBotSession,
	ownBotSessionKey,
	profileBotSession,
} from "./bot-session-profile.ts";
import { BotTurnSupervision } from "./bot-turn-supervision.ts";
import { BotWatchExpiry } from "./bot-watch-expiry.ts";

/** How long a bot's session stays loaded with no turn running and no input queued. */
export const BOT_SESSION_IDLE_BOUND_MS = 10 * 60 * 1000;

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
	/**
	 * A settings manager of the bot's own over the storage the main session reads (`SettingsManager.sibling`), reading
	 * again each change the main session's manager makes until `release`.
	 */
	settings(): { readonly settings: SettingsManager; release(): void };
	/** The main session's System One as it is now: a bot's session follows it at each use, as the main session runs it. */
	systemOne(): SystemOneHostSource;
	timers(): TimerSource;
	/** An owner-facing warning that no bot turn's sender owns (a session that did not close cleanly, a lost watch). */
	warn(message: string): void;
	/** Why the worker admission refuses the bot's model now; undefined when it may run. */
	modelRefusal(record: PersistentBotRecord, model: Model<Api>): string | undefined;
	/** What the worker admission compiles a bot made from a profile to, exactly as it would admit a worker of it. */
	compileProfile(record: PersistentBotRecord & { readonly profileId: string }): BotSessionCompilation;
	/**
	 * The dollars one turn may spend, as a worker's budget bounds it, with the bound that sets it (the owner's worker bound
	 * or the main session's autonomy bound, the lower); undefined when nothing bounds it.
	 */
	turnSpendBound(): BotTurnSpendBound | undefined;
}

/**
 * The root session a bot's message came from: the owner's project directory a bot it loads works in, the pi session named
 * as its host, and where its turns' warnings and spend go. Once that root detaches, the root attached last answers.
 */
export interface BotSender {
	cwd(): string;
	/** The pi session that hosts the bot, named to the owner when another process is refused. */
	hostSessionId(): string;
	/** An owner-facing warning of the bot's turn (a turn that failed, a spend bound reached). */
	warn(message: string): void;
	/** Records what a bot's turn spent with the root session's cost view, once per `reportId`. */
	reportUsage(usage: Usage, report: BotTurnUsageReport): void;
}

/** What a root session's message dispatch asks of the host: its deliveries carry that root as their sender. */
export interface BotSessionDelivery extends Pick<BotSessionHost, "noteHistoryRun" | "runsAsSession"> {
	deliver(
		agentId: string,
		message: string,
		mode: BotOperatorMessageOptions["mode"],
	): Promise<BotOperatorMessageDispatchResult>;
}

/** One turn's dollar bound, with the bound that sets it: the owner's worker bound, the main session's, or the bot's profile's. */
export interface BotTurnSpendBound {
	readonly usd: number;
	readonly bound: "worker" | "session" | "profile";
}

/** One turn's charge, as the main session's ledger takes it. */
export interface BotTurnUsageReport {
	readonly agentId: string;
	readonly reportId: string;
	/** The bot's own session id. */
	readonly sessionId: string;
	readonly provider: string;
	readonly model: string;
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
	/** The root its last message came from: its turns' warnings and spend go there. */
	sender: BotSender;
	/** What defined the session when it was built (`BotSessionDefinition.key`). */
	readonly profileKey: string;
	/** Its profile's dollar bound on one turn, for a bot made from a profile. */
	readonly spendBoundUsd: number | undefined;
	unsubscribe: () => void;
	/** Prompts submitted and not yet settled. */
	inFlight: number;
	/** The session's cumulative usage when the running turn began; absent between turns. */
	usageBefore: Usage | undefined;
	/** When the running turn began: its own messages are the ones written since; absent between turns. */
	turnStartedAt: number | undefined;
	idleTimer: unknown;
}

/** What failed, in its own words: each cause of a failure that gathers several. */
function errorText(error: unknown): string {
	if (error instanceof AggregateError) return error.errors.map(errorText).join("; ");
	return error instanceof Error ? error.message : String(error);
}

/**
 * The words of the newest assistant message that has any, written at or after `since`: the outcome of the turn that
 * began then. Read by time, so a compaction during the turn does not hide its answer.
 */
function lastAssistantText(messages: readonly AgentMessage[], since: number): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		if (message.timestamp < since) return "";
		const text = message.content
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return "";
}

export class BotSessionHost {
	private readonly ports: BotSessionHostPorts;
	/** The bot's earlier worker conversations, indexed in its home. */
	private readonly history: BotHistory;
	private readonly entries = new Map<string, BotSessionEntry>();
	/** Sessions being built, so two messages in a row build one. */
	private readonly loading = new Map<string, Promise<BotSessionEntry>>();
	/** Sessions being closed: the next one of that bot opens once the file and the lock are free. */
	private readonly closing = new Map<string, Promise<void>>();
	private readonly listeners = new Set<(change: readonly string[]) => void>();
	private stopped = false;
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
				// A host that let a bot go leaves its watches unsampled until a process opens its session again.
				hostChanged: (agentId) => this.openIfWatching(agentId),
				changed: (agentIds) => this.changedMany(agentIds),
			},
			this.holder,
		);
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
		const entry = await this.open(agentId, sender);
		entry.sender = sender;
		// Admitted here as well as at the run's start: a refusal answers the owner's send itself, not a failed turn.
		this.admit(agentId, entry.session.model, { key: entry.profileKey, spendBoundUsd: entry.spendBoundUsd });
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
					if (wasAccepted) entry.sender.warn(interfaceText().botTeam.botTurnFailed(agentId, errorText(error)));
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
			throw new Error(
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
	 * time, since the owner's policy changes), and a model that declares a price when a bound applies. Asked before a
	 * session is built, and by the session at the start of every run, whatever opened it (the owner, a wake). A bot made
	 * from a profile is compiled again: a run on a session built from an older definition (a profile, pin or policy that
	 * changed since, which no record change announces) is refused, and the idle session is rebuilt on the new one. A run
	 * on another model than the one the bot is defined on is refused, and so is one on a model that cannot run now.
	 */
	private admit(
		agentId: string,
		model: Model<Api> | undefined,
		built: Pick<BotSessionDefinition, "key" | "spendBoundUsd">,
	): void {
		const record = this.ports.store().getBot(agentId);
		const words = interfaceText().botTeam;
		if (!record || !model) throw new Error(words.botMissing(agentId));
		const defined = this.define(record);
		if (defined.key !== built.key) {
			queueMicrotask(() => this.recordChanged(record));
			throw new Error(words.botSessionOutdated(agentId));
		}
		// The session never leaves its model (`pinnedModel`); a run on any other is refused, never moved.
		if (!modelsAreEqual(model, defined.model))
			throw new Error(
				words.botModelMoved(
					agentId,
					`${model.provider}/${model.id}`,
					`${defined.model.provider}/${defined.model.id}`,
				),
			);
		const refusal =
			(record.profileId === undefined ? this.ports.modelRefusal(record, model) : undefined) ??
			(this.spendBound(built.spendBoundUsd) === undefined ? undefined : unpricedModelRefusal(model));
		if (refusal) throw new Error(words.botModelRefused(agentId, refusal));
	}

	/** The lower of the owner's and the main session's bounds on one turn and the bot's profile's own. */
	private spendBound(profileBoundUsd: number | undefined): BotTurnSpendBound | undefined {
		const bound = this.ports.turnSpendBound();
		return profileBoundUsd !== undefined &&
			profileBoundUsd > 0 &&
			(bound === undefined || profileBoundUsd < bound.usd)
			? { usd: profileBoundUsd, bound: "profile" }
			: bound;
	}

	/**
	 * The session the record defines now: a bot of its own on its record, a bot made from a profile on what the worker
	 * admission compiles for it. Throws the owner's words when it cannot run as a session.
	 */
	private define(record: PersistentBotRecord, cwd = this.ports.sender().cwd()): BotSessionDefinition {
		const { profileId } = record;
		if (profileId === undefined) return ownBotSession(record, cwd, this.ports.modelRegistry());
		const words = interfaceText().botTeam;
		const compiled = this.ports.compileProfile({ ...record, profileId });
		if (!compiled.ok) throw new Error(words.botProfileRefused(record.agentId, profileId, compiled.skipReason));
		const session = profileBotSession(compiled);
		if (session.route === "worker")
			throw new Error(words.botProfileRefused(record.agentId, profileId, session.reason));
		return session.definition;
	}

	/** What defines the bot's session now; a bot of its own's is read from its record alone. */
	private keyOf(record: PersistentBotRecord): string {
		return record.profileId === undefined ? ownBotSessionKey(record) : this.define(record).key;
	}

	/**
	 * Whether the bot answers in a session of its own: never a leader or a bot a leader made (`botMayRunAsSession`), and a
	 * bot made from a profile unless its profile needs what only a worker's run has (an independent verifier, a tool a session does not hold). A profile the admission refuses is
	 * refused by the session, in the owner's words.
	 */
	runsAsSession(record: PersistentBotRecord): boolean {
		const { profileId } = record;
		if (!botMayRunAsSession(record)) return false;
		if (profileId === undefined) return true;
		const compiled = this.ports.compileProfile({ ...record, profileId });
		return !compiled.ok || profileBotSession(compiled).route === "session";
	}

	/** The bot's loaded session, built or continued as the record defines it. */
	private async open(agentId: string, sender: BotSender): Promise<BotSessionEntry> {
		const stopped = () => new Error(interfaceText().botTeam.botSessionsClosing(agentId));
		if (this.stopped) throw stopped();
		await this.previousStop;
		await this.closing.get(agentId);
		// A stop that came while the previous session closed has already counted the sessions it must close: none is built now.
		if (this.stopped) throw stopped();
		const record = this.ports.store().getBot(agentId);
		if (!record || record.retired) throw new Error(interfaceText().botTeam.botMissing(agentId));
		// The one predicate the dispatch routes by: a bot it sends to a worker has no session here to diverge from it.
		if (!this.runsAsSession(record)) throw new Error(interfaceText().botTeam.botRunsAsWorker(agentId));
		const existing = this.entries.get(agentId);
		if (existing) {
			// A record changed since the session was built (by another process, say): an idle session is rebuilt on it.
			if (this.isBusy(existing) || existing.profileKey === this.keyOf(record)) return existing;
			await this.close(agentId);
			return this.open(agentId, sender);
		}
		const pending = this.loading.get(agentId);
		if (pending) return pending;
		const built = this.load(record, sender).finally(() => this.loading.delete(agentId));
		this.loading.set(agentId, built);
		return built;
	}

	private async load(record: PersistentBotRecord, sender: BotSender): Promise<BotSessionEntry> {
		const agentDir = this.ports.agentDir();
		const { agentId } = record;
		const words = interfaceText().botTeam;
		const { home, profile } = ensureBotHome(agentDir, record);
		const definition = this.define(record, sender.cwd());
		const { model, cwd } = definition;
		// A model refused now builds no session and takes no lock.
		this.admit(agentId, model, definition);
		const taken = takeProcessLock(botHostLockFile(agentDir, agentId), this.holder);
		if (!taken.held)
			throw new Error(
				words.botSessionHeld(
					agentId,
					taken.owner.pid,
					readRemoteBotHost(agentDir, agentId, this.holder)?.hostSessionId,
				),
			);
		const { lock } = taken;
		let session: AgentSession | undefined;
		let settings: ReturnType<BotSessionHostPorts["settings"]> | undefined;
		let built: BotSessionEntry | undefined;
		try {
			// The newest session file of the bot, whatever directory it worked in: a bot keeps one conversation.
			const newest = findMostRecentSessionInDirs([home.sessionsDir]);
			const sessionManager = newest
				? SessionManager.open(newest, agentDir, home.sessionsDir, cwd)
				: SessionManager.create(cwd, agentDir, home.sessionsDir);
			this.cancelOtherSessionsWatches(
				agentId,
				home.sessionsDir,
				sessionManager.getSessionId(),
				this.idleTimers().now(),
			);
			settings = this.ports.settings();
			const settingsManager = settings.settings;
			const ports = this.ports;
			// System One as the main session runs it now, read at each use: on or off, provider, transport.
			const systemOneHost: SystemOneHostSource = {
				get enabled() {
					return ports.systemOne().enabled;
				},
				get provider() {
					return ports.systemOne().provider;
				},
				get fetch() {
					return ports.systemOne().fetch;
				},
			};
			const registry = this.ports.modelRegistry();
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				installMissingPackages: false,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				// A profile's resources reach the bot's prompt as a worker's carries them.
				...(definition.resourceSystemPrompt
					? { appendSystemPromptOverride: (base: string[]) => [...base, definition.resourceSystemPrompt ?? ""] }
					: {}),
			});
			await resourceLoader.reload();
			session = (
				await createAgentSession({
					cwd,
					agentDir,
					pinnedModel: true,
					authStorage: registry.authStorage,
					modelRegistry: registry,
					settingsManager,
					resourceLoader,
					sessionManager,
					model,
					...(definition.thinkingLevel ? { thinkingLevel: definition.thinkingLevel } : {}),
					isChildSession: true,
					// It runs the watches it arms and takes their wakes as parent inputs (idle starts a turn, running steers).
					holdsOwnWatches: true,
					// Every run is admitted at its start, whatever opened it: a wake's turn is held to the owner's rules too.
					admitRun: () => this.admit(agentId, session?.model, definition),
					// System One as the main session runs it; its evidence stays in the bot's home.
					systemOneHost,
					systemOneEvidenceDir: botSystemOneEvidenceDir(agentDir, agentId),
					// Its own name, soul and memory block (its blackboard, which the store appends to after each turn) replace
					// the main agent's in the prompt, as a worker-path start opens on the same block.
					agentIdentity: namedAgentIdentity(
						profile.displayName,
						definition.soul,
						agentId,
						this.ports.store().composeBotUnifiedMemoryContext(agentId, undefined, undefined, "session")
							.promptBlock,
					),
					tools: [...definition.tools],
					privatePathScope: definition.privatePathScope,
					...(definition.capabilityEnvelope ? { capabilityEnvelope: definition.capabilityEnvelope } : {}),
					timers: this.ports.timers(),
					onClosingWarnings: (warnings) => {
						for (const warning of warnings) this.ports.warn(interfaceText().botTeam.botWarning(agentId, warning));
					},
				})
			).session;
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
				profileKey: definition.key,
				spendBoundUsd: definition.spendBoundUsd,
				unsubscribe: () => {},
				inFlight: 0,
				usageBefore: undefined,
				turnStartedAt: undefined,
				idleTimer: undefined,
			};
			built = entry;
			const unsubscribeSpend = boundSessionTurnSpend(session, {
				limit: () => this.spendBound(definition.spendBoundUsd),
				onExceeded: (spentUsd, limit) => {
					const reason = interfaceText().botTeam.botTurnOverBudget(
						agentId,
						spentUsd.toFixed(2),
						limit.usd.toFixed(2),
						limit.bound,
					);
					entry.sender.warn(reason);
					return reason;
				},
			});
			// Its tool loop is supervised as a worker's is: churn and System One's progress judgment, over its own turn.
			const supervision = new BotTurnSupervision(session, {
				agentId,
				role: definition.role,
				cwd,
				warn: (message) => entry.sender.warn(interfaceText().botTeam.botWarning(agentId, message)),
			});
			const unsubscribeEvents = session.subscribe((event) => {
				supervision.observe(event);
				// The session's own warnings (a turn a watch started that failed, say) reach the owner as the bot's.
				if (event.type === "warning") entry.sender.warn(interfaceText().botTeam.botWarning(agentId, event.message));
				if (event.type === "agent_start") {
					entry.usageBefore ??= structuredClone(entry.session.getCumulativeUsage());
					entry.turnStartedAt ??= Date.now();
				}
				if (event.type === "agent_end" && !event.willRetry) {
					this.reportTurnUsage(entry);
					this.recordOutcome(entry);
				}
				if (
					event.type === "agent_start" ||
					event.type === "agent_end" ||
					event.type === "queue_update" ||
					(event.type === "message_end" && event.message.role === "assistant")
				)
					this.settle(entry);
			});
			entry.unsubscribe = () => {
				unsubscribeSpend();
				unsubscribeEvents();
				supervision.stop();
			};
			session.startBackgroundInputs();
			this.entries.set(agentId, entry);
			this.publishState(entry);
			this.armIdle(entry);
			harnessLog.info("bots", "a bot session was loaded", () => ({ agentId, continued: newest !== null }));
			this.changed(agentId);
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
			throw error;
		}
	}

	/** After an event: a busy session is not idle, an idle one starts its bound. */
	private settle(entry: BotSessionEntry): void {
		if (this.entries.get(entry.agentId) !== entry) return;
		if (this.isBusy(entry)) this.touch(entry);
		else this.armIdle(entry);
		this.publishState(entry);
		this.changed(entry.agentId);
	}

	private touch(entry: BotSessionEntry): void {
		if (entry.idleTimer === undefined) return;
		this.idleTimers().clearTimeout(entry.idleTimer);
		entry.idleTimer = undefined;
	}

	private armIdle(entry: BotSessionEntry): void {
		this.touch(entry);
		if (this.stopped) return;
		entry.idleTimer = this.idleTimers().setTimeout(() => {
			entry.idleTimer = undefined;
			if (this.entries.get(entry.agentId) !== entry || this.isBusy(entry)) return;
			// Its watches are sampled and their wakes taken only while it is loaded: it stays until they are woken, end or are dropped.
			if (this.owesWatchWork(entry.session.sessionId)) return this.armIdle(entry);
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
		const sessionId = this.entries.get(agentId)?.session.sessionId ?? this.view.savedSessionOf(agentId)?.id;
		if (sessionId === undefined) return 0;
		const live = liveOwnWatches(this.ports.store(), sessionId, this.idleTimers().now());
		if (live.firstExpiresAt !== undefined) this.watchExpiry.note(agentId, live.firstExpiresAt);
		return live.count;
	}

	/**
	 * The invariant of the one place a bot's session id is chosen (`load`): the bot's watches target that id. A watch is held
	 * by the runtime of the session it targets, so a watch another session of the bot's home armed would be held by none
	 * once the bot continues another: such watches are cancelled here, and the owner told.
	 */
	private cancelOtherSessionsWatches(agentId: string, sessionsDir: string, sessionId: string, nowMs: number): void {
		const store = this.ports.store();
		const others = readdirSync(sessionsDir)
			.filter((name) => name.endsWith(".jsonl"))
			.flatMap((name) => readSessionHeader(join(sessionsDir, name))?.id ?? [])
			.filter((id) => id !== sessionId);
		let cancelled = 0;
		for (const other of others)
			for (const routine of store.listRoutines({ sessionId: other, scope: "own-watches" }))
				if (store.deleteRoutine(routine.routineId, undefined, nowMs)) cancelled++;
		if (cancelled > 0) this.ports.warn(interfaceText().botTeam.botWatchesCancelled(agentId, cancelled));
	}

	/**
	 * Whether the bot session `sessionId` has watch work, as the store says now: a live watch to sample, or a firing whose wake
	 * it has not yet taken (a one-shot that fired is no longer live, and its wake is delivered only by its own session).
	 */
	private owesWatchWork(sessionId: string): boolean {
		const store = this.ports.store();
		return (
			liveOwnWatches(store, sessionId, this.idleTimers().now()).count > 0 ||
			store.listPendingRoutineDeliveries(sessionId, 1).length > 0
		);
	}

	/**
	 * Opens the bot's session when its home's session holds live watches or a fired watch's wake not yet taken, and no process
	 * hosts it: a watch is sampled and its wake delivered only by its own session, so a process that starts, or a session
	 * rebuilt on a changed record, takes the waits and the wakes up again. Only a
	 * process working in the directory the session worked in takes it: a watch's relative path reads against that
	 * directory. Another process that opened it first is not a failure.
	 */
	private openIfWatching(agentId: string): void {
		const agentDir = this.ports.agentDir();
		if (this.stopped || this.entries.has(agentId) || readRemoteBotHost(agentDir, agentId, this.holder)) return;
		const saved = this.view.savedSessionOf(agentId);
		const record = this.ports.store().getBot(agentId);
		if (!saved?.cwd || !record || !this.runsAsSession(record) || !this.owesWatchWork(saved.id)) return;
		// A bot of its own works where the root it opens for works; a profile's, where its profile compiles to.
		let sender: BotSender | undefined;
		try {
			sender =
				record.profileId === undefined
					? this.ports.senderIn(saved.cwd)
					: this.define(record).cwd === saved.cwd
						? this.ports.sender()
						: undefined;
		} catch (error) {
			this.ports.warn(interfaceText().botTeam.botWatchesNotResumed(agentId, errorText(error)));
			return;
		}
		if (!sender) return;
		void this.open(agentId, sender).catch((error: unknown) => {
			if (!readRemoteBotHost(agentDir, agentId, this.holder))
				this.ports.warn(interfaceText().botTeam.botWatchesNotResumed(agentId, errorText(error)));
		});
	}

	/** Opens every bot whose own session has watch work that no process takes (see {@link openIfWatching}). */
	openWatching(): void {
		const bots = this.ports.store().listBots();
		if (bots.length === 0) return;
		this.view.watch();
		for (const bot of bots) this.openIfWatching(bot.agentId);
	}

	/** A turn ended: what the session spent since it began goes to the main session's cost view, once. */
	private reportTurnUsage(entry: BotSessionEntry): void {
		const { usageBefore, session } = entry;
		entry.usageBefore = undefined;
		const model = session.model;
		if (!usageBefore || !model) return;
		const usage = usageSince(usageBefore, session.getCumulativeUsage());
		if (!hasReportableUsage(usage)) return;
		const sessionId = session.sessionId;
		try {
			entry.sender.reportUsage(usage, {
				agentId: entry.agentId,
				// The turn's identity: the bot's session and what it had spent when the turn began.
				reportId: deriveSpawnedUsageReportId("bot-session", sessionId, [
					String(usageBefore.totalTokens),
					String(usageBefore.cost.total),
					String(session.messages.length),
				]),
				sessionId,
				provider: model.provider,
				model: model.id,
			});
		} catch (error) {
			entry.sender.warn(interfaceText().botTeam.botTurnSpendNotRecorded(entry.agentId, errorText(error)));
		}
	}

	/**
	 * A turn ended: its last words are the bot's summary in the roster, and its time marks the chat as unread. A turn that
	 * said nothing (it failed before an answer) records nothing: an earlier turn's answer is not news again.
	 */
	private recordOutcome(entry: BotSessionEntry): void {
		const since = entry.turnStartedAt;
		entry.turnStartedAt = undefined;
		if (this.stopped || since === undefined) return;
		const summary = lastAssistantText(entry.session.messages, since);
		if (summary.length === 0) return;
		try {
			this.ports.store().recordBotTurnOutcome({ agentId: entry.agentId, summary });
		} catch (error) {
			this.ports.warn(interfaceText().botTeam.botTurnOutcomeNotRecorded(entry.agentId, errorText(error)));
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
				// The aborted turn's spend is reported once, whether or not its end reached the subscription first.
				() => this.reportTurnUsage(entry),
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
	 * new record. A change of what defines the session while it works is refused, as it is for a worker. A record that left
	 * the session path (it became a leader's, a leader, or a profile only a worker's run holds) releases its session and
	 * the watches it armed: its messages now go to a worker, and two conversations of one bot never run side by side.
	 */
	recordChanged(record: PersistentBotRecord): void {
		const entry = this.entries.get(record.agentId);
		if (!entry && !this.hasHome(record.agentId)) return;
		ensureBotHome(this.ports.agentDir(), record);
		if (!this.runsAsSession(record)) {
			if (!entry || !this.isBusy(entry)) this.release(record.agentId);
			return;
		}
		if (entry && !this.isBusy(entry) && entry.profileKey !== this.currentKey(record))
			void this.close(record.agentId).then(
				() => this.openIfWatching(record.agentId),
				(error: unknown) =>
					this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(record.agentId, errorText(error))),
			);
	}

	/** What defines the bot's session now; undefined when its profile no longer admits it as one (it is refused when opened). */
	private currentKey(record: PersistentBotRecord): string | undefined {
		try {
			return this.keyOf(record);
		} catch {
			return undefined;
		}
	}

	private hasHome(agentId: string): boolean {
		return existsSync(botHomeOf(this.ports.agentDir(), agentId).profileFile);
	}

	/**
	 * Closes the bot's idle session (the bot was retired, or left the session path) and drops the watches its session armed:
	 * it is never woken there again, as a worker's watches go with the runtime that armed them. Refuses while it works.
	 */
	release(agentId: string): void {
		const entry = this.entries.get(agentId);
		if (entry && this.isBusy(entry)) throw new Error(interfaceText().botTeam.botHasActiveWork(agentId));
		const sessionId = entry?.session.sessionId ?? this.view.savedSessionOf(agentId)?.id;
		if (sessionId !== undefined) {
			const store = this.ports.store();
			const nowMs = this.idleTimers().now();
			for (const watch of store.listRoutines({ sessionId, scope: "own-watches" }))
				store.deleteRoutine(watch.routineId, watch.revision, nowMs);
		}
		if (!entry) return;
		void this.close(agentId).catch((error: unknown) =>
			this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(agentId, errorText(error))),
		);
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
			this.view.stop();
			this.watchExpiry.stop();
			this.listeners.clear();
			await this.history.stop();
		}
	}
}
