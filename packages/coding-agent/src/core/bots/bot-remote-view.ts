/**
 * What a bot session host reads of the bots it does not run: the host that runs one elsewhere (another process, or
 * another host in this one) and the state it publishes, the bot's saved session, and the conversation its home holds.
 * One watch over the bot homes keeps these fresh and tells the host when a bot changed; while no watch runs, each read
 * goes to disk. The host that runs a bot answers for it from memory and never asks here.
 */
import { statSync } from "node:fs";
import { getSessionHeaderCwd, readSessionHeader } from "../../kernel/session/session-file-reading.ts";
import { findMostRecentSessionInDirs } from "../../kernel/session/session-listing.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { botHomeName } from "../agent-paths.ts";
import type { PersistentBotTeamStore } from "../delegation/persistent-bot-team-store.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { botHomeOf } from "./bot-home.ts";
import { watchBotHomes } from "./bot-home-watch.ts";
import { type RemoteBotHost, readRemoteBotHost } from "./bot-host-state.ts";

/** How long a remote bot's running or queued state stands before its host is judged again (a killed host publishes nothing). */
const REMOTE_RECHECK_MS = 30 * 1000;

/** The bot's own session as its home saved it: its id and the directory it worked in. */
export type SavedBotSession = { readonly id: string; readonly cwd?: string };

/**
 * The bot's own session as its home holds it: the newest session file, the one its next session continues, with the
 * directory it works in; undefined while it has none. Another process reads the bot's watches by its id, since they
 * target it.
 */
export function botSessionOnDisk(agentDir: string, agentId: string): SavedBotSession | undefined {
	const file = findMostRecentSessionInDirs([botHomeOf(agentDir, agentId).sessionsDir]);
	const header = file ? readSessionHeader(file) : null;
	return header ? { id: header.id, cwd: getSessionHeaderCwd(header) } : undefined;
}

/** Whether a remote host says the bot is working: running a turn or holding queued input. */
export function remoteHostActive(host: RemoteBotHost | undefined): host is RemoteBotHost {
	return host?.state === "running" || host?.state === "queued";
}

export interface BotRemoteViewPorts {
	agentDir(): string;
	store(): PersistentBotTeamStore;
	timers(): TimerPort;
	warn(message: string): void;
	/** Whether the host runs the bot itself: the changes its own session writes are not news. */
	runsLocally(agentId: string): boolean;
	/** Another host's hold on the bot changed (taken, given back, its state published). */
	hostChanged(agentId: string): void;
	/** Bots whose remote state, saved session or conversation changed. */
	changed(agentIds: readonly string[]): void;
}

export class BotRemoteView {
	private readonly ports: BotRemoteViewPorts;
	/** The host this view reads for: a hold that names it is its own, never another's. */
	private readonly holder: string;
	/** What each bot's other host last said, kept while the home watch keeps it fresh. */
	private readonly remote = new Map<string, RemoteBotHost | undefined>();
	/** Each bot's own session as its home holds it (`botSessionOnDisk`), kept while the home watch keeps it fresh. */
	private readonly saved = new Map<string, SavedBotSession | undefined>();
	/** The conversation of the one bot whose chat was read last, with the file state it was read at. */
	private transcriptCache:
		| { agentId: string; file: string; mtimeMs: number; size: number; messages: AgentMessage[] }
		| undefined;
	private homeWatch: (() => void) | undefined;
	/** The home watch failed: other hosts' changes are read from disk each time instead. */
	private homeWatchFailed = false;
	private recheck: unknown;
	private stopped = false;

	constructor(ports: BotRemoteViewPorts, holder: string) {
		this.ports = ports;
		this.holder = holder;
	}

	/** Starts the one watch over the bot homes, when a roster or a chat first reads a bot this host does not run. */
	watch(): void {
		if (this.homeWatch || this.homeWatchFailed || this.stopped) return;
		const failed = (reason: string) => {
			this.homeWatch = undefined;
			this.homeWatchFailed = true;
			this.remote.clear();
			this.saved.clear();
			this.ports.warn(interfaceText().botTeam.botHomesNotWatched(reason));
		};
		try {
			this.homeWatch = watchBotHomes(
				this.ports.agentDir(),
				(changes) => {
					const ids = new Map(
						this.ports
							.store()
							.listBots({ includeRetired: true })
							.map((bot) => [botHomeName(bot.agentId), bot.agentId]),
					);
					const changed = new Set<string>();
					// A home's session files changed: what it saved is read again, before a host's change below opens it.
					for (const { home, file } of changes) {
						const agentId = ids.get(home);
						if (agentId !== undefined && file.startsWith("sessions/")) this.saved.delete(agentId);
					}
					for (const { home, file } of changes) {
						const agentId = ids.get(home);
						if (agentId === undefined) continue;
						const hostFile = file === "host-state.json" || file === "host.lock";
						// The host's own bot sessions announce themselves; a change it wrote is not news.
						if (this.ports.runsLocally(agentId) && (hostFile || file.startsWith("sessions/"))) continue;
						if (hostFile) {
							this.remote.delete(agentId);
							this.ports.hostChanged(agentId);
						}
						changed.add(agentId);
					}
					if (changed.size > 0) this.ports.changed([...changed]);
				},
				(error) => failed(error.message),
			);
		} catch (error) {
			failed(error instanceof Error ? error.message : String(error));
		}
	}

	/** The host other than this one that runs the bot's session, as its home says now. */
	hostOf(agentId: string): RemoteBotHost | undefined {
		this.watch();
		if (!this.homeWatch) return readRemoteBotHost(this.ports.agentDir(), agentId, this.holder);
		if (this.remote.has(agentId)) return this.remote.get(agentId);
		const host = readRemoteBotHost(this.ports.agentDir(), agentId, this.holder);
		this.remote.set(agentId, host);
		this.armRecheck();
		return host;
	}

	/** The bot's own session as its home holds it now (see {@link botSessionOnDisk}). */
	savedSessionOf(agentId: string): SavedBotSession | undefined {
		this.watch();
		if (!this.homeWatch) return botSessionOnDisk(this.ports.agentDir(), agentId);
		if (!this.saved.has(agentId)) this.saved.set(agentId, botSessionOnDisk(this.ports.agentDir(), agentId));
		return this.saved.get(agentId);
	}

	/**
	 * The conversation the bot's home holds: its newest session file, read without opening it for writing, and read
	 * again only once the file changed. Undefined when the bot has no session of its own yet.
	 */
	readMessages(agentId: string): AgentMessage[] | undefined {
		this.watch();
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

	/** A host that is working but was killed publishes nothing: while one is cached as working, its lock is judged again. */
	private armRecheck(): void {
		if (this.recheck !== undefined || this.stopped) return;
		if (![...this.remote.values()].some(remoteHostActive)) return;
		this.recheck = this.ports.timers().setTimeout(() => {
			this.recheck = undefined;
			const changed: string[] = [];
			for (const [agentId, host] of [...this.remote]) {
				if (!remoteHostActive(host)) continue;
				const now = readRemoteBotHost(this.ports.agentDir(), agentId, this.holder);
				this.remote.set(agentId, now);
				if (now?.state !== host?.state) changed.push(agentId);
			}
			if (changed.length > 0) this.ports.changed(changed);
			this.armRecheck();
		}, REMOTE_RECHECK_MS);
	}

	/** Ends the watch and the recheck, and drops what was read. After it the view watches nothing again. */
	stop(): void {
		this.stopped = true;
		this.homeWatch?.();
		this.homeWatch = undefined;
		if (this.recheck !== undefined) this.ports.timers().clearTimeout(this.recheck);
		this.recheck = undefined;
		this.remote.clear();
		this.saved.clear();
		this.transcriptCache = undefined;
	}
}
