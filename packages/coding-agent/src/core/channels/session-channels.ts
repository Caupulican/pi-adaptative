/**
 * The one owner of a root session's channels: which registered providers start, what an inbound event may do, how
 * admitted messages become a turn, and where the turn's answer goes.
 *
 * Fail closed throughout. A provider starts only under an explicit `channels.<name>` policy the owner wrote (global or
 * directory profile) and only in the one open session that serves the channel. An event is acknowledged to the
 * provider only after the channel journal holds it. Only a verified, allowlisted sender's message can start a turn,
 * and it arrives as a third party's words (`sendUserMessage` with an origin): the origin gate treats the run as theirs.
 * The answer goes back to the same address only when the owner set `replyMode: "auto"`; otherwise it waits as a draft
 * the owner releases with the `channel_reply` tool.
 */

import { type FSWatcher, watch } from "node:fs";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import { channelsDir } from "../agent-paths.ts";
import type { SendUserMessageOptions } from "../extensions/types.ts";
import {
	type ChannelMessage,
	type ChannelProvider,
	type ChannelProviderStatus,
	GatewayRegistry,
	type JobSchedulerProvider,
	type LifecycleOutcome,
} from "../gateways/channel-provider.ts";
import { type HarnessNoticeKind, type HarnessNoticeObservation, transcriptKeepsNotices } from "../harness-notice.ts";
import { isProcessAlive } from "../process-liveness.ts";
import {
	boundedRedactedDiagnosticText,
	hasMaskableSecretText,
	MAX_RETAINED_DIAGNOSTIC_CHARS,
} from "../security/secret-text.ts";
import { entryTurnOrigin, isDecisiveOrigin } from "../turn-origin.ts";
import type { TimerPort } from "../util/timer-port.ts";
import { type ChannelServedBy, channelServedBy } from "./away-channels.ts";
import { createBuiltInChannelProvider, isBuiltInChannel, isShippedChannelProvider } from "./built-in-providers.ts";
import {
	type ChannelAwayUntold,
	type ChannelBatchRecord,
	type ChannelDraftRecord,
	type ChannelGapRecord,
	ChannelJournal,
	type ChannelJournalState,
	type ChannelPendingMessage,
	type ChannelUntold,
	channelDayUsage,
	DAY_MS,
	digest,
	heldCount,
	isUntoldEmpty,
	MAX_PENDING_MESSAGES,
	markTold,
	PENDING_EXPIRY_MS,
	recordGap,
	untoldRecords,
} from "./channel-journal.ts";
import {
	composeChannelBatch,
	formatChannelReply,
	isAdmittedKind,
	MAX_REPLY_CHARS,
	parseInboundChannelEvent,
	plainLabel,
} from "./channel-message.ts";
import { type ChannelPolicyResolution, isValidChannelName, type ResolvedChannelPolicy } from "./channel-policy.ts";

/** The daemon's drafts one summary of what it left names by id and reason; the rest are counted. */
const MAX_NAMED_AWAY_DRAFTS = 3;
/** Pending drafts per channel; past it the channel delivers nothing new until the owner sends or dismisses some. */
const MAX_PENDING_DRAFTS = 32;
/**
 * A sender id the owner is told verbatim: one the platform assigned (`ChannelSenderIds`), plain and short, never prose
 * (a notice enters the owner's turn unfenced). It is told only when the whole notice fits its one line.
 */
const PLAIN_SENDER_ID = /^[A-Za-z0-9._@+-]{1,64}$/;

/**
 * The one line that tells the owner of a held sender and the key to add them to: with the id only when the platform
 * assigned it; an id the sender chose is read through `channel_reply` `list`, fenced as data.
 */
function senderNoticeText(name: string, platformId: string | undefined): string {
	return platformId !== undefined
		? `Channel ${name} held a message from sender ${platformId}, who is not in channels.${name}.allowedSenders. To let them start turns, add "${platformId}" to that list.`
		: `Channel ${name} held a message from a verified sender who is not in channels.${name}.allowedSenders. The channel_reply tool's list action shows the sender's id to add to that list.`;
}
/** New senders per channel the owner is told about in 24 hours, each once. */
const MAX_SENDER_NOTICES_PER_DAY = 3;

/** Sessions of this process that serve a channel: a holder with this process's pid is live only while listed here. */
const liveHolders = new Map<string, string>();
/** Sessions of this process serving channels: a channel one of them gives up is offered to the others at once. */
const startedSessions = new Set<SessionChannels>();

/**
 * How long a message stays marked as offered to another session that still runs: past it the mark is freed, so a
 * process whose id was reused cannot silence a conversation. A live offerer accepts within moments (only a preempted
 * daemon host offers while it does not hold the channel, and it runs no other turn).
 */
const OFFER_STALE_MS = 60 * 60 * 1000;

/** Whether the journal's holder still serves: one of this process's is live only while listed in `liveHolders`. */
function holderLive(journalPath: string, holder: NonNullable<ChannelJournalState["holder"]>): boolean {
	return holder.pid === process.pid ? liveHolders.get(journalPath) === holder.sessionId : isProcessAlive(holder.pid);
}

/** Whether a session recorded with its process still runs: one of this process's only while it serves channels. */
function sessionLive(sessionId: string, pid: number | undefined): boolean {
	if (pid === undefined) return false;
	if (pid !== process.pid) return isProcessAlive(pid);
	for (const session of startedSessions) if (session.sessionId() === sessionId) return true;
	return false;
}

/** Whether an accepted batch's turn may still answer: its session runs by `pid`; with no known process, for its day. */
function batchMayAnswer(batch: ChannelBatchRecord, pid: number | undefined, now: number): boolean {
	return pid === undefined ? now - batch.acceptedAt < DAY_MS : sessionLive(batch.sessionId, pid);
}

/** Whether a message's offer still holds: the session it is offered to runs and the offer is not stale. */
function offerHolds(entry: ChannelPendingMessage, now: number): boolean {
	return (
		entry.offeredTo !== undefined &&
		sessionLive(entry.offeredTo, entry.offeredPid) &&
		now - (entry.offeredAt ?? 0) < OFFER_STALE_MS
	);
}

function clearOffer(entry: ChannelPendingMessage): void {
	entry.offeredTo = undefined;
	entry.offeredPid = undefined;
	entry.offeredAt = undefined;
	entry.offeredBatch = undefined;
	entry.offeredAway = undefined;
}

/** What the delivery pass found in the journal for this session. */
type DeliveryPick =
	| { readonly kind: "not_holder" | "busy" | "idle" }
	| { readonly kind: "capped"; readonly cap: string }
	| { readonly kind: "deliver"; readonly batch: readonly ChannelPendingMessage[]; readonly batchId: string };

export type ChannelRuntimeState =
	| "not_configured"
	| "invalid"
	| "ignored"
	| "served_elsewhere"
	| "starting"
	| "armed"
	| "suspended"
	| "capped"
	| "stopped";

/** The read-only view of one registered channel. */
export interface ChannelStateView {
	readonly name: string;
	readonly state: ChannelRuntimeState;
	readonly detail?: string;
}

/** One channel's daily bounds used, and what its journal holds undelivered. */
export interface ChannelJournalSummary {
	readonly name: string;
	/** Turns delivered in the last 24 hours against `maxWakesPerDay`. */
	readonly wakes: { readonly used: number; readonly max: number };
	/** Dollars the channel's turns cost in the last 24 hours against `maxUsdPerDay`. */
	readonly spendUsd: { readonly used: number; readonly max: number };
	readonly pendingMessages: number;
	readonly pendingDrafts: number;
	/** Messages held back (unverified, not allowlisted, or a burst) since the journal began. */
	readonly heldTotal: number;
	readonly gaps: number;
	/** Who serves the channel now, by its journal: this session, the daemon (no session open), another session, nobody. */
	readonly servedBy: ChannelServedBy;
	/** Reply drafts the daemon wrote while no session was open that still wait for the owner. */
	readonly awayDrafts: number;
}

/** One reply draft as the owner's release tool lists it. */
export interface ChannelDraftView {
	readonly id: string;
	readonly channel: string;
	readonly reason: string;
	readonly createdAt: string;
	readonly text: string;
}

/** A verified, not allowlisted sender whose id the sender chose, as the owner's release tool lists it (fenced). */
export interface ChannelHeldSenderView {
	readonly channel: string;
	readonly id: string;
	readonly heldAt: string;
}

/** What a session exposes: a deployment wrapper registers providers and reads their states; it never starts them. */
export type SessionChannelsView = Pick<SessionChannels, "registerChannel" | "registerScheduler" | "getStates">;

export interface SessionChannelsDeps {
	getAgentDir(): string;
	getSessionManager(): SessionManager;
	getChannelPolicies(): ReadonlyMap<string, ChannelPolicyResolution>;
	subscribeSettings(listener: () => void): () => void;
	subscribeForegroundActivity(listener: () => void): () => void;
	sendUserMessage(text: string, options: SendUserMessageOptions): Promise<void>;
	/**
	 * Whether the owner is told: the notice is kept for their next turn (`HarnessNoticeController.observe`). `onLost`
	 * hears, once, that a notice reported kept was dropped unsaved after all.
	 */
	observeNotice(
		kind: HarnessNoticeKind,
		read: () => HarnessNoticeObservation | undefined,
		onLost?: () => void,
	): boolean;
	warn(message: string): void;
	isDisposed(): boolean;
	isChildSession(): boolean;
	/** Rebuild the session's tools: the release tool is offered only while a channel has an explicit policy. */
	refreshTools?(): void;
	now?(): number;
	/** The schedule clock a shipped polling transport waits on (`channel-poll`); the system clock when omitted. */
	timers?: TimerPort;
	/**
	 * Set for the daemon's host while no session is open (`away-channel-host.ts`): it serves a channel only while no open
	 * session does and yields to one at once, marks its batches and drafts `away`, and delivers a turn only while
	 * `capReason` (the away spend bound) gives no reason to wait.
	 */
	away?: { capReason(now: number): string | undefined };
}

interface ChannelRuntime {
	state: ChannelRuntimeState;
	detail?: string;
	/** This session recorded itself as the channel's serving session. */
	holding: boolean;
	/** A batch handed to `sendUserMessage` whose acceptance is not known yet. */
	offering: boolean;
	/** Why the started provider reported it receives nothing, until it reports it is connected again. */
	connection?: string;
	/** The daemon's host yielded the channel to an open session and still routes the batches it accepted. */
	draining?: boolean;
}

function messageText(message: AgentMessage): string | undefined {
	if (message.role !== "user" && message.role !== "assistant") return undefined;
	const content = message.content;
	if (typeof content === "string") return content;
	const texts: string[] = [];
	for (const part of content) if (part.type === "text" && part.text.length > 0) texts.push(part.text);
	return texts.join("\n");
}

/** How a delivered batch's turn ended, read from the session branch. */
type BatchOutcome =
	| { readonly kind: "waiting"; readonly usd: number }
	| { readonly kind: "answered"; readonly text: string; readonly usd: number }
	| { readonly kind: "unanswered"; readonly reason: string; readonly usd: number };

export class SessionChannels {
	private readonly deps: SessionChannelsDeps;
	private readonly registry: GatewayRegistry;
	private readonly runtimes = new Map<string, ChannelRuntime>();
	private readonly journals = new Map<string, ChannelJournal>();
	private readonly unsubscribes: (() => void)[] = [];
	private started = false;
	/** When the daemon's host started serving: it reports to the daemon the gaps it sees from then on. */
	private startedAt = 0;
	/** Set while a record waits to be told until the session's transcript keeps a notice: its next saved entry. */
	private transcriptWait: (() => void) | undefined;
	private routing = false;
	private rerun = false;
	private drainQueued = false;
	/** Whether a channel had an explicit policy when the tools were last built for it. */
	private toolsOfferRelease = false;
	/** Shipped transports this session registered, by channel name. */
	private readonly builtIns = new Map<string, ChannelProvider>();
	/** Names a deployment wrapper registered: its provider wins over a shipped one. */
	private readonly wrapperNames = new Set<string>();
	/** Per channel taken over from the daemon's host: that host's session, whose last turns still write drafts. */
	private readonly followed = new Map<string, string>();
	/**
	 * The watch on the journal directory of an open session while it follows a preempted host or wants a channel another
	 * session serves: a journal's change tells the drafts that host writes and takes a channel given up in another
	 * process at once. The daemon's host has its own watch (`away-channel-host.ts`).
	 */
	private dirWatcher: FSWatcher | undefined;
	private dirWatchFailure: string | undefined;

	constructor(deps: SessionChannelsDeps) {
		this.deps = deps;
		this.registry = new GatewayRegistry({
			onDiagnostic: (message) => deps.warn(message),
			admitChannel: (name) => this.admit(name),
			onChannelStart: (name, outcome, reason) => this.onChannelStart(name, outcome, reason),
			onChannelStatus: (name, status) => this.onChannelStatus(name, status),
		});
	}

	private now(): number {
		return this.deps.now?.() ?? Date.now();
	}

	/** The session this serves channels for: the id the journal records it by. */
	sessionId(): string {
		return this.deps.getSessionManager().getSessionId();
	}

	private journal(name: string): ChannelJournal {
		let journal = this.journals.get(name);
		if (!journal) {
			journal = new ChannelJournal(this.deps.getAgentDir(), name);
			this.journals.set(name, journal);
		}
		return journal;
	}

	private runtime(name: string): ChannelRuntime {
		let runtime = this.runtimes.get(name);
		if (!runtime) {
			runtime = { state: "stopped", holding: false, offering: false };
			this.runtimes.set(name, runtime);
		}
		return runtime;
	}

	private policy(name: string): ResolvedChannelPolicy | undefined {
		const resolution = this.deps.getChannelPolicies().get(name);
		return resolution?.kind === "policy" && resolution.policy.mode === "explicit" ? resolution.policy : undefined;
	}

	/** Register a deployment-supplied channel. It starts only under its policy, now or once the session starts. */
	registerChannel(provider: ChannelProvider): void {
		this.wrapperNames.add(provider.name);
		// The registry stops the shipped provider it replaces; that provider's last report is not the wrapper's.
		if (this.builtIns.delete(provider.name)) {
			const runtime = this.runtimes.get(provider.name);
			if (runtime) runtime.connection = undefined;
		}
		this.registry.registerChannel(provider);
	}

	registerScheduler(provider: JobSchedulerProvider): void {
		this.registry.registerScheduler(provider);
	}

	/**
	 * Register the shipped transport of each built-in channel under an explicit policy that no wrapper serves, and retire
	 * it when that policy is gone. An unreadable policy for a built-in channel is told to the owner like a wrapper's.
	 */
	private syncBuiltIns(): void {
		const policies = this.deps.getChannelPolicies();
		for (const name of new Set([...policies.keys(), ...this.builtIns.keys(), ...this.runtimes.keys()])) {
			if (!isBuiltInChannel(name) || this.wrapperNames.has(name)) continue;
			const resolution = policies.get(name);
			const policy =
				resolution?.kind === "policy" && resolution.policy.mode === "explicit" ? resolution.policy : undefined;
			if (policy) {
				if (this.builtIns.has(name)) continue;
				const provider = createBuiltInChannelProvider(name, policy, {
					agentDir: this.deps.getAgentDir(),
					warn: (message) => this.deps.warn(message),
					...(this.deps.timers ? { timers: this.deps.timers } : {}),
				});
				if (!provider) continue;
				this.builtIns.set(name, provider);
				this.registry.registerChannel(provider);
				continue;
			}
			if (this.builtIns.delete(name)) void this.registry.unregisterChannel(name);
			if (this.runtimes.has(name)) this.dropHold(name);
			if (resolution?.kind === "invalid") {
				const runtime = this.runtime(name);
				if (runtime.state !== "invalid" || runtime.detail !== resolution.reason)
					this.setState(name, "invalid", resolution.reason);
			} else if (this.runtimes.get(name)?.draining !== true && this.runtimes.delete(name)) {
				// A runtime still routing its last turn is removed by a later pass, once that turn is settled.
				this.deps.observeNotice("channel-state", () => ({ scope: name, state: "clear" }));
			}
		}
	}

	/** Every registered channel and what it is doing, and a built-in one whose policy cannot be read; read-only. */
	getStates(): ChannelStateView[] {
		const names = new Set(this.registry.channelNames);
		for (const [name, runtime] of this.runtimes)
			if (runtime.state === "invalid" && isBuiltInChannel(name)) names.add(name);
		return [...names].map((name) => {
			const runtime = this.runtimes.get(name);
			return {
				name,
				state: runtime?.state ?? (this.started ? "not_configured" : "stopped"),
				...(runtime?.detail ? { detail: runtime.detail } : {}),
			};
		});
	}

	/** Whether any channel has an explicit policy: the release tool is offered only then. */
	hasExplicitPolicy(): boolean {
		for (const resolution of this.deps.getChannelPolicies().values())
			if (resolution.kind === "policy" && resolution.policy.mode === "explicit") return true;
		return false;
	}

	/** Start serving the session's channels: hands-off, called once the session binds; a child session has none. */
	start(): void {
		if (this.started || this.deps.isChildSession() || this.deps.isDisposed()) return;
		this.started = true;
		this.startedAt = this.now();
		this.toolsOfferRelease = this.hasExplicitPolicy();
		startedSessions.add(this);
		this.unsubscribes.push(
			this.deps.subscribeSettings(() => this.onSettingsChanged()),
			this.deps.subscribeForegroundActivity(() => this.onActivity()),
		);
		this.syncBuiltIns();
		void this.registry.start((name, message) => this.receive(name, message));
	}

	/**
	 * Stop every provider and give up every channel this session serves. Bounded by the registry's lifecycle timeout.
	 * The daemon's host settles the batches it accepted here, after its session's turn ended: an answer becomes a draft,
	 * any other outcome is unanswered with what the turn spent. An open session's accepted batches are settled, with a
	 * gap the owner is told, by the next session that finds this one gone.
	 */
	async stop(): Promise<void> {
		const wasStarted = this.started;
		this.started = false;
		startedSessions.delete(this);
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
		this.transcriptWait?.();
		this.transcriptWait = undefined;
		this.followed.clear();
		this.syncDirWatch();
		await this.registry.stop();
		if (!wasStarted) return;
		for (const [name, runtime] of this.runtimes) {
			if (this.deps.away) this.settleOnClose(name);
			if (runtime.holding) this.releaseHold(name);
			runtime.state = "stopped";
			runtime.draining = false;
			runtime.connection = undefined;
		}
	}

	private settleOnClose(name: string): void {
		const sessionId = this.sessionId();
		const now = this.now();
		try {
			for (const batch of this.journal(name).read().result.batches) {
				if (batch.state !== "accepted" || batch.sessionId !== sessionId) continue;
				const outcome = this.batchOutcome(name, batch, now);
				if (outcome.kind === "answered")
					this.keepDraft(name, batch, outcome.text, "the daemon stopped serving the channel", outcome.usd);
				else this.settleBatch(name, batch.id, "unanswered", outcome.usd, undefined);
			}
		} catch (error) {
			this.deps.warn(
				`Channel ${name}: the turns this host accepted could not be settled (${error instanceof Error ? error.message : String(error)}); the next session that serves the channel settles them.`,
			);
		}
	}

	private setState(name: string, state: ChannelRuntimeState, detail?: string): void {
		const runtime = this.runtime(name);
		runtime.state = state;
		runtime.detail = detail;
		const notice = this.stateNotice(name, state, detail);
		this.deps.observeNotice("channel-state", () => ({ scope: name, state: notice ?? "clear" }));
		this.syncDirWatch();
	}

	private stateNotice(name: string, state: ChannelRuntimeState, detail: string | undefined) {
		const reason = `${name}:${state}:${detail ?? ""}`;
		switch (state) {
			case "not_configured":
				return {
					reason,
					text: `Channel ${name} is registered but not started: no channels.${name} policy in the global or directory-profile settings.`,
				};
			case "invalid":
				return { reason, text: `Channel ${name} is not started: ${detail ?? "its policy cannot be read"}.` };
			case "served_elsewhere":
				return {
					reason,
					text: `Channel ${name} is not started in this session: another open session serves it.`,
				};
			case "suspended":
				if (detail !== undefined && this.runtimes.get(name)?.connection === detail)
					return {
						reason,
						text: `Channel ${name} is not receiving messages: ${detail}.`,
					};
				return {
					reason,
					text: `Channel ${name} did not start (${detail ?? "start failed"}); it is tried again when settings change or ${this.builtIns.has(name) ? "a session starts" : "the provider registers again"}.`,
				};
			case "capped":
				return {
					reason,
					text: `Channel ${name} holds new messages: ${detail ?? "its daily bound is reached"}. They wait up to 24 hours.`,
				};
			default:
				return undefined;
		}
	}

	/** The registry's start gate: policy, name and the one serving session. Never throws. */
	private admit(name: string): boolean {
		if (!this.started || this.deps.isDisposed()) return false;
		const runtime = this.runtime(name);
		if (!isValidChannelName(name)) {
			if (runtime.state !== "invalid")
				this.setState(name, "invalid", "its name is not a plain lowercase channel name");
			return false;
		}
		const resolution = this.deps.getChannelPolicies().get(name);
		if (!resolution) {
			if (runtime.state !== "not_configured") this.setState(name, "not_configured");
			return this.dropHold(name);
		}
		if (resolution.kind === "invalid") {
			if (runtime.state !== "invalid" || runtime.detail !== resolution.reason)
				this.setState(name, "invalid", resolution.reason);
			return this.dropHold(name);
		}
		if (resolution.policy.mode !== "explicit") {
			if (runtime.state !== "ignored") this.setState(name, "ignored");
			return this.dropHold(name);
		}
		if (this.deps.away && this.servedElsewhere(name)) {
			// The daemon's host never writes the journal while an open session serves the channel: that session's own
			// writes wake it, and a write of its own would wake it again.
			if (runtime.holding) {
				runtime.holding = false;
				runtime.draining = true;
				this.scheduleWork();
			}
			if (runtime.state !== "served_elsewhere")
				this.setState(name, "served_elsewhere", "an open session took it over");
			return false;
		}
		if (!runtime.holding) {
			try {
				if (!this.takeHold(name)) {
					if (runtime.state !== "served_elsewhere") this.setState(name, "served_elsewhere");
					return false;
				}
			} catch (error) {
				this.setState(
					name,
					"suspended",
					`its journal is unavailable: ${error instanceof Error ? error.message : String(error)}`,
				);
				return false;
			}
		}
		// A started provider that reported a lost connection stays suspended until it reports it is back.
		const reported = runtime.state === "suspended" && runtime.connection !== undefined;
		if (runtime.state !== "armed" && runtime.state !== "capped" && runtime.state !== "starting" && !reported)
			this.setState(name, "starting");
		return true;
	}

	/** Whether another live session holds the channel, read without writing the journal. */
	private servedElsewhere(name: string): boolean {
		const journal = this.journal(name);
		const holder = journal.read().result.holder;
		return holder !== undefined && holder.sessionId !== this.sessionId() && holderLive(journal.path, holder);
	}

	private dropHold(name: string): false {
		const runtime = this.runtime(name);
		runtime.connection = undefined;
		if (runtime.holding) this.releaseHold(name);
		return false;
	}

	/** Whether another live session holds the channel that this one may not take from it. */
	private heldAgainst(journalPath: string, holder: ChannelJournalState["holder"], sessionId: string): boolean {
		return (
			holder !== undefined &&
			holder.sessionId !== sessionId &&
			holderLive(journalPath, holder) &&
			(this.deps.away !== undefined || !holder.away)
		);
	}

	/**
	 * Settle as unanswered the accepted batches of sessions that no longer run (by the process each batch records, or
	 * the previous holder's for a batch recorded before that); one gap tells them, and one more the daemon's among them
	 * (`away`), whoever settles them. A batch with no known process is kept for the day its turn may still answer in. A
	 * live session's batches stay its own, a preempted host's included.
	 */
	private settleDeadBatches(
		name: string,
		state: ChannelJournalState,
		sessionId: string,
		now: number,
		previousHolder?: ChannelJournalState["holder"],
	): void {
		let orphaned = 0;
		let orphanedAway = 0;
		for (const batch of state.batches) {
			if (batch.state !== "accepted" || batch.sessionId === sessionId) continue;
			const pid = batch.pid ?? (batch.sessionId === previousHolder?.sessionId ? previousHolder.pid : undefined);
			if (batchMayAnswer(batch, pid, now)) continue;
			batch.state = "unanswered";
			if (batch.away) orphanedAway++;
			else orphaned++;
		}
		if (orphaned > 0)
			state.gaps.push({
				id: digest(`${name}:unanswered:${sessionId}:${now}`).slice(0, 16),
				reason: "unanswered",
				count: orphaned,
				at: now,
			});
		if (orphanedAway > 0)
			recordGap(state, {
				id: digest(`${name}:unanswered-away:${sessionId}:${now}`).slice(0, 16),
				reason: "unanswered",
				count: orphanedAway,
				at: now,
				away: true,
			});
	}

	/**
	 * Record this session as the channel's serving session unless another live one holds it. A holder whose process is
	 * gone is replaced; batches it accepted and never answered become one gap (their turns are in its transcript). An open
	 * session takes a channel the daemon's host serves at once: that host keeps routing the batches it accepted. A
	 * refusal is read without the journal's lock, so a watcher waiting for the channel wakes no other watcher.
	 */
	private takeHold(name: string): boolean {
		const sessionId = this.sessionId();
		const journal = this.journal(name);
		const journalPath = journal.path;
		const away = this.deps.away !== undefined;
		if (this.heldAgainst(journalPath, journal.read().result.holder, sessionId)) return false;
		const now = this.now();
		const update = journal.update(now, (state) => {
			const holder = state.holder;
			if (this.heldAgainst(journalPath, holder, sessionId)) return undefined;
			const preempted =
				holder && holder.sessionId !== sessionId && holderLive(journalPath, holder) ? holder.sessionId : undefined;
			state.holder = { sessionId, pid: process.pid, ...(away ? { away: true as const } : {}) };
			this.settleDeadBatches(name, state, sessionId, now, holder);
			return { preempted };
		});
		this.afterJournal(name, update.reset);
		if (!update.result) return false;
		liveHolders.set(journalPath, sessionId);
		const runtime = this.runtime(name);
		runtime.holding = true;
		runtime.draining = false;
		const { preempted } = update.result;
		if (preempted !== undefined) {
			// The preempted host of this process yields now; one in the daemon's process wakes on the journal's change.
			this.offerToOthers();
			this.followPreempted(name, preempted);
		} else if (!away) this.tellUntold(name);
		return true;
	}

	/**
	 * The host this session took the channel from still routes the turns it had accepted or was offering, and their
	 * answers become drafts: follow the journal (reading only) until none of its turns is left, then tell what the
	 * daemon left, so that summary holds those drafts too. A turn that host accepts after the preemption is followed too.
	 * Each journal change the directory watch sees and each work pass take a step, so the follow ends without the watch.
	 */
	private followPreempted(name: string, preempted: string): void {
		this.followed.set(name, preempted);
		this.followStep(name, preempted);
		this.syncDirWatch();
	}

	/**
	 * Reads only. The follow ends once the preempted host has no turn that may still answer (an accepted batch of a
	 * live session, a live offer that is not stale: what `settleDeadBatches` and `pickDelivery` keep); what it left is
	 * then told. A host that died leaves nothing to wait for.
	 */
	private followStep(name: string, preempted: string): void {
		const state = this.journal(name).read().result;
		const now = this.now();
		const busy =
			state.batches.some(
				(batch) =>
					batch.state === "accepted" && batch.sessionId === preempted && batchMayAnswer(batch, batch.pid, now),
			) || state.pending.some((entry) => entry.offeredTo === preempted && offerHolds(entry, now));
		if (busy) return;
		this.followed.delete(name);
		this.syncDirWatch();
		this.tellUntold(name);
	}

	/**
	 * Tell the owner what the channel's journal holds that no session told: each gap of the channel's open sessions (or
	 * a reset) by itself, and in one summary what the daemon's host left (its gaps, pending drafts and held messages)
	 * unless this session still follows that host's interrupted turn. Only the session the journal names the holder
	 * tells, and only while its transcript can keep a notice; until then it waits for the session's next saved entry.
	 * The same locked journal update that decides to tell the records marks them told, so no session tells one twice,
	 * and a notice the session did not keep, or kept and then lost unsaved, takes its marks back, so the next pass or
	 * session tells it.
	 */
	private tellUntold(name: string): void {
		if (!this.started || this.deps.away || this.deps.isDisposed()) return;
		const sessionId = this.sessionId();
		const journal = this.journal(name);
		const withAway = !this.followed.has(name);
		try {
			const read = journal.read().result;
			if (read.holder?.sessionId !== sessionId || isUntoldEmpty(untoldRecords(read, withAway))) return;
			if (!transcriptKeepsNotices(this.deps.getSessionManager())) {
				this.awaitTranscript();
				return;
			}
			const now = this.now();
			const update = journal.update(now, (state) => {
				if (state.holder?.sessionId !== sessionId) return undefined;
				const untold = untoldRecords(state, withAway);
				if (isUntoldEmpty(untold)) return undefined;
				markTold(state, untold, true);
				return untold;
			});
			this.afterJournal(name, update.reset);
			const untold = update.result;
			if (!untold) return;
			const lostGaps = untold.gaps.filter(
				(gap) => !this.noticeGap(name, gap, () => this.unmarkTold(name, { gaps: [gap] })),
			);
			const away = untold.away;
			const lostAway =
				away && !this.noticeAway(name, away, sessionId, now, () => this.unmarkTold(name, { gaps: [], away }))
					? away
					: undefined;
			if (lostGaps.length > 0 || lostAway)
				this.unmarkTold(name, { gaps: lostGaps, ...(lostAway ? { away: lostAway } : {}) });
		} catch (error) {
			this.deps.warn(
				`Channel ${name}: what its journal recorded could not be told yet (${error instanceof Error ? error.message : String(error)}); a later pass tells it.`,
			);
		}
	}

	/** Take back the told marks of records whose notice the owner does not get: the next pass or session tells them. */
	private unmarkTold(name: string, back: ChannelUntold): void {
		try {
			this.afterJournal(name, this.journal(name).update(this.now(), (state) => markTold(state, back, false)).reset);
		} catch (error) {
			this.deps.warn(
				`Channel ${name}: records whose notice was not kept stay marked told (${error instanceof Error ? error.message : String(error)}); no session tells them again.`,
			);
		}
	}

	/** Run the work pass again at the session's next saved entry: a notice saved before it would wait unkept. */
	private awaitTranscript(): void {
		if (this.transcriptWait) return;
		this.transcriptWait = this.deps.getSessionManager().onEntriesPersisted(() => {
			this.transcriptWait?.();
			this.transcriptWait = undefined;
			this.scheduleWork();
		});
	}

	private noticeGap(name: string, gap: ChannelGapRecord, onLost?: () => void): boolean {
		const text =
			gap.reason === "expired"
				? `Channel ${name}: ${gap.count} message(s) waited more than 24 hours and were dropped undelivered.`
				: gap.reason === "unanswered"
					? `Channel ${name}: ${gap.count} delivered conversation(s) got no reply (the turn ended without an answer for them, or the session that served them closed).`
					: `Channel ${name}: its journal could not be read and was replaced; messages and drafts it held are not delivered.`;
		return this.deps.observeNotice(
			"channel-gap",
			() => ({ scope: `${name}:${gap.id}`, state: { reason: `gap:${name}:${gap.id}`, text } }),
			onLost,
		);
	}

	/**
	 * One notice of what the daemon's host left: its drafts by id and reason, the messages it dropped and the
	 * conversations it left unanswered, and the messages it held, counted by reason; never a sender's id, label or words.
	 * As many drafts are named as fit the notice's one bounded line, the rest are counted.
	 */
	private noticeAway(
		name: string,
		away: ChannelAwayUntold,
		sessionId: string,
		now: number,
		onLost: () => void,
	): boolean {
		const summed = (reason: ChannelGapRecord["reason"]) =>
			away.gaps.filter((gap) => gap.reason === reason).reduce((sum, gap) => sum + gap.count, 0);
		const expired = summed("expired");
		const unanswered = summed("unanswered");
		const held = heldCount(away.held);
		const heldKinds = (
			[
				[away.held.not_allowed, `not in channels.${name}.allowedSenders`],
				[away.held.unverified, "unverified"],
				[away.held.burst, `over channels.${name}.maxPendingPerConversation`],
			] as const
		).flatMap(([count, kind]) => (count ? [`${count} ${kind}`] : []));
		if (away.drafts.length === 0 && expired === 0 && unanswered === 0 && held === 0) return true;
		const compose = (named: number, heldDetail: boolean): string => {
			const parts: string[] = [];
			if (away.drafts.length > 0) {
				const listed = away.drafts.slice(0, named).map((draft) => `${draft.id}: ${draft.reason}`);
				const more = away.drafts.length - listed.length;
				if (more > 0 && listed.length > 0) listed.push(`and ${more} more`);
				parts.push(
					`${away.drafts.length} reply draft(s) wait for channel_reply${listed.length > 0 ? ` (${listed.join(", ")})` : ""}`,
				);
			}
			if (expired > 0) parts.push(`${expired} message(s) expired after 24 hours`);
			if (unanswered > 0) parts.push(`${unanswered} delivered conversation(s) got no reply`);
			if (held > 0) parts.push(`${held} message(s) held${heldDetail ? ` (${heldKinds.join(", ")})` : ""}`);
			return `While the daemon served channel ${name}: ${parts.join("; ")}.`;
		};
		// The most detail that fits; the least is cut at the line's bound by the notice itself.
		const fitting = () => {
			for (let named = Math.min(MAX_NAMED_AWAY_DRAFTS, away.drafts.length); named >= 0; named--)
				for (const heldDetail of [true, false]) {
					const candidate = compose(named, heldDetail);
					if (candidate.length <= MAX_RETAINED_DIAGNOSTIC_CHARS) return candidate;
				}
			return compose(0, false);
		};
		const text = fitting();
		const told = [...away.gaps.map((gap) => gap.id), ...away.drafts.map((draft) => draft.id)].join(",");
		const id = digest(`${name}:away:${sessionId}:${now}:${told}:${JSON.stringify(away.held)}`).slice(0, 16);
		return this.deps.observeNotice(
			"channel-gap",
			() => ({ scope: `${name}:away:${id}`, state: { reason: `away:${name}:${id}`, text } }),
			onLost,
		);
	}

	/** Open the journal directory's watch while this open session follows a host or waits for a channel; else close it. */
	private syncDirWatch(): void {
		const wanted =
			this.started &&
			!this.deps.away &&
			(this.followed.size > 0 ||
				[...this.runtimes.values()].some((runtime) => runtime.state === "served_elsewhere"));
		if (!wanted) {
			this.dirWatcher?.close();
			this.dirWatcher = undefined;
			return;
		}
		if (this.dirWatcher) return;
		try {
			const watcher = watch(channelsDir(this.deps.getAgentDir()), { persistent: false }, (_event, filename) => {
				// A journal is replaced by a rename onto `<name>.json`; its lock and temporary files change nothing.
				if (this.dirWatcher !== watcher || (filename !== null && !String(filename).endsWith(".json"))) return;
				this.onJournalDirChange();
			});
			watcher.on("error", () => {
				if (this.dirWatcher !== watcher) return;
				watcher.close();
				this.dirWatcher = undefined;
			});
			this.dirWatcher = watcher;
			this.dirWatchFailure = undefined;
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			if (this.dirWatchFailure === reason) return;
			this.dirWatchFailure = reason;
			this.deps.warn(
				`Channels: the journal directory cannot be watched (${reason}); a channel another session gives up is taken at the next settings change, and what the daemon left is told at this session's next channel pass (its next turn, message or settings change).`,
			);
		}
	}

	private onJournalDirChange(): void {
		for (const [name, preempted] of this.followed) this.followStep(name, preempted);
		// Admission reads the journal before it locks it, so a channel still served elsewhere costs no write here.
		if ([...this.runtimes.values()].some((runtime) => runtime.state === "served_elsewhere"))
			void this.registry.refreshChannels();
		this.syncDirWatch();
	}

	/** Another session of this process waiting on a channel, or yielding one, re-reads it past the caller's stack. */
	private offerToOthers(): void {
		for (const other of startedSessions)
			if (other !== this) queueMicrotask(() => void other.registry.refreshChannels());
	}

	/**
	 * Re-read who serves each channel: the daemon's host calls it when a channel journal changed or a holder's process
	 * may have ended. Starts what this session may now serve and stops what an open session took over.
	 */
	refresh(): void {
		if (this.started) void this.registry.refreshChannels();
	}

	/** The journal names another holder: stop delivering, keep routing what this session accepted, and re-admit. */
	private lostHold(name: string): void {
		const runtime = this.runtime(name);
		runtime.holding = false;
		runtime.draining = true;
		const journalPath = this.journal(name).path;
		if (liveHolders.get(journalPath) === this.sessionId()) liveHolders.delete(journalPath);
		void this.registry.refreshChannels();
	}

	/** Give the channel up; the batches this session accepted are still routed while it runs (`draining`). */
	private releaseHold(name: string): void {
		this.followed.delete(name);
		this.syncDirWatch();
		const runtime = this.runtime(name);
		runtime.holding = false;
		runtime.draining = true;
		const journal = this.journal(name);
		if (liveHolders.get(journal.path) === this.sessionId()) liveHolders.delete(journal.path);
		try {
			const sessionId = this.sessionId();
			journal.update(this.now(), (state) => {
				if (state.holder?.sessionId === sessionId) state.holder = undefined;
			});
		} catch (error) {
			this.deps.warn(
				`Channel ${name} could not release its journal: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		// Another session of this process waiting on the channel takes it now, not at its next settings change. Past
		// this stack, so its journal update never runs inside this one's start gate or stop.
		this.offerToOthers();
		this.scheduleWork();
	}

	private onChannelStart(name: string, outcome: LifecycleOutcome, reason: string | undefined): void {
		if (!this.started) return;
		const runtime = this.runtime(name);
		if (outcome === "fulfilled") {
			// A provider may report a lost connection before its start settles.
			if (runtime.connection !== undefined) this.setState(name, "suspended", runtime.connection);
			else this.setState(name, "armed");
			this.scheduleWork();
			return;
		}
		runtime.connection = undefined;
		// Only a shipped transport's rejection is shown: its text is Pi's own words. A wrapper's may carry remote text, and
		// a notice enters the owner's turn unfenced.
		const shown =
			reason !== undefined && isShippedChannelProvider(this.registry.getChannel(name))
				? boundedRedactedDiagnosticText(reason)
				: undefined;
		this.setState(name, "suspended", outcome === "timed_out" ? "its start timed out" : (shown ?? "its start failed"));
	}

	/** The started provider lost or regained what it receives on; messages it already handed over are unaffected. */
	private onChannelStatus(name: string, status: ChannelProviderStatus): void {
		if (!this.started) return;
		const runtime = this.runtime(name);
		if (status.state === "connected") {
			if (runtime.connection === undefined) return;
			runtime.connection = undefined;
			if (runtime.state === "suspended") {
				this.setState(name, "armed");
				this.scheduleWork();
			}
			return;
		}
		const reason = boundedRedactedDiagnosticText(status.reason) ?? "the provider gave no reason";
		if (runtime.connection === reason && runtime.state === "suspended") return;
		runtime.connection = reason;
		// While its start is pending the start's outcome decides; it reads the reason recorded here.
		if (runtime.state !== "starting") this.setState(name, "suspended", reason);
	}

	private onSettingsChanged(): void {
		if (!this.started) return;
		this.syncBuiltIns();
		void this.registry.refreshChannels();
		this.scheduleWork();
		const offerRelease = this.hasExplicitPolicy();
		if (offerRelease === this.toolsOfferRelease || !this.deps.refreshTools) return;
		try {
			this.deps.refreshTools();
			this.toolsOfferRelease = offerRelease;
		} catch (error) {
			// Refused while another runtime generation replaces the session's resources: the next settings change retries.
			this.deps.warn(
				`The channel release tool could not follow the channel policy yet: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	private onActivity(): void {
		if (this.started) this.scheduleWork();
	}

	/** Reply routing and delivery run after the caller's stack, one pass at a time. */
	private scheduleWork(): void {
		if (this.drainQueued) return;
		this.drainQueued = true;
		queueMicrotask(() => {
			this.drainQueued = false;
			void this.work();
		});
	}

	private async work(): Promise<void> {
		if (!this.started || this.deps.isDisposed()) return;
		if (this.routing) {
			this.rerun = true;
			return;
		}
		this.routing = true;
		this.rerun = false;
		try {
			// A follow ends here too, so a directory watch that failed or saw nothing withholds no summary.
			for (const [name, preempted] of this.followed) this.followStep(name, preempted);
			for (const [name, runtime] of this.runtimes) {
				if (!runtime.holding && !runtime.draining) continue;
				// A channel whose policy went mid-turn still routes that turn: its answer becomes a draft.
				const policy = this.policy(name);
				const waiting = await this.routeReplies(name, policy);
				if (!runtime.holding || !policy) {
					if (!waiting && !runtime.offering) runtime.draining = false;
					continue;
				}
				if (runtime.state === "armed" || runtime.state === "capped") this.deliverNext(name, policy);
				this.tellUntold(name);
			}
		} catch (error) {
			this.deps.warn(`Channel delivery failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.routing = false;
			if (this.rerun) this.scheduleWork();
		}
	}

	/** Tell the owner what the journal recorded that they have not been told: a reset and its gaps. */
	private afterJournal(name: string, reset: boolean): void {
		if (reset)
			this.deps.warn(`Channel ${name}: its journal could not be read; it was moved aside and a new one started.`);
	}

	/** An inbound event, from the provider's own handler. Resolves once the journal holds it; throws to make it redeliver. */
	private async receive(name: string, raw: ChannelMessage): Promise<void> {
		const policy = this.started ? this.policy(name) : undefined;
		if (!policy || !this.runtime(name).holding) throw new Error(`Channel ${name} is not admitted in this session.`);
		const now = this.now();
		const parsed = parseInboundChannelEvent(raw, now);
		const journal = this.journal(name);
		if (!parsed.ok) {
			journal.update(now, (state) => {
				state.ignoredTotal++;
			});
			this.deps.warn(
				`Channel ${name} delivered an event the harness cannot read (${parsed.reason}); it is ignored.`,
			);
			return;
		}
		const event = parsed.event;
		const eventDigest = digest(event.eventId);
		const senderIds = this.registry.getChannel(name)?.senderIds;
		const normalize = senderIds?.normalize ?? ((id: string) => id);
		const senderId = normalize(event.senderId);
		const allowlisted = policy.allowedSenders.some((entry) => normalize(entry) === senderId);
		const platformId = senderIds?.assignedBy === "platform" ? event.senderId : undefined;
		const update = journal.update(now, (state) => {
			if (state.seen.some((entry) => entry.d === eventDigest)) return "duplicate" as const;
			const held = (reason: "unverified" | "not_allowed" | "burst") => {
				state.held.push({ sender: digest(event.senderId).slice(0, 16), kind: event.kind, reason, at: now });
				state.heldTotal++;
				state.seen.push({ d: eventDigest, at: now, outcome: "held" });
				// Counted for the owner's next session, which tells what the daemon's host left (`tellUntold`).
				if (this.deps.away) state.awayHeld = { ...state.awayHeld, [reason]: (state.awayHeld?.[reason] ?? 0) + 1 };
				return "held" as const;
			};
			if (!isAdmittedKind(event.kind)) {
				state.ignoredTotal++;
				state.seen.push({ d: eventDigest, at: now, outcome: "ignored" });
				return "ignored" as const;
			}
			if (!event.verified) return held("unverified");
			// No owner reads the daemon's host: a sender's one notice a day is left for an open session to give.
			if (this.deps.away && !allowlisted) return held("not_allowed");
			if (!allowlisted) {
				// The owner learns of a verified sender from the harness, at most once a day per sender, a few a day.
				const sender = digest(event.senderId).slice(0, 16);
				const recent = state.onboarding.filter((entry) => now - entry.at < DAY_MS);
				const tell =
					(platformId === undefined || PLAIN_SENDER_ID.test(platformId)) &&
					senderNoticeText(name, platformId).length <= MAX_RETAINED_DIAGNOSTIC_CHARS &&
					!recent.some((entry) => entry.sender === sender) &&
					recent.length < MAX_SENDER_NOTICES_PER_DAY;
				// An id the notice cannot name is kept for the owner's `channel_reply` `list` until the entry ages out.
				if (tell)
					state.onboarding.push({ sender, at: now, ...(platformId === undefined ? { id: event.senderId } : {}) });
				held("not_allowed");
				return tell ? ("tell_owner" as const) : ("held" as const);
			}
			const inConversation = state.pending.filter((entry) => entry.conversationKey === event.conversationKey).length;
			if (inConversation >= policy.maxPendingPerConversation) return held("burst");
			if (state.pending.length >= MAX_PENDING_MESSAGES) return "full" as const;
			const pending: ChannelPendingMessage = {
				eventDigest,
				conversationKey: event.conversationKey,
				address: event.address,
				senderId: event.senderId,
				senderLabel: event.senderLabel,
				verified: event.verified,
				kind: event.kind,
				text: event.text,
				receivedAt: event.receivedAt,
				admittedAt: now,
			};
			state.pending.push(pending);
			state.seen.push({ d: eventDigest, at: now, outcome: "pending" });
			return "pending" as const;
		});
		this.afterJournal(name, update.reset);
		if (update.result === "full") {
			this.deps.observeNotice("channel-state", () => ({
				scope: name,
				state: {
					reason: `${name}:full`,
					text: `Channel ${name} refuses new messages: ${MAX_PENDING_MESSAGES} wait undelivered. The provider is asked to deliver them again later.`,
				},
			}));
			throw new Error(`Channel ${name} journal is full.`);
		}
		if (update.result === "pending") this.scheduleWork();
		if (update.result === "tell_owner") this.noticeSender(name, event.senderId, platformId, now);
	}

	/** Name at most a platform-assigned id and the key: never the sender's label, words or an id they chose. */
	private noticeSender(name: string, senderId: string, platformId: string | undefined, at: number): void {
		const sender = digest(senderId).slice(0, 16);
		this.deps.observeNotice("channel-sender", () => ({
			scope: `${name}:${sender}`,
			state: {
				reason: `sender:${name}:${sender}:${at}`,
				text: senderNoticeText(name, platformId),
			},
		}));
	}

	/** Why the channel delivers nothing now, or undefined. Reads the journal state it is given. */
	private capReason(
		name: string,
		policy: ResolvedChannelPolicy,
		state: ChannelJournalState,
		now: number,
	): string | undefined {
		const { wakes, usd } = channelDayUsage(state, now);
		if (wakes >= policy.maxWakesPerDay)
			return `its bound of ${policy.maxWakesPerDay} turn(s) in 24 hours is reached (channels.${name}.maxWakesPerDay)`;
		if (usd >= policy.maxUsdPerDay)
			return `$${usd.toFixed(2)} spent in the last 24 hours reaches channels.${name}.maxUsdPerDay`;
		if (state.drafts.filter((draft) => draft.state === "pending").length >= MAX_PENDING_DRAFTS)
			return `${MAX_PENDING_DRAFTS} reply drafts wait for the owner (channel_reply)`;
		return undefined;
	}

	/**
	 * What the journal holds for this session's next delivery, settling on the way what no longer waits: messages past
	 * their day (a gap), offers of a session that is gone or past `OFFER_STALE_MS` (this session's own, none being made
	 * now), and the accepted batches of sessions that no longer run. A conversation another live session is being
	 * offered stays its own. A message to deliver is marked offered to this session in the same change, so no other
	 * session delivers it meanwhile, and only while the journal names this session the holder.
	 */
	private pickDelivery(
		name: string,
		policy: ResolvedChannelPolicy,
		state: ChannelJournalState,
		sessionId: string,
		now: number,
	): DeliveryPick {
		if (state.holder?.sessionId !== sessionId) return { kind: "not_holder" };
		// An earlier build rewriting the holder drops the daemon's role; without it an open session would not take over.
		if (this.deps.away && !state.holder.away) state.holder.away = true;
		const expired = state.pending.filter((entry) => now - entry.admittedAt >= PENDING_EXPIRY_MS);
		if (expired.length > 0) {
			const gone = new Set(expired.map((entry) => entry.eventDigest));
			state.pending = state.pending.filter((entry) => !gone.has(entry.eventDigest));
			for (const entry of state.seen) if (gone.has(entry.d)) entry.outcome = "expired";
			const messages = expired.filter((entry) => entry.kind === "message").length;
			if (messages > 0)
				recordGap(state, {
					id: digest(`${name}:expired:${[...gone].join(",")}`).slice(0, 16),
					reason: "expired",
					count: messages,
					at: now,
					...(this.deps.away ? { away: true as const } : {}),
				});
		}
		for (const entry of state.pending)
			if (entry.offeredTo !== undefined && (entry.offeredTo === sessionId || !offerHolds(entry, now)))
				clearOffer(entry);
		this.settleDeadBatches(name, state, sessionId, now);
		// One turn per channel at a time: its reply is routed before the next batch is offered.
		if (state.batches.some((batch) => batch.state === "accepted" && batch.sessionId === sessionId))
			return { kind: "busy" };
		const elsewhere = new Set(
			state.pending.filter((entry) => entry.offeredTo !== undefined).map((entry) => entry.conversationKey),
		);
		// A bound holds messages; with none waiting there is nothing to hold and nothing to tell.
		const first = state.pending.find((entry) => entry.kind === "message" && !elsewhere.has(entry.conversationKey));
		if (!first) return { kind: "idle" };
		const cap = this.capReason(name, policy, state, now) ?? this.deps.away?.capReason(now);
		if (cap) return { kind: "capped", cap };
		const batch = state.pending
			.filter((entry) => entry.conversationKey === first.conversationKey)
			.slice(0, policy.maxBatch);
		// The batch's id rides on the turn's origin record, so routing finds the turn whatever became of its text.
		const batchId = digest(`${name}:${batch.map((entry) => entry.eventDigest).join(",")}`).slice(0, 24);
		for (const entry of batch) {
			entry.offeredTo = sessionId;
			entry.offeredPid = process.pid;
			entry.offeredAt = now;
			entry.offeredBatch = batchId;
			entry.offeredAway = this.deps.away ? true : undefined;
		}
		return { kind: "deliver", batch: structuredClone(batch), batchId };
	}

	/**
	 * Deliver the conversation with the oldest waiting message as one third-party turn. The journal is read first and
	 * locked only when the pass changes it or delivers: a pass with nothing to do writes nothing, so it wakes no watcher.
	 */
	private deliverNext(name: string, policy: ResolvedChannelPolicy): void {
		const runtime = this.runtime(name);
		if (runtime.offering) return;
		const sessionId = this.sessionId();
		const now = this.now();
		const journal = this.journal(name);
		const read = journal.read();
		let state = read.result;
		const before = JSON.stringify(state);
		let pick = this.pickDelivery(name, policy, state, sessionId, now);
		if (read.reset || pick.kind === "deliver" || JSON.stringify(state) !== before) {
			const update = journal.update(now, (current) => {
				const result = this.pickDelivery(name, policy, current, sessionId, now);
				return { pick: result, state: structuredClone(current) };
			});
			this.afterJournal(name, update.reset);
			pick = update.result.pick;
			state = update.result.state;
		}
		// The daemon's host reports the gaps it sees to the daemon; an open session tells them to the owner (`tellUntold`).
		if (this.deps.away) for (const gap of state.gaps) if (gap.at >= this.startedAt) this.noticeGap(name, gap);
		if (pick.kind === "not_holder") {
			this.lostHold(name);
			return;
		}
		if (pick.kind === "capped") {
			if (runtime.state !== "capped" || runtime.detail !== pick.cap) this.setState(name, "capped", pick.cap);
			return;
		}
		if (runtime.state === "capped") this.setState(name, "armed");
		if (pick.kind !== "deliver") return;
		this.offer(name, pick.batch, pick.batchId);
	}

	/** Hand the batch the journal marked offered to this session to the session; record it once accepted. */
	private offer(name: string, messages: readonly ChannelPendingMessage[], batchId: string): void {
		const runtime = this.runtime(name);
		const sessionId = this.sessionId();
		const delivered = new Set(messages.map((message) => message.eventDigest));
		const unmark = () => {
			try {
				this.journal(name).update(this.now(), (state) => {
					for (const entry of state.pending)
						if (entry.offeredBatch === batchId && entry.offeredTo === sessionId) clearOffer(entry);
				});
			} catch {
				// Left marked: the next delivery pass of the channel's holder frees it.
			}
		};
		const composed = composeChannelBatch(name, messages);
		const latest = messages[messages.length - 1];
		if (!latest || !isValidChannelName(name)) {
			unmark();
			return;
		}
		const sender = plainLabel(composed.senderLabel) || "unknown sender";
		runtime.offering = true;
		let answered = false;
		const onAccepted = (accepted: boolean) => {
			if (answered) return;
			answered = true;
			runtime.offering = false;
			if (!accepted) {
				unmark();
				this.deps.warn(`Channel ${name}: the session did not accept a delivery; it is offered again later.`);
				return;
			}
			const now = this.now();
			const batch: ChannelBatchRecord = {
				id: batchId,
				sessionId,
				pid: process.pid,
				conversationKey: latest.conversationKey,
				address: latest.address,
				eventDigests: [...delivered],
				allowlisted: composed.verified,
				acceptedAt: now,
				state: "accepted",
				...(this.deps.away ? { away: true as const } : {}),
			};
			try {
				this.journal(name).update(now, (state) => {
					state.pending = state.pending.filter((entry) => !delivered.has(entry.eventDigest));
					for (const entry of state.seen) if (delivered.has(entry.d)) entry.outcome = "delivered";
					if (!state.batches.some((existing) => existing.id === batch.id)) state.batches.push(batch);
				});
			} catch (error) {
				this.deps.warn(
					`Channel ${name}: a delivered batch was not recorded (${error instanceof Error ? error.message : String(error)}); it may be delivered again.`,
				);
			}
		};
		void this.deps
			.sendUserMessage(composed.text, {
				deliverAs: "followUp",
				processSlashCommands: false,
				origin: { channel: name, sender, verified: composed.verified, text: composed.ownerText, ref: batchId },
				onAccepted,
			})
			.then(
				() => onAccepted(false),
				(error: unknown) => {
					if (!answered)
						this.deps.warn(
							`Channel ${name}: delivery failed (${error instanceof Error ? error.message : String(error)}); it is offered again later.`,
						);
					onAccepted(false);
				},
			);
	}

	/**
	 * How a batch's turn ended, with what its assistant messages cost so far. Its user entry is the one whose origin
	 * record names this channel and the batch's id (`ref`). The answer is the first completed assistant answer after it;
	 * a decisive entry before that (the owner's words, or another third party's, a host event someone else wrote
	 * included) means this batch got none.
	 */
	private batchOutcome(name: string, batch: ChannelBatchRecord, now: number): BatchOutcome {
		const branch = this.deps.getSessionManager().getBranch();
		let index = -1;
		for (let i = branch.length - 1; i >= 0; i--) {
			const entry = branch[i];
			const origin = entry === undefined ? undefined : entryTurnOrigin(entry);
			if (origin?.k === "inbound-channel" && origin.channel === name && origin.ref === batch.id) {
				index = i;
				break;
			}
		}
		if (index < 0)
			return now - batch.acceptedAt >= DAY_MS
				? { kind: "unanswered", reason: "not_delivered", usd: 0 }
				: { kind: "waiting", usd: 0 };
		let usd = 0;
		for (let i = index + 1; i < branch.length; i++) {
			const entry = branch[i];
			if (entry === undefined) continue;
			const origin = entryTurnOrigin(entry);
			if (origin && isDecisiveOrigin(origin))
				return { kind: "unanswered", reason: origin.k === "owner-typed" ? "owner_steered" : "mixed", usd };
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "assistant") continue;
			usd += message.usage?.cost?.total ?? 0;
			// An aborted turn answers nothing; left waiting it would hold the channel's next turn for a day.
			if (message.stopReason === "aborted") return { kind: "unanswered", reason: "aborted", usd };
			if (message.stopReason === "stop" || message.stopReason === "length") {
				const text = messageText(message)?.trim() ?? "";
				return text ? { kind: "answered", text, usd } : { kind: "unanswered", reason: "empty_answer", usd };
			}
		}
		return now - batch.acceptedAt >= DAY_MS
			? { kind: "unanswered", reason: "no_answer", usd }
			: { kind: "waiting", usd };
	}

	/**
	 * Settle this session's delivered batches whose turn ended; resolves whether any still waits for its turn. Reads the
	 * journal without its lock: only a settlement writes. With no policy (it went mid-turn) an answer becomes a draft.
	 */
	private async routeReplies(name: string, policy: ResolvedChannelPolicy | undefined): Promise<boolean> {
		const sessionId = this.sessionId();
		const now = this.now();
		const batches = this.journal(name)
			.read()
			.result.batches.filter((batch) => batch.state === "accepted" && batch.sessionId === sessionId);
		let waiting = false;
		for (const batch of batches) {
			const outcome = this.batchOutcome(name, batch, now);
			if (outcome.kind === "waiting") {
				waiting = true;
				continue;
			}
			if (outcome.kind === "unanswered") {
				if (!this.settleBatch(name, batch.id, "unanswered", outcome.usd, undefined)) continue;
				this.deps.observeNotice("channel-reply", () => ({
					scope: `${name}:${batch.id}`,
					state: {
						reason: `unanswered:${name}:${batch.id}`,
						text: `Channel ${name}: a delivered conversation got no reply (${outcome.reason.replaceAll("_", " ")}).`,
					},
				}));
				continue;
			}
			const provider = this.registry.getChannel(name);
			const draftReason = !policy
				? "the channel's policy was removed"
				: policy.replyMode !== "auto"
					? "replyMode is draft"
					: !batch.allowlisted
						? "a sender was not verified and allowlisted"
						: hasMaskableSecretText(outcome.text)
							? "the reply contains a secret-shaped value"
							: !provider || (this.runtime(name).state !== "armed" && this.runtime(name).state !== "capped")
								? "the channel is not running"
								: undefined;
			const formatted = formatChannelReply(outcome.text, provider?.capabilities);
			const reason =
				draftReason ?? (formatted.ok ? undefined : `the reply is ${formatted.reason.replaceAll("_", " ")}`);
			if (reason || !formatted.ok || !provider) {
				this.keepDraft(name, batch, outcome.text, reason ?? "the channel is not running", outcome.usd);
				continue;
			}
			// Recorded before sending: a crash mid-send loses the reply rather than sending it twice.
			if (!this.settleBatch(name, batch.id, "replied", outcome.usd, undefined)) continue;
			try {
				await this.sendParts(provider, batch, formatted.parts);
			} catch (error) {
				// Only a shipped transport's error is kept: its text is Pi's own words. A wrapper's may carry remote text,
				// and the reason reaches the owner's notices unfenced.
				const said = isShippedChannelProvider(provider)
					? boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error))
					: undefined;
				this.keepDraft(
					name,
					batch,
					outcome.text,
					said ? `sending failed: ${said}` : "sending failed",
					0,
					"replied",
				);
			}
		}
		return waiting;
	}

	private async sendParts(
		provider: ChannelProvider,
		target: { conversationKey: string; address: string; id: string },
		parts: readonly string[],
	): Promise<void> {
		for (const [index, text] of parts.entries()) {
			await provider.send({
				conversationKey: target.conversationKey,
				address: target.address,
				text,
				kind: "message",
				eventId: `reply:${target.id}:${index + 1}/${parts.length}`,
			});
		}
	}

	/**
	 * Move one batch from `from` (accepted, or replied for a send that failed) to `state`, adding what its turn spent and
	 * its draft; whether it moved. A batch another pass already settled is left as it is, so nothing is settled twice. A
	 * conversation the daemon's host leaves unanswered is also a gap, for the owner's next session to be told.
	 */
	private settleBatch(
		name: string,
		batchId: string,
		state: ChannelBatchRecord["state"],
		usd: number,
		draft: ChannelDraftRecord | undefined,
		from: ChannelBatchRecord["state"] = "accepted",
	): boolean {
		const now = this.now();
		return this.journal(name).update(now, (journal) => {
			const batch = journal.batches.find((entry) => entry.id === batchId);
			if (!batch || batch.state !== from) return false;
			batch.state = state;
			if (usd > 0) batch.usd = (batch.usd ?? 0) + usd;
			if (draft && !journal.drafts.some((entry) => entry.id === draft.id)) journal.drafts.push(draft);
			if (state === "unanswered" && this.deps.away)
				recordGap(journal, {
					id: digest(`${name}:unanswered-away:${batchId}`).slice(0, 16),
					reason: "unanswered",
					count: 1,
					at: now,
					away: true,
				});
			return true;
		}).result;
	}

	private keepDraft(
		name: string,
		batch: ChannelBatchRecord,
		text: string,
		reason: string,
		usd: number,
		from: ChannelBatchRecord["state"] = "accepted",
	): void {
		const draft: ChannelDraftRecord = {
			id: digest(`draft:${name}:${batch.id}`).slice(0, 10),
			batchId: batch.id,
			conversationKey: batch.conversationKey,
			address: batch.address,
			text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)} [cut by the harness]` : text,
			reason,
			createdAt: this.now(),
			state: "pending",
			...(this.deps.away ? { away: true as const } : {}),
		};
		if (!this.settleBatch(name, batch.id, "drafted", usd, draft, from)) return;
		this.deps.observeNotice("channel-reply", () => ({
			scope: `${name}:${batch.id}`,
			state: {
				reason: `draft:${name}:${draft.id}`,
				text: `Channel ${name}: a reply waits as draft ${draft.id} (${reason}). The channel_reply tool sends or dismisses it.`,
			},
		}));
	}

	/** The channels with an explicit policy and a valid name, with the policy each runs under. */
	private explicitChannels(): [string, ResolvedChannelPolicy][] {
		const channels: [string, ResolvedChannelPolicy][] = [];
		for (const [name, resolution] of this.deps.getChannelPolicies())
			if (resolution.kind === "policy" && resolution.policy.mode === "explicit" && isValidChannelName(name))
				channels.push([name, resolution.policy]);
		return channels;
	}

	/** The pending reply drafts of every channel with an explicit policy. */
	listDrafts(): ChannelDraftView[] {
		const views: ChannelDraftView[] = [];
		for (const [name] of this.explicitChannels()) {
			for (const draft of this.journal(name).read().result.drafts)
				if (draft.state === "pending")
					views.push({
						id: draft.id,
						channel: name,
						reason: draft.reason,
						createdAt: new Date(draft.createdAt).toISOString(),
						text: draft.text,
					});
		}
		return views;
	}

	/** Verified senders held in the last 24 hours whose id the owner notice could not name, because the sender chose it. */
	listHeldSenders(): ChannelHeldSenderView[] {
		const now = this.now();
		const views: ChannelHeldSenderView[] = [];
		for (const [name] of this.explicitChannels())
			for (const entry of this.journal(name).read().result.onboarding)
				if (entry.id !== undefined && now - entry.at < DAY_MS)
					views.push({ channel: name, id: entry.id, heldAt: new Date(entry.at).toISOString() });
		return views;
	}

	/**
	 * What each channel with an explicit policy has used of its daily bounds and holds undelivered, from its journal.
	 * Reads only, and carries no third party's text.
	 */
	readJournalSummaries(): ChannelJournalSummary[] {
		const now = this.now();
		const sessionId = this.sessionId();
		return this.explicitChannels().map(([name, policy]) => {
			const state = this.journal(name).read().result;
			const usage = channelDayUsage(state, now);
			return {
				name,
				wakes: { used: usage.wakes, max: policy.maxWakesPerDay },
				spendUsd: { used: usage.usd, max: policy.maxUsdPerDay },
				pendingMessages: state.pending.length,
				pendingDrafts: state.drafts.filter((draft) => draft.state === "pending").length,
				heldTotal: state.heldTotal,
				gaps: state.gaps.length,
				servedBy: channelServedBy(state.holder, sessionId),
				awayDrafts: state.drafts.filter((draft) => draft.away === true && draft.state === "pending").length,
			};
		});
	}

	/** Send a pending draft to the address its conversation came from, or dismiss it. Throws a plain reason. */
	async settleDraft(id: string, action: "send" | "dismiss"): Promise<string> {
		const found = this.listDrafts().find((draft) => draft.id === id);
		if (!found) throw new Error(`No pending reply draft ${id}.`);
		const name = found.channel;
		const journal = this.journal(name);
		const { result: draft } = journal.update(this.now(), (state) => {
			const entry = state.drafts.find((candidate) => candidate.id === id && candidate.state === "pending");
			return entry ? { ...entry } : undefined;
		});
		if (!draft) throw new Error(`No pending reply draft ${id}.`);
		if (action === "send") {
			const provider = this.registry.getChannel(name);
			if (!provider || this.runtime(name).state === "stopped" || !this.runtime(name).holding)
				throw new Error(`Channel ${name} is not running in this session; the draft is kept.`);
			const formatted = formatChannelReply(draft.text, provider.capabilities);
			if (!formatted.ok)
				throw new Error(`The draft cannot be sent: it is ${formatted.reason.replaceAll("_", " ")}.`);
			await this.sendParts(
				provider,
				{ conversationKey: draft.conversationKey, address: draft.address, id: draft.batchId },
				formatted.parts,
			);
		}
		journal.update(this.now(), (state) => {
			const entry = state.drafts.find((candidate) => candidate.id === id);
			if (entry) {
				entry.state = action === "send" ? "sent" : "dismissed";
				entry.settledAt = this.now();
			}
		});
		this.scheduleWork();
		return action === "send" ? `Sent draft ${id} to its conversation on ${name}.` : `Dismissed draft ${id}.`;
	}
}
