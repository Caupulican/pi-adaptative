/**
 * The daemon's channels while no session is open: one headless session per channel whose global policy names
 * `channels.<name>.awayCwd`, in that directory, serving the channel through the same `SessionChannels` an open session
 * runs. One session per channel keeps each channel's turns, spend and stop its own.
 *
 * The session reads and reports, as every run away does: it is a child session (no memory, no routines, no proactive
 * work, no owner decisions), System One is off, and its tools are read-only and reach only its working directory, never
 * the agent directory or the private paths every lane is denied (`privatePathScope`). A channel's message is a third party's
 * words there exactly as in an open session: the origin gate applies, and the reply waits as a draft unless the owner
 * set `replyMode: "auto"`. Its drafts, the messages it dropped or held and the conversations it left unanswered wait
 * in the journal for the first session that takes the channel, which tells the owner of them once.
 *
 * A channel that carries the owner's words (`ownerSenders` on Telegram or Slack) also gets the owner's persistent phone
 * session next to the child session (`openOwnerSession`): the same `SessionChannels` hands the owner's batches to it and
 * everything else to the child. Without `ownerSenders` no phone session, file or lease exists.
 *
 * An open session takes a channel over at once (`SessionChannels.takeHold`); this host stops its provider, and a turn
 * it was running ends as a draft. When the session gives the channel up, the journal's change wakes this host
 * (a watch on the journal directory, and the daemon's tick for a session whose process ended), which takes it back.
 * Closing a host (the daemon stops, or the channel's settings no longer name it or name another directory) stops its
 * turn first, then settles the turns it accepted: an answer becomes a draft, any other outcome is unanswered with
 * what the turn spent.
 *
 * Every turn is bounded twice: by the channel's own daily bounds and by the away spend bound the daemon's routines run
 * under (`routines.away.maxUsdPerRun` per turn, `routines.away.maxUsdPerDay` across both). A turn on a subscription
 * reserves nothing on the away bound until its session fails over to a metered model: that move reserves the turn first,
 * as a run away's does, and is held off metered models while the day has no room (`meteredMoves`). A host that cannot serve
 * (no priced model, no provider) leaves the messages with their transport; it is tried again after a backoff from one
 * minute to one hour, and at the daemon's next tick after the owner's credentials or the directory's model settings
 * change.
 */

import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { harnessLog } from "../../kernel/harness-log.ts";
import { readSessionHeaderResult } from "../../kernel/session/session-header.ts";
import { SessionManager } from "../../kernel/session/session-manager.ts";
import { safeErrorMessage } from "../../kernel/types.ts";
import { channelsDir } from "../agent-paths.ts";
import type { AgentSession } from "../agent-session.ts";
import type { MeteredMoveGate } from "../agent-session-model-access.ts";
import type { AuthStorage } from "../auth-storage.ts";
import { boundSessionTurnSpend, turnSpendExcess, unpricedModelRefusal } from "../cost/session-turn-spend-bound.ts";
import type { MachineFacts } from "../fleet/capacity/machine-room.ts";
import type { ChannelProvider } from "../gateways/channel-provider.ts";
import { interfaceText } from "../language/interface-text.ts";
import type { ModelRegistry } from "../model-registry.ts";
import { isMeteredSpend } from "../orchestration/risk-budget.ts";
import {
	ownerOrchestrationHome,
	ownerSessionStorageRoots,
	readSessionLeaseHolders,
	SessionHeldError,
	sessionLeaseHolderRef,
} from "../orchestration/session-bundle-lifecycle.ts";
import { isProcessAlive } from "../process-liveness.ts";
import { isEmergencyStopEngaged, subscribeEmergencyStop } from "../provider-admission/emergency-stop.ts";
import { DefaultResourceLoader } from "../resource-loader.ts";
import { awayMeteredRunReserved, reserveAwayChannelTurns } from "../routines/away-metered-runs.ts";
import { awayRunMetered } from "../routines/away-routine-admission.ts";
import { type RoutineAwayChargesRead, routineAwaySpendRoom } from "../routines/routine-away-spend.ts";
import type { RoutineOccurrence } from "../routines/routine-contract.ts";
import { type CreateAgentSessionOptions, createAgentSession } from "../sdk.ts";
import { SettingsManager } from "../settings-manager.ts";
import type { TimerSource } from "../util/timer-port.ts";
import {
	type AwayChannel,
	type AwaySubscriptionTurns,
	awayChannels,
	failureCause,
	reserveAwayChannelOffers,
	unreservedSubscriptionTurns,
} from "./away-channels.ts";
import { ChannelJournal } from "./channel-journal.ts";
import { isOwnerChannelName, type ResolvedChannelPolicy } from "./channel-policy.ts";
import { JournalDirWatch } from "./journal-dir-watch.ts";
import type { Worded } from "./owner-notice-text.ts";
import { SessionChannels } from "./session-channels.ts";

/** The tools a channel turn away may call: it reads the working directory and answers. */
const AWAY_CHANNEL_TOOLS = ["read", "grep", "find", "ls"];
/** The first wait before a refused host is opened again; each refusal doubles it up to `REFUSAL_RETRY_MAX_MS`. */
const REFUSAL_RETRY_MIN_MS = 60 * 1000;
const REFUSAL_RETRY_MAX_MS = 60 * 60 * 1000;
/** Notice states a host remembers so it reports each once; past it the oldest is forgotten. */
const MAX_HOST_NOTICES = 256;

/** Whether `child` is `parent` or inside it. */
function isWithin(parent: string, child: string): boolean {
	const rel = relative(resolve(parent), resolve(child));
	return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Whether the channel can carry the owner's words: they run in the daemon's phone session, not the child session. */
function ownerWanted({ name, policy }: AwayChannel): boolean {
	return policy.ownerSenders.length > 0 && isOwnerChannelName(name);
}

/**
 * The model refusal of a session whose spend is bounded; undefined when it can run. A metered model that declares no
 * price cannot be held to the dollar bound; a subscription model is held by its usage windows, so none refuses it.
 */
function modelRefusal(session: AgentSession): string | undefined {
	const model = session.model;
	if (!model) return "no model is configured";
	return isMeteredSpend(model, session.modelRegistry) ? unpricedModelRefusal(model) : undefined;
}

/** The transport of a channel the daemon serves; undefined when it has none for that name. */
export type AwayChannelProviderFactory = (
	channel: string,
	policy: ResolvedChannelPolicy,
	deps: { readonly agentDir: string; readonly warn: (message: string) => void },
) => ChannelProvider | undefined;

export interface AwayChannelHostsInput {
	readonly agentDir: string;
	/** The daemon's global-only settings, reloaded by its tick: the channel policies and the away bounds. */
	readonly settings: SettingsManager;
	readonly timers: TimerSource;
	/** The machine facts the channel sessions' fleets read (memory and heap); absent reads the real machine. */
	readonly machineFacts?: () => MachineFacts;
	readonly providers: AwayChannelProviderFactory;
	/** The routine runs away charged on the same bound. */
	routineOccurrences(): Iterable<RoutineOccurrence>;
	/** What else is charged to the same bound now: every channel's turns away and the bots' spend (`readAwayCharges`). */
	otherAwayCharges(nowMs: number): RoutineAwayChargesRead;
	readonly authStorage?: AuthStorage;
	readonly modelRegistry?: ModelRegistry;
	/** Diagnostics; this host reports each cause once until it clears. */
	report(message: string): void;
}

/** How the daemon's reports name the warnings of a channel's child session and of its phone session. */
const awaySessionSource = (name: string): string => `Channel ${name} away`;
const phoneSessionSource = (name: string): string => `Channel ${name} phone session`;

/** One channel's headless session. */
interface AwayChannelHost {
	readonly name: string;
	readonly cwd: string;
	readonly session: AgentSession;
	readonly channels: SessionChannels;
	/** Whether the channel's transport is registered with the session. */
	registered: boolean;
	readonly unsubscribe: () => void;
	/** Who held the channel when last read: a change is what starts or stops its provider. */
	holder: string;
	/** Whether the channel carried the owner's words when the host opened; a change reopens it. */
	readonly ownerWanted: boolean;
	/** The phone session the owner's turns run in, while the channel carries them. */
	readonly owner: AwayOwnerSession | undefined;
}

/** The owner's persistent phone session, held as `channel-host`: the only open holder of that session. */
interface AwayOwnerSession {
	readonly session: AgentSession;
	readonly sessionManager: SessionManager;
	/** Stops the wait that records a new session in the journal once its file exists. */
	readonly unrecorded: () => void;
}

/** Why a channel's host was refused, what it was refused under, and when it is tried again regardless. */
interface Refusal {
	readonly stamp: string;
	readonly retryAt: number;
	readonly delayMs: number;
}

export class AwayChannelHosts {
	private readonly input: AwayChannelHostsInput;
	/** By channel name. */
	private readonly hosts = new Map<string, AwayChannelHost>();
	/** Channels whose host is being opened, so a sync during the open opens none twice; a close joins them. */
	private readonly opening = new Map<string, Promise<void>>();
	/** Channels whose previous host is still closing: the next one opens once it gave the channel back. */
	private readonly closing = new Map<string, Promise<void>>();
	private readonly refused = new Map<string, Refusal>();
	/** The message last reported per cause; a cause that clears is reported again when it recurs. */
	private readonly reported = new Map<string, string>();
	/** The owner's credential files as the daemon last read them: a change is worth opening a refused host again. */
	private credentialStamp = "";
	/**
	 * The watch on the journal directory: a change re-reads who holds each host's channel, and sends a notice another
	 * session left for the owner on a channel a host serves. A watch that cannot open, or fails later, leaves the daemon's
	 * tick, which re-reads the holders within one interval.
	 */
	private readonly watch = new JournalDirWatch({
		dir: () => {
			const dir = channelsDir(this.input.agentDir);
			mkdirSync(dir, { recursive: true });
			return dir;
		},
		onChange: () => {
			for (const host of this.hosts.values()) {
				this.refreshHolder(host);
				void host.channels.ownerPush.drain(host.name);
			}
		},
		onFailure: (reason) =>
			this.input.report(
				`Channels away: the journal directory cannot be watched (${reason}); a session closing is seen at the next daemon tick.`,
			),
	});
	private closed = false;

	constructor(input: AwayChannelHostsInput) {
		this.input = input;
	}

	private now(): number {
		return this.input.timers.port("routines").now();
	}

	private report(cause: string, message: string): void {
		if (this.reported.get(cause) === message) return;
		this.reported.set(cause, message);
		this.input.report(message);
	}

	/** The away spend bound's room, across routine runs and every channel's turns away. */
	private awayRoom(nowMs: number): ReturnType<typeof routineAwaySpendRoom> {
		const away = this.input.settings.getRoutineAwaySettings();
		return routineAwaySpendRoom(
			this.input.routineOccurrences(),
			{
				maxUsdPerRun: away.maxUsdPerRun,
				maxUsdPerDay: away.maxUsdPerDay,
				otherCharges: this.input.otherAwayCharges(nowMs),
				spendsMetered: (definition) =>
					awayRunMetered(definition.executionSnapshot?.savedIntent, this.input.modelRegistry),
				reservedMetered: awayMeteredRunReserved(this.input.agentDir),
			},
			nowMs,
		);
	}

	/** The away spend bound's reason to deliver no turn now: no room, or charges on it that do not read. */
	private capReason(nowMs: number): Worded | undefined {
		const room = this.awayRoom(nowMs);
		if (room.fits(0)) return undefined;
		const { unread } = room;
		return unread
			? (text) => text.notices.channels.cap.awaySpendUnread(unread.cause)
			: (text) => text.notices.channels.cap.awaySpend;
	}

	/**
	 * The hold on a child session's moves to metered models: its subscription turns away reserve nothing on the away
	 * bound, so a move to a metered model first reserves each its full per-run bound, as a run away's attempt is
	 * (`reserveAwayChannelTurns`), the turn offered to it and not accepted yet included (`reserveAwayChannelOffers`), and
	 * is held off metered models while the day has no room for them; a charged move (an explicit model choice) reserves
	 * them whatever the room. Read before the session moves: a journal or a bound that does not read means no room, told
	 * once per channel and cause until a read succeeds.
	 */
	private meteredMoves(name: string, sessionManager: SessionManager): MeteredMoveGate {
		const read = (nowMs: number): { readonly turns: AwaySubscriptionTurns; readonly fits: boolean } | undefined => {
			const unread = `unread:${name}:`;
			// A journal that does not parse was set aside: which turns it held is unknown.
			let cause = "invalid";
			let held: { readonly turns: AwaySubscriptionTurns; readonly fits: boolean } | undefined;
			try {
				const turns = unreservedSubscriptionTurns(this.input.agentDir, name, sessionManager.getSessionId());
				if (turns) {
					const count = turns.keys.length + turns.offers.length;
					// A move that reserves no turn needs no room; one that does is held while the bound's charges do not read.
					const room = count === 0 ? undefined : this.awayRoom(nowMs);
					if (room?.unread) cause = room.unread.cause;
					else {
						for (const key of this.reported.keys()) if (key.startsWith(unread)) this.reported.delete(key);
						return { turns, fits: room === undefined || room.fits(count - 1) };
					}
					// The turns read: a charged move (an explicit model choice) still reserves them.
					held = { turns, fits: false };
				}
			} catch (error) {
				cause = failureCause(error);
			}
			if (!this.reported.has(unread + cause))
				this.report(unread + cause, interfaceText().sessions.awayMeteredRuns.turnsUnread(name, cause));
			return held;
		};
		return {
			fits: () => read(this.now())?.fits === true,
			reserve: (mode = "admit") => {
				const nowMs = this.now();
				const held = read(nowMs);
				if (!held || (mode === "admit" && !held.fits)) return false;
				const { keys, offers } = held.turns;
				const notWritten = (path: string, cause: string) =>
					this.report(
						`reserve:${name}`,
						interfaceText().sessions.awayMeteredRuns.turnNotWritten(name, path, cause),
					);
				const occurrences = [...this.input.routineOccurrences()];
				const { agentDir } = this.input;
				const sessionId = sessionManager.getSessionId();
				const reserved =
					reserveAwayChannelTurns({ agentDir, keys, occurrences, nowMs, notWritten }) &&
					(offers.length === 0 ||
						reserveAwayChannelOffers({ agentDir, name, sessionId, batches: offers, nowMs, notWritten }));
				if (reserved) this.reported.delete(`reserve:${name}`);
				return reserved;
			},
		};
	}

	/**
	 * What a refusal of the channel's host depends on: the credential files, the directory, the model its own
	 * owner-written layers configure, and who holds the phone session the journal records (a session that held it
	 * closing). A change of any is worth another open.
	 */
	private refusalStamp(channel: AwayChannel): string {
		const { cwd } = channel;
		const settings = SettingsManager.create(cwd, this.input.agentDir, { projectTrusted: false });
		return `${this.credentialStamp}|${cwd}|${settings.getDefaultProvider() ?? ""}/${settings.getDefaultModel() ?? ""}|${this.ownerHoldersKey(channel)}`;
	}

	private ownerHoldersKey(channel: AwayChannel): string {
		if (!ownerWanted(channel)) return "";
		const recorded = new ChannelJournal(this.input.agentDir, channel.name).read().result.ownerSession;
		if (!recorded) return "";
		try {
			return readSessionLeaseHolders(ownerOrchestrationHome(this.input.agentDir), recorded.sessionId)
				.filter((holder) => holder.standing !== "dead")
				.map((holder) => holder.token)
				.join(",");
		} catch (error) {
			return `unreadable:${errorText(error)}`;
		}
	}

	/**
	 * Follow the settings and the journals: open a host for each channel served away, close one whose channel is no
	 * longer served away or moved to another directory, and re-read holders that changed. Called on each daemon tick
	 * after the settings reload, with the stamp of the owner's credential files.
	 */
	sync(credentialStamp: string): void {
		if (this.closed) return;
		this.credentialStamp = credentialStamp;
		const wanted = new Map(awayChannels(this.input.settings).map((channel) => [channel.name, channel]));
		if (wanted.size > 0) this.ensureWatch();
		for (const [name, host] of this.hosts) {
			const channel = wanted.get(name);
			if (channel && channel.cwd === host.cwd && ownerWanted(channel) === host.ownerWanted) continue;
			harnessLog.info("channels", "a channel host is closing", () => ({
				channel: name,
				reason: channel ? "its directory or owner transport changed" : "its channel is no longer served away",
			}));
			this.hosts.delete(name);
			const closing = this.closeHost(host)
				.catch((error: unknown) =>
					this.input.report(`Channel ${name} away: its session did not close cleanly (${errorText(error)}).`),
				)
				.finally(() => {
					if (this.closing.get(name) === closing) this.closing.delete(name);
				});
			this.closing.set(name, closing);
		}
		for (const name of this.refused.keys()) if (!wanted.has(name)) this.refused.delete(name);
		const now = this.now();
		for (const [name, channel] of wanted) {
			const host = this.hosts.get(name);
			if (host) {
				this.registerProvider(host, channel);
				this.refreshHolder(host);
				continue;
			}
			if (this.opening.has(name)) continue;
			const refusal = this.refused.get(name);
			if (refusal && now < refusal.retryAt && refusal.stamp === this.refusalStamp(channel)) continue;
			this.opening.set(
				name,
				this.openHost(channel, refusal).finally(() => this.opening.delete(name)),
			);
		}
	}

	/** Who holds the host's channel now; a holder's process ending counts as a change. */
	private holderKey(host: AwayChannelHost): string {
		const holder = new ChannelJournal(this.input.agentDir, host.name).read().result.holder;
		return holder ? `${holder.sessionId}:${holder.pid}:${isProcessAlive(holder.pid)}` : "";
	}

	private refreshHolder(host: AwayChannelHost): void {
		const key = this.holderKey(host);
		if (key === host.holder) return;
		host.holder = key;
		host.channels.refresh();
	}

	private ensureWatch(): void {
		if (!this.closed) this.watch.sync(true);
	}

	private registerProvider(host: AwayChannelHost, { name, policy }: AwayChannel): void {
		if (host.registered) return;
		let provider: ChannelProvider | undefined;
		try {
			provider = this.input.providers(name, policy, {
				agentDir: this.input.agentDir,
				warn: (message) => this.input.report(`Channel ${name}: ${message}`),
			});
		} catch (error) {
			this.report(
				`transport:${name}`,
				`Channel ${name} is not served while no session is open: its transport could not be built (${errorText(error)}).`,
			);
			return;
		}
		if (!provider) {
			this.report(
				`transport:${name}`,
				`Channel ${name} is not served while no session is open: the daemon has no transport for it; its messages wait for an open session.`,
			);
			return;
		}
		this.reported.delete(`transport:${name}`);
		host.registered = true;
		host.channels.registerChannel(provider);
	}

	/** The daemon's report of a warning one of a host's sessions raised, named by that session (`warningSource`). */
	private sessionWarningReport(source: string): (warning: string) => void {
		return (warning) => this.input.report(`${source}: ${warning}`);
	}

	/**
	 * Reports every warning `session` raises while the host runs it. Subscribed before any other listener of the session,
	 * so the warnings it held from before anyone listened (its open's), which go to its first subscriber, are reported
	 * here once instead of reaching a listener that reads no warnings.
	 */
	private subscribeSessionWarnings(session: AgentSession, source: string): () => void {
		const report = this.sessionWarningReport(source);
		return session.subscribe((event) => {
			if (event.type === "warning") report(event.message);
		});
	}

	/** What every session a host opens shares: its directory, the daemon's credential owners and clock, its warnings. */
	private sessionOptions(
		cwd: string,
		settingsManager: SettingsManager,
		resourceLoader: DefaultResourceLoader,
		sessionManager: SessionManager,
		warningSource: string,
	): CreateAgentSessionOptions {
		return {
			cwd,
			agentDir: this.input.agentDir,
			...(this.input.authStorage ? { authStorage: this.input.authStorage } : {}),
			...(this.input.modelRegistry ? { modelRegistry: this.input.modelRegistry } : {}),
			settingsManager,
			resourceLoader,
			sessionManager,
			timers: this.input.timers,
			machineFacts: this.input.machineFacts,
			onClosingWarnings: (warnings) => {
				for (const warning of warnings) this.sessionWarningReport(warningSource)(warning);
			},
		};
	}

	/** Never rejects: a failure is reported and refused until its retry time or a change of what it depends on. */
	private async openHost(channel: AwayChannel, previous: Refusal | undefined): Promise<void> {
		const { agentDir } = this.input;
		const { name, cwd } = channel;
		await this.closing.get(name);
		if (this.closed) return;
		const refuse = (reason: string, message: string) => {
			const delayMs = previous ? Math.min(previous.delayMs * 2, REFUSAL_RETRY_MAX_MS) : REFUSAL_RETRY_MIN_MS;
			this.refused.set(name, { stamp: this.refusalStamp(channel), retryAt: this.now() + delayMs, delayMs });
			harnessLog.warn("channels", "a channel host refused to open; its messages wait", {
				channel: name,
				reason,
				retryMs: delayMs,
			});
			this.report(`open:${name}`, message.replace("{reason}", reason));
		};
		let session: AgentSession | undefined;
		let owner: AwayOwnerSession | undefined;
		const sessionManager = SessionManager.inMemory(ownerSessionStorageRoots(agentDir), cwd);
		try {
			// The directory's own owner-written layers decide the session's model, as for a parent opened away.
			const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
			const resourceLoader = new DefaultResourceLoader({
				cwd,
				agentDir,
				settingsManager,
				noExtensions: true,
				installMissingPackages: false,
				noSkills: true,
				noPromptTemplates: true,
				noThemes: true,
				noContextFiles: true,
			});
			await resourceLoader.reload();
			session = (
				await createAgentSession({
					...this.sessionOptions(cwd, settingsManager, resourceLoader, sessionManager, awaySessionSource(name)),
					standing: { kind: "vehicle" },
					disableSystemOne: true,
					tools: AWAY_CHANNEL_TOOLS,
					// A third party's turn reads the working directory only, never the harness's own storage (credentials,
					// settings, memory, sessions, channel tokens and journals), wherever the directory is.
					privatePathScope: {
						allowedPaths: [cwd],
						deniedPaths: isWithin(agentDir, cwd) ? [] : [agentDir],
					},
				})
			).session;
			const refusal = modelRefusal(session);
			if (refusal || this.closed) {
				await session.disposeAndWait();
				if (refusal)
					refuse(
						refusal,
						`Channel ${name} is not served while no session is open: {reason}. Its messages wait for an open session.`,
					);
				return;
			}
			if (ownerWanted(channel)) owner = await this.openOwnerSession(channel);
			if (this.closed) {
				await this.closeOwnerSession(owner);
				await session.disposeAndWait();
				return;
			}
			this.refused.delete(name);
			this.reported.delete(`open:${name}`);
			this.hosts.set(name, this.startHost(channel, session, sessionManager, owner));
		} catch (error) {
			await this.closeOwnerSession(owner).catch(() => undefined);
			if (session) await session.disposeAndWait().catch(() => undefined);
			refuse(
				errorText(error),
				`Channel ${name} away in ${cwd} could not open a session ({reason}); its messages wait for an open session.`,
			);
		}
	}

	/**
	 * The owner's phone session for the channel: the one the journal records, while its file still holds it, else a new
	 * session in the channel's directory named `Phone: <channel>`, recorded once its file exists (a session that never
	 * wrote is never reported lost). It is refused, before its file is opened, while a session or another channel host
	 * holds it (`SessionHeldError`). It runs as an owner's session would in that directory (the project untrusted): the
	 * normal tools, its context files and skills, no extensions, prompt templates or themes, and its own priced model.
	 * Its lease is `channel-host`, so no terminal opens it while the daemon hosts it; it starts no channel and never
	 * launches the daemon (`hostedChannels`). Its turns' bounds, stops and kill switches are the channels core's.
	 */
	private async openOwnerSession(channel: AwayChannel): Promise<AwayOwnerSession> {
		const { agentDir } = this.input;
		const { name, cwd } = channel;
		const journal = new ChannelJournal(agentDir, name);
		const recorded = journal.read().result.ownerSession;
		let sessionManager: SessionManager | undefined;
		if (recorded) {
			const open = readSessionLeaseHolders(ownerOrchestrationHome(agentDir), recorded.sessionId).filter(
				(holder) => holder.standing !== "dead" && (holder.role === "session" || holder.role === "channel-host"),
			);
			if (open.length > 0)
				throw new SessionHeldError(
					recorded.sessionId,
					open.map((holder) => sessionLeaseHolderRef(holder, holder.standing)),
					"channel-host",
				);
			const header = readSessionHeaderResult(recorded.file);
			let lost = header.ok ? "it holds another session" : `it cannot be read (${header.reason})`;
			if (header.ok && header.header.id === recorded.sessionId) {
				try {
					sessionManager = SessionManager.open(recorded.file, ownerSessionStorageRoots(agentDir));
				} catch (error) {
					lost = `it cannot be opened (${errorText(error)})`;
				}
			}
			if (!sessionManager)
				this.input.report(
					`Channel ${name}: the phone session ${recorded.sessionId} is lost (${recorded.file}: ${lost}); a new phone session is started.`,
				);
		}
		const fresh = !sessionManager;
		sessionManager ??= SessionManager.create(cwd, ownerSessionStorageRoots(agentDir));
		const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			installMissingPackages: false,
			noPromptTemplates: true,
			noThemes: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			...this.sessionOptions(cwd, settingsManager, resourceLoader, sessionManager, phoneSessionSource(name)),
			bundleLeaseRole: "channel-host",
			hostedChannels: "daemon",
		});
		const manager = sessionManager;
		let unrecorded = (): void => {};
		try {
			const refusal = modelRefusal(session);
			if (refusal) throw new Error(`the phone session cannot run: ${refusal}`);
			if (fresh) {
				session.setSessionName(`Phone: ${name}`);
				const record = (): boolean => {
					const file = manager.getSessionFile();
					if (!file || !existsSync(file)) return false;
					const sessionId = manager.getSessionId();
					try {
						journal.update(this.now(), (state) => {
							state.ownerSession = { sessionId, file };
						});
						return true;
					} catch (error) {
						// Tried again at the session's next saved entry.
						this.input.report(`Channel ${name}: the phone session is not recorded yet (${errorText(error)}).`);
						return false;
					}
				};
				if (!record()) {
					const stop = manager.onEntriesPersisted(() => {
						if (record()) stop();
					});
					unrecorded = stop;
				}
			}
		} catch (error) {
			unrecorded();
			await session.disposeAndWait();
			throw error;
		}
		return { session, sessionManager: manager, unrecorded: () => unrecorded() };
	}

	private async closeOwnerSession(owner: AwayOwnerSession | undefined): Promise<void> {
		if (!owner) return;
		owner.unrecorded();
		await owner.session.disposeAndWait();
	}

	private startHost(
		channel: AwayChannel,
		session: AgentSession,
		sessionManager: SessionManager,
		owner: AwayOwnerSession | undefined,
	): AwayChannelHost {
		const { agentDir, settings } = this.input;
		const { name, cwd } = channel;
		const activity = new Set<() => void>();
		const unsubscribeWarnings = this.subscribeSessionWarnings(session, awaySessionSource(name));
		const unsubscribeOwnerWarnings = owner && this.subscribeSessionWarnings(owner.session, phoneSessionSource(name));
		// One turn's spend bound, as one run away's: past it the turn ends and its conversation gets no reply. It holds the
		// turn's metered spend, by the owner's cost rule: a subscription's turns are held by its usage windows instead.
		const limit = () =>
			isMeteredSpend(session.model, session.modelRegistry)
				? { usd: settings.getRoutineAwaySettings().maxUsdPerRun }
				: undefined;
		session.holdMeteredMoves(this.meteredMoves(name, sessionManager));
		const unsubscribeSpend = boundSessionTurnSpend(session, {
			// The turn's own spend: a channel turn away is its own run.
			exceeded: (turnUsd) => turnSpendExcess(turnUsd, limit()),
			openingExceeded: (_opening, turnUsd) => turnSpendExcess(turnUsd, limit()),
			onExceeded: (usd, { usd: perRun }) => {
				harnessLog.warn("channels", "a channel turn away was stopped at the away spend bound", {
					channel: name,
					usd,
					perRunUsd: perRun,
				});
				return `a channel turn away spent past routines.away.maxUsdPerRun ($${perRun.toFixed(2)})`;
			},
			holdFailed: (error) =>
				harnessLog.warn("channels", "the goal of a channel turn away stopped at its spend bound was not held", {
					channel: name,
					error: safeErrorMessage(error),
				}),
		});
		const unsubscribeActivity = session.subscribe((event) => {
			if (event.type === "agent_end") for (const listener of activity) listener();
		});
		const unsubscribe = () => {
			unsubscribeWarnings();
			unsubscribeSpend();
			unsubscribeActivity();
		};
		// An owner turn's end in the phone session wakes the channels core like a child turn's.
		const unsubscribeOwner = owner?.session.subscribe((event) => {
			if (event.type === "agent_end") for (const listener of activity) listener();
		});
		// The reason each notice was last reported in; a cleared notice is reported again when it returns.
		const notices = new Map<string, string>();
		const channelsHost = new SessionChannels({
			getAgentDir: () => agentDir,
			getSessionManager: () => sessionManager,
			// A third party's turn runs in the child session, on its model.
			turnAllowance: (maxUsedPercent) => session.ownerChannel.quotaAllowance(maxUsedPercent),
			// The owner's words run in the phone session; a third party's in the child session, as before.
			...(owner
				? {
						ownerDelivery: owner.session.ownerChannel,
						ownerTasks: owner.session.backgroundLanes,
						ownerControl: () => owner.session.ownerChannel.control(),
						isEmergencyStopEngaged: () => isEmergencyStopEngaged(agentDir),
						subscribeEmergencyStop: (listener: () => void) => subscribeEmergencyStop(agentDir, listener),
						getOwnerSessionManager: () => owner.sessionManager,
					}
				: {}),
			getChannelPolicies: () => {
				const served = awayChannels(settings).some((entry) => entry.name === name && entry.cwd === cwd);
				const resolution = served ? settings.getAwayChannelPolicies().get(name) : undefined;
				return new Map(resolution ? [[name, resolution]] : []);
			},
			subscribeSettings: (listener) => settings.subscribeChanges(listener),
			subscribeForegroundActivity: (listener) => {
				activity.add(listener);
				return () => activity.delete(listener);
			},
			sendUserMessage: (text, options) => session.sendUserMessage(text, options),
			// The channel's dollar bounds count metered (API) spend only (`readBatchOutcome`).
			getModelRegistry: () => session.modelRegistry,
			// No owner reads this session: what it would tell them goes to the daemon's reports, once per state, and the
			// owner is never told here.
			observeNotice: (kind, read) => {
				const observation = read();
				if (!observation) return false;
				const scoped =
					typeof observation === "object" && "scope" in observation
						? observation
						: { scope: "", state: observation };
				const key = `${kind}:${scoped.scope}`;
				if (scoped.state === "clear") {
					notices.delete(key);
					return false;
				}
				if (notices.get(key) === scoped.state.reason) return false;
				notices.delete(key);
				notices.set(key, scoped.state.reason);
				if (notices.size > MAX_HOST_NOTICES) {
					const oldest = notices.keys().next().value;
					if (oldest !== undefined) notices.delete(oldest);
				}
				this.input.report(scoped.state.text);
				return false;
			},
			warn: (message) => this.input.report(message),
			isDisposed: () => this.closed,
			servesChannels: () => true,
			// The same ports the open session's channels run on: a polling transport's waits and the expiry wake.
			timers: this.input.timers.port("channel-poll"),
			wakeTimers: this.input.timers.port("channel-expiry"),
			away: {
				// The away spend bound holds metered (API) turns alone; a subscription turn reserves nothing on it until it
				// moves to a metered model (`meteredMoves`).
				capReason: (nowMs) =>
					isMeteredSpend(session.model, session.modelRegistry) ? this.capReason(nowMs) : undefined,
				spendsMetered: () => isMeteredSpend(session.model, session.modelRegistry),
			},
		});
		const host: AwayChannelHost = {
			name,
			cwd,
			session,
			channels: channelsHost,
			registered: false,
			unsubscribe: () => {
				unsubscribe();
				unsubscribeOwner?.();
				unsubscribeOwnerWarnings?.();
			},
			holder: "",
			ownerWanted: ownerWanted(channel),
			owner,
		};
		this.registerProvider(host, channel);
		channelsHost.start();
		host.holder = this.holderKey(host);
		return host;
	}

	/**
	 * Stop the host's turns and wait until its sessions are idle, so the batches it accepted settle on what the turns did;
	 * then stop the provider, settle and give the channel back, and close the sessions (the phone session's close
	 * releases its channel-host hold).
	 */
	private async closeHost(host: AwayChannelHost): Promise<void> {
		try {
			await host.session.abort("channel host closing");
			await host.owner?.session.abort("channel host closing");
			await host.channels.stop();
		} finally {
			host.unsubscribe();
			try {
				await host.session.disposeAndWait();
			} finally {
				await this.closeOwnerSession(host.owner);
			}
		}
	}

	/** Stop every provider, give every channel back and close the sessions. */
	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.watch.sync(false);
		await Promise.all(this.opening.values());
		await Promise.all(this.closing.values());
		const hosts = [...this.hosts.values()];
		this.hosts.clear();
		const failures: unknown[] = [];
		for (const host of hosts) {
			try {
				await this.closeHost(host);
			} catch (error) {
				failures.push(error);
			}
		}
		if (failures.length > 0) throw new AggregateError(failures, "The daemon's channel hosts did not close cleanly.");
	}
}
