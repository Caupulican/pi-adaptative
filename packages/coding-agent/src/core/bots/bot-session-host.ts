/**
 * Hosts each bot as an `AgentSession` of its own, in this process: one session per bot, created on its first message
 * (`createAgentSession`, as the daemon's channel sessions are), continued from the newest file of the bot's own
 * `sessions/` directory (one conversation per bot, whatever the working directory), kept while a turn runs or input is
 * queued, and closed after `BOT_SESSION_IDLE_BOUND_MS` of idleness or when the host stops.
 *
 * The session runs on the bot's own model, which is never replaced: a model that is missing, has no credentials, or that
 * the worker admission refuses (a metered model the owner did not choose, one the owner's model policy disallows) refuses
 * the message. The bot has an identity of its own: its name and its soul replace the main agent's in the system prompt
 * (the soul is judged again here because a stored record can have been edited by hand). It works in the owner's project
 * directory under a worker's private-path scope. It is a child session (no routines, no memory writes, no channels), it
 * runs System One as the owner's settings have it, and its tools are the read tools plus a shell, plus the file tools
 * and python when the record grants `canWrite`; a read-only bot's shell runs only commands the read-only shell line
 * admits. Each turn is bounded by the worker spend bound and its usage is reported to the main session's cost view.
 * Autonomy (subagents, routines, goals, watches) belongs to a later phase.
 *
 * One process hosts a bot's session at a time (`bots/<id>/host.lock`): a second process is refused with the holder's id
 * rather than appending to the same file. A change of the bot's record rebuilds an idle session on the next message
 * and is refused while a turn runs. A finished turn records its outcome in the store as a worker's did, so the roster's
 * unread mark and summary keep working. This host only reads and writes the bot's own home and session.
 */

import { existsSync, statSync } from "node:fs";
import { type Api, type Model, TOOL_SCHEMA_SEARCH_NAME, type Usage } from "@caupulican/pi-ai";
import { harnessLog } from "../../kernel/harness-log.ts";
import { findMostRecentSessionInDirs } from "../../kernel/session/session-listing.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { checkSoulText, namedAgentIdentity } from "../agent-identity.ts";
import { botHostLockFile } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import { boundSessionTurnSpend, unpricedModelRefusal } from "../cost/session-turn-spend-bound.ts";
import { usageSince } from "../cost/usage-delta.ts";
import { STABLE_SHELL_TOOL_NAME } from "../default-tool-surface.ts";
import type { BotOperatorMessageOptions } from "../delegation/bot-operator-message-options.ts";
import type {
	BotOperatorMessageDispatchResult,
	PersistentBotRecord,
	PersistentBotTeamStore,
} from "../delegation/persistent-bot-team-store.ts";
import { READ_TOOL_NAMES, REPO_READ_TOOL_NAME, WRITE_TOOL_NAMES } from "../delegation/worker-execution-policy.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { isOrchestrationThinkingLevel } from "../orchestration/thinking-level-guard.ts";
import { type HostLock, takeProcessLock } from "../remote/host-lock.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { createAgentSession } from "../sdk.ts";
import { SettingsManager } from "../settings-manager.ts";
import { deriveSpawnedUsageReportId, hasReportableUsage } from "../spawned-usage.ts";
import { toolSurvivesReadOnly } from "../tool-capability-policy.ts";
import { LOOKUP_TOOL_NAME } from "../tools/lookup-tool-name.ts";
import type { TimerPort, TimerSource } from "../util/timer-port.ts";
import { botHomeOf, botProfileOf, ensureBotHome } from "./bot-home.ts";

/** How long a bot's session stays loaded with no turn running and no input queued. */
export const BOT_SESSION_IDLE_BOUND_MS = 10 * 60 * 1000;

/** What a loaded bot session is doing; a bot with no loaded session has no state here. */
export type BotSessionState = "running" | "queued" | "idle";

/** What the host reads from and asks of the coordinator. */
export interface BotSessionHostPorts {
	agentDir(): string;
	/** The owner's project directory: a bot works there. */
	cwd(): string;
	store(): PersistentBotTeamStore;
	modelRegistry(): ModelRegistry;
	/** Whether the owner trusts the project's own settings, as the root session does. */
	projectTrusted(): boolean;
	timers(): TimerSource;
	/** An owner-facing warning (a turn that failed, a session that did not close cleanly). */
	warn(message: string): void;
	/** Why the worker admission refuses the bot's model now; undefined when it may run. */
	modelRefusal(record: PersistentBotRecord, model: Model<Api>): string | undefined;
	/** The dollars one turn may spend, as a worker's budget bounds it; undefined when nothing bounds it. */
	turnSpendBoundUsd(): number | undefined;
	/** Records what a bot's turn spent with the main session's cost view, once per `reportId`. */
	reportUsage(usage: Usage, report: BotTurnUsageReport): void;
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
	readonly modelRef: string;
	/** The record's defining fields as the session was built from them. */
	readonly profileKey: string;
	unsubscribe: () => void;
	/** Prompts submitted and not yet settled. */
	inFlight: number;
	/** The session's cumulative usage when the running turn began; absent between turns. */
	usageBefore: Usage | undefined;
	idleTimer: unknown;
}

/** The tools of a bot session: the read tools always, the file and process tools only when the bot may write. */
export function botSessionToolNames(canWrite: boolean): string[] {
	const reads = [...READ_TOOL_NAMES, REPO_READ_TOOL_NAME, LOOKUP_TOOL_NAME];
	// A read-only bot keeps what a read-only worker keeps: the shell is judged command by command (`privatePathScope.readOnlyShell`).
	return canWrite
		? [...reads, TOOL_SCHEMA_SEARCH_NAME, ...WRITE_TOOL_NAMES, "python", STABLE_SHELL_TOOL_NAME]
		: [...[...reads, STABLE_SHELL_TOOL_NAME].filter(toolSurvivesReadOnly), TOOL_SCHEMA_SEARCH_NAME];
}

/** What defines a session: the fields a session is built from. A rename or a new description leaves it as it is. */
function profileKeyOf(record: PersistentBotRecord): string {
	const { provider, modelId, thinkingLevel, soul, canWrite } = botProfileOf(record);
	return JSON.stringify([provider, modelId, thinkingLevel, soul, canWrite]);
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The words of the newest assistant message that has any: the turn's outcome. */
function lastAssistantText(messages: readonly AgentMessage[]): string {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
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
	private readonly entries = new Map<string, BotSessionEntry>();
	/** Sessions being built, so two messages in a row build one. */
	private readonly loading = new Map<string, Promise<BotSessionEntry>>();
	/** Sessions being closed: the next one of that bot opens once the file and the lock are free. */
	private readonly closing = new Map<string, Promise<void>>();
	private readonly listeners = new Set<(change: readonly string[]) => void>();
	/** The transcript of the one bot whose chat was read last while it had no loaded session. */
	private transcriptCache:
		| { agentId: string; file: string; mtimeMs: number; size: number; messages: AgentMessage[] }
		| undefined;
	private stopped = false;

	constructor(ports: BotSessionHostPorts) {
		this.ports = ports;
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
		for (const listener of [...this.listeners]) listener([agentId]);
	}

	private isRunning(entry: BotSessionEntry): boolean {
		return entry.inFlight > 0 || entry.session.getSessionWorkState().busy;
	}

	private isBusy(entry: BotSessionEntry): boolean {
		return this.isRunning(entry) || entry.session.deliverablePendingMessageCount > 0;
	}

	/** The state of the bot's loaded session; undefined when it has none. */
	stateOf(agentId: string): BotSessionState | undefined {
		const entry = this.entries.get(agentId);
		if (!entry) return undefined;
		if (this.isRunning(entry)) return "running";
		return entry.session.deliverablePendingMessageCount > 0 ? "queued" : "idle";
	}

	/** Whether the bot's session is running a turn or holds queued input. */
	isActive(agentId: string): boolean {
		const entry = this.entries.get(agentId);
		return entry !== undefined && this.isBusy(entry);
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
	): Promise<BotOperatorMessageDispatchResult> {
		const entry = await this.open(agentId);
		this.admit(entry);
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
					if (wasAccepted) this.ports.warn(interfaceText().botTeam.botTurnFailed(agentId, errorText(error)));
					else accept(false, errorText(error));
				},
			)
			.finally(() => {
				entry.inFlight--;
				this.settle(entry);
			});
		const outcome = await accepted;
		if (!outcome.accepted)
			throw new Error(interfaceText().botTeam.botMessageRefused(agentId, outcome.reason ?? "not accepted"));
		return {
			agentId,
			mode: wasRunning ? (queued ? "queued" : "steered") : queued ? "queued" : continued ? "followed_up" : "started",
			messageId: `bot-msg-${Date.now()}`,
			modelRef: entry.modelRef,
		};
	}

	/**
	 * Whether the session's model may run this message now: the worker admission's rules for an explicitly requested model
	 * (read again each message, since the owner's policy changes), and a model that declares a price when a bound applies.
	 */
	private admit(entry: BotSessionEntry): void {
		const record = this.ports.store().getBot(entry.agentId);
		const { model } = entry.session;
		const words = interfaceText().botTeam;
		if (!record || !model) throw new Error(words.botMissing(entry.agentId));
		const refusal =
			this.ports.modelRefusal(record, model) ??
			(this.ports.turnSpendBoundUsd() === undefined ? undefined : unpricedModelRefusal(model));
		if (refusal) throw new Error(words.botModelRefused(entry.agentId, refusal));
	}

	/** The bot's loaded session, built or continued as the record defines it. */
	private async open(agentId: string): Promise<BotSessionEntry> {
		const stopped = () => new Error(interfaceText().botTeam.botSessionsClosing(agentId));
		if (this.stopped) throw stopped();
		await this.closing.get(agentId);
		// A stop that came while the previous session closed has already counted the sessions it must close: none is built now.
		if (this.stopped) throw stopped();
		const record = this.ports.store().getBot(agentId);
		if (!record || record.retired) throw new Error(interfaceText().botTeam.botMissing(agentId));
		const existing = this.entries.get(agentId);
		if (existing) {
			// A record changed since the session was built (by another process, say): an idle session is rebuilt on it.
			if (existing.profileKey === profileKeyOf(record) || this.isBusy(existing)) return existing;
			await this.close(agentId);
			return this.open(agentId);
		}
		const pending = this.loading.get(agentId);
		if (pending) return pending;
		const built = this.load(record).finally(() => this.loading.delete(agentId));
		this.loading.set(agentId, built);
		return built;
	}

	private async load(record: PersistentBotRecord): Promise<BotSessionEntry> {
		const agentDir = this.ports.agentDir();
		const { agentId } = record;
		const words = interfaceText().botTeam;
		const { home, profile } = ensureBotHome(agentDir, record);
		const model = this.ports.modelRegistry().find(profile.provider, profile.modelId);
		if (!model || !this.ports.modelRegistry().hasConfiguredAuth(model))
			throw new Error(words.botModelUnavailable(agentId, `${profile.provider}/${profile.modelId}`));
		const soul = profile.soul === undefined ? { ok: true as const, soul: undefined } : checkSoulText(profile.soul);
		if (!soul.ok) throw new Error(words.botSoulRefused(agentId, soul.reason));
		const taken = takeProcessLock(botHostLockFile(agentDir, agentId));
		if (!taken.held) throw new Error(words.botSessionHeld(agentId, taken.owner.pid));
		const { lock } = taken;
		let session: AgentSession | undefined;
		try {
			const cwd = this.ports.cwd();
			// The newest session file of the bot, whatever directory it worked in: a bot keeps one conversation.
			const newest = findMostRecentSessionInDirs([home.sessionsDir]);
			const sessionManager = newest
				? SessionManager.open(newest, agentDir, home.sessionsDir, cwd)
				: SessionManager.create(cwd, agentDir, home.sessionsDir);
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: this.ports.projectTrusted() });
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
			});
			await resourceLoader.reload();
			session = (
				await createAgentSession({
					cwd,
					agentDir,
					authStorage: registry.authStorage,
					modelRegistry: registry,
					settingsManager,
					resourceLoader,
					sessionManager,
					model,
					...(isOrchestrationThinkingLevel(profile.thinkingLevel) ? { thinkingLevel: profile.thinkingLevel } : {}),
					isChildSession: true,
					// Its own name and soul replace the main agent's in the prompt.
					agentIdentity: namedAgentIdentity(profile.displayName, soul.soul, agentId),
					tools: botSessionToolNames(profile.canWrite),
					privatePathScope: { readOnlyShell: !profile.canWrite },
					timers: this.ports.timers(),
					onClosingWarnings: (warnings) => {
						for (const warning of warnings) this.ports.warn(`Bot ${agentId}: ${warning}`);
					},
				})
			).session;
			const entry: BotSessionEntry = {
				agentId,
				session,
				lock,
				modelRef: `${profile.provider}/${profile.modelId}`,
				profileKey: profileKeyOf(record),
				unsubscribe: () => {},
				inFlight: 0,
				usageBefore: undefined,
				idleTimer: undefined,
			};
			const unsubscribeSpend = boundSessionTurnSpend(session, {
				limitUsd: () => this.ports.turnSpendBoundUsd(),
				onExceeded: (spentUsd, limitUsd) => {
					const reason = interfaceText().botTeam.botTurnOverBudget(
						agentId,
						spentUsd.toFixed(2),
						limitUsd.toFixed(2),
					);
					this.ports.warn(reason);
					return reason;
				},
			});
			const unsubscribeEvents = session.subscribe((event) => {
				if (event.type === "agent_start") entry.usageBefore ??= structuredClone(entry.session.getCumulativeUsage());
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
			};
			this.entries.set(agentId, entry);
			this.armIdle(entry);
			harnessLog.info("bots", "a bot session was loaded", () => ({ agentId, continued: newest !== null }));
			this.changed(agentId);
			return entry;
		} catch (error) {
			if (session) await session.disposeAndWait().catch(() => undefined);
			lock.release();
			throw error;
		}
	}

	/** After an event: a busy session is not idle, an idle one starts its bound. */
	private settle(entry: BotSessionEntry): void {
		if (this.entries.get(entry.agentId) !== entry) return;
		if (this.isBusy(entry)) this.touch(entry);
		else this.armIdle(entry);
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
			if (this.entries.get(entry.agentId) !== entry) return;
			if (this.isBusy(entry)) return;
			void this.close(entry.agentId).catch((error: unknown) =>
				this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(entry.agentId, errorText(error))),
			);
		}, BOT_SESSION_IDLE_BOUND_MS);
	}

	/** A turn ended: what the session spent since it began goes to the main session's cost view, once. */
	private reportTurnUsage(entry: BotSessionEntry): void {
		const { usageBefore, session } = entry;
		entry.usageBefore = undefined;
		const model = session.model;
		if (this.stopped || !usageBefore || !model) return;
		const usage = usageSince(usageBefore, session.getCumulativeUsage());
		if (!hasReportableUsage(usage)) return;
		const sessionId = session.sessionId;
		try {
			this.ports.reportUsage(usage, {
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
			this.ports.warn(`Bot ${entry.agentId}: its turn's spend could not be recorded (${errorText(error)}).`);
		}
	}

	/** A turn ended: its last words are the bot's summary in the roster, and its time marks the chat as unread. */
	private recordOutcome(entry: BotSessionEntry): void {
		if (this.stopped) return;
		const summary = lastAssistantText(entry.session.messages);
		if (summary.length === 0) return;
		try {
			this.ports.store().recordBotTurnOutcome({ agentId: entry.agentId, summary });
		} catch (error) {
			this.ports.warn(`Bot ${entry.agentId}: its turn outcome could not be recorded (${errorText(error)}).`);
		}
	}

	/** Closes the bot's session and gives its lock back; the next message builds a new one. */
	private close(agentId: string): Promise<void> {
		const entry = this.entries.get(agentId);
		const previous = this.closing.get(agentId);
		if (!entry) return previous ?? Promise.resolve();
		this.entries.delete(agentId);
		this.touch(entry);
		const closing = (async () => {
			try {
				await entry.session.abort("bot session closing");
				entry.unsubscribe();
				await entry.session.disposeAndWait();
			} finally {
				entry.lock.release();
				this.changed(agentId);
			}
		})().finally(() => {
			if (this.closing.get(agentId) === closing) this.closing.delete(agentId);
		});
		this.closing.set(agentId, closing);
		return closing;
	}

	/**
	 * Stops the turn the bot's session is running. Returns whether there was one: the session settles the stop itself, and
	 * a failure to stop reaches the owner as a warning.
	 */
	interrupt(agentId: string): boolean {
		const entry = this.entries.get(agentId);
		if (!entry || !this.isBusy(entry)) return false;
		void entry.session
			.abort("bot stopped by the owner")
			.catch((error: unknown) => this.ports.warn(interfaceText().botTeam.botTurnFailed(agentId, errorText(error))));
		return true;
	}

	/**
	 * The bot's record changed: its profile follows it, and an idle session is closed so the next message builds one on the
	 * new record. A change of what defines the session while it works is refused, as it is for a worker.
	 */
	recordChanged(record: PersistentBotRecord): void {
		const entry = this.entries.get(record.agentId);
		if (!entry && !this.hasHome(record.agentId)) return;
		ensureBotHome(this.ports.agentDir(), record);
		if (entry && entry.profileKey !== profileKeyOf(record) && !this.isBusy(entry))
			void this.close(record.agentId).catch((error: unknown) =>
				this.ports.warn(interfaceText().botTeam.botSessionCloseFailed(record.agentId, errorText(error))),
			);
	}

	private hasHome(agentId: string): boolean {
		return existsSync(botHomeOf(this.ports.agentDir(), agentId).profileFile);
	}

	/** Closes the bot's idle session (the bot was retired). Refuses while it works. */
	release(agentId: string): void {
		const entry = this.entries.get(agentId);
		if (!entry) return;
		if (this.isBusy(entry)) throw new Error(interfaceText().botTeam.botHasActiveWork(agentId));
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
		if (entry) return [...entry.session.messages];
		const agentDir = this.ports.agentDir();
		const file = findMostRecentSessionInDirs([botHomeOf(agentDir, agentId).sessionsDir]);
		if (!file) return undefined;
		const stat = statSync(file);
		const cached = this.transcriptCache;
		if (
			cached?.agentId === agentId &&
			cached.file === file &&
			cached.mtimeMs === stat.mtimeMs &&
			cached.size === stat.size
		)
			return [...cached.messages];
		const messages = SessionManager.openReadOnly(file, agentDir).buildSessionContext().messages;
		this.transcriptCache = { agentId, file, mtimeMs: stat.mtimeMs, size: stat.size, messages };
		return [...messages];
	}

	/** Closes every session and gives the locks back. After it no session is built. */
	async stop(): Promise<void> {
		this.stopped = true;
		await Promise.allSettled([...this.loading.values()]);
		const failures: unknown[] = [];
		for (const agentId of [...this.entries.keys()]) {
			try {
				await this.close(agentId);
			} catch (error) {
				failures.push(error);
			}
		}
		await Promise.all([...this.closing.values()]);
		this.listeners.clear();
		this.transcriptCache = undefined;
		if (failures.length > 0) throw new AggregateError(failures, "Bot sessions did not close cleanly.");
	}
}
