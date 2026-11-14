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
 *
 * The owner channel (`ownerSenders`, `owner-channel.ts`) is the one exception, and only while the session wiring hands
 * in its three owner dependencies: a message `ownerAdmission` admits is the owner's words. A control word among them
 * (`owner-control.ts`) is answered here and never becomes a turn; any other is delivered as an owner turn through
 * `ownerDelivery`, under the channel's owner spend pool and a `live` closure, and its answer goes back to that private
 * chat. Without `ownerSenders` or without the wiring, every path is the third-party one above. The owner's chat is
 * pushed what concerns its own turns (`owner-push.ts`: held drafts, the bounds, stops and held answers) and the calls
 * that wait on the owner in a session (`owner-waiting-notices.ts`).
 */

import { harnessLog } from "../../kernel/harness-log.ts";
import { claimThenEffect } from "../../kernel/outbox.ts";
import type { SessionManager } from "../../kernel/session/session-manager.ts";
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
import { SYSTEM_TIMER_PORT, type TimerPort } from "../util/timer-port.ts";
import { type ChannelServedBy, channelServedBy } from "./away-channels.ts";
import { type BatchOutcome, readBatchOutcome } from "./batch-outcome.ts";
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
	isDraftOpen,
	isUntoldEmpty,
	MAX_OWNER_CONVERSATIONS,
	MAX_PENDING_MESSAGES,
	markTold,
	PENDING_EXPIRY_MS,
	recordGap,
	untoldRecords,
} from "./channel-journal.ts";
import {
	composeChannelBatch,
	composeOwnerBatch,
	formatChannelReply,
	type InboundChannelEvent,
	isAdmittedKind,
	MAX_REPLY_CHARS,
	parseInboundChannelEvent,
	plainLabel,
} from "./channel-message.ts";
import { type ChannelPolicyResolution, isValidChannelName, type ResolvedChannelPolicy } from "./channel-policy.ts";
import { JournalDirWatch } from "./journal-dir-watch.ts";
import {
	listedOwnerDigests,
	ownerAdmission,
	ownerAuthority,
	ownerLiveCheck,
	ownerRoom,
	ownerSenderDigest,
	policyFingerprint,
	senderListed,
} from "./owner-channel.ts";
import type {
	OwnerChannelControl,
	OwnerChannelOrigin,
	OwnerControl,
	OwnerDecisionBy,
	OwnerDraftView,
	OwnerQuotaAllowance,
	SessionChannelsOwnerDeps,
} from "./owner-channel-types.ts";
import {
	approvalTurnText,
	classLabels,
	decideOwnerDraft,
	draftInScope,
	MAX_STATUS_DRAFTS,
	parseOwnerControl,
	presentDraft,
} from "./owner-control.ts";
import { channelStateNotice, nameableSenderId, quotaStatusLine, senderNoticeText } from "./owner-notice-text.ts";
import { OwnerPush } from "./owner-push.ts";
import { OwnerWaitingNotices, waitingStatusLine } from "./owner-waiting-notices.ts";
import { sendReplyParts } from "./reply-parts.ts";

/** The daemon's drafts one summary of what it left names by id and reason; the rest are counted. */
const MAX_NAMED_AWAY_DRAFTS = 3;
/** Pending drafts per channel; past it the channel delivers nothing new until the owner sends or dismisses some. */
const MAX_PENDING_DRAFTS = 32;
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

/** Whether a draft's claimed send is still in flight: the session that claimed it still runs in its process. */
function sendInFlight(draft: ChannelDraftRecord): boolean {
	const by = draft.sendingBy;
	return draft.state === "sending" && by !== undefined && sessionLive(by.sessionId, by.pid);
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
	| {
			readonly kind: "deliver";
			readonly batch: readonly ChannelPendingMessage[];
			readonly batchId: string;
			readonly owner: boolean;
	  };
/** Not-yet-shown drafts one `status` presents again. */
const MAX_STATUS_PRESENTATIONS = 3;
/** The longest control reply: a status lists at most `MAX_STATUS_DRAFTS` drafts by id and class. */
const MAX_CONTROL_REPLY_CHARS = 1500;

/** An owner turn this session offered or runs: its `live` closure, its spend observer, whether it was stopped. */
interface OwnerRun {
	readonly name: string;
	readonly live: () => boolean;
	accepted: boolean;
	stopped: boolean;
	unobserve?: () => void;
}

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
	/**
	 * Dollars the channel's owner pool holds over the last 24 hours against `ownerMaxUsdPerDay` (`owner-channel.ts`);
	 * only while the policy lists owner senders.
	 */
	readonly ownerSpendUsd?: { readonly used: number; readonly max: number };
	/** Present while the policy lists owner senders and sets `ownerAuthority: "full"`. */
	readonly ownerFullAuthority?: true;
	/** Present while the dollar bounds are lifted: the highest usage window of the subscription, in percent. */
	readonly ownerQuotaUsedPercent?: number;
}

/** One reply draft as the owner's release tool lists it. */
export interface ChannelDraftView {
	readonly id: string;
	readonly channel: string;
	readonly reason: string;
	readonly createdAt: string;
	readonly text: string;
	/**
	 * `waiting`: nothing claimed it. `sending`: a settle is sending it now. `unknown`: a send was claimed and its session
	 * ended before it recorded the outcome, so the message may or may not have reached its conversation.
	 */
	readonly status: "waiting" | "sending" | "unknown";
}

/** A verified, not allowlisted sender whose id the sender chose, as the owner's release tool lists it (fenced). */
export interface ChannelHeldSenderView {
	readonly channel: string;
	readonly id: string;
	readonly heldAt: string;
}

/** What a session exposes: a deployment wrapper registers providers and reads their states; it never starts them. */
export type SessionChannelsView = Pick<SessionChannels, "registerChannel" | "registerScheduler" | "getStates">;

export interface SessionChannelsDeps extends SessionChannelsOwnerDeps {
	getAgentDir(): string;
	getSessionManager(): SessionManager;
	/** Where owner turns run when not in this session (the daemon's phone session); this session's own when omitted. */
	getOwnerSessionManager?(): Pick<SessionManager, "getBranch">;
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
	/** The clock of the one expiry alarm (`channel-expiry`); the system clock when omitted. */
	wakeTimers?: TimerPort;
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
	 * The watch on the journal directory of an open session while it follows a preempted host, wants a channel another
	 * session serves, or serves the owner's: a journal's change tells the drafts that host writes, takes a channel given
	 * up in another process at once, and sends a notice another session left for the owner. The daemon's host has its
	 * own watch (`away-channel-host.ts`).
	 */
	private readonly dirWatch = new JournalDirWatch({
		dir: () => channelsDir(this.deps.getAgentDir()),
		onChange: () => this.journalChanged(),
		onFailure: (reason) =>
			this.deps.warn(
				`Channels: the journal directory cannot be watched (${reason}); a channel another session gives up is taken at the next settings change, and what the daemon left is told at this session's next channel pass (its next turn, message or settings change).`,
			),
	});
	/** Updates to the owner's chats (`owner-push.ts`); pushes nothing without owner authority and the wiring. */
	readonly ownerPush: OwnerPush;
	/** The notices of the calls that wait on the owner in the session hosting their work (`owner-waiting-notices.ts`). */
	private readonly waitingNotices: OwnerWaitingNotices;
	/** Owner turns this session offered or runs, by batch id (`ref`). */
	private readonly ownerRuns = new Map<string, OwnerRun>();
	/** The held-draft subscription and the control handle it is on. */
	private draftSubscription: { readonly control: OwnerChannelControl; readonly unsubscribe: () => void } | undefined;
	/** The owner-authority notice each channel shows now (`ownerNotice`), so an unchanged state observes nothing. */
	private readonly ownerNotices = new Map<string, string>();
	/** The one alarm for the earliest time a held item expires or a bound lifts (`armWake`); none while nothing is due. */
	private wake: { readonly at: number; readonly handle: unknown } | undefined;

	constructor(deps: SessionChannelsDeps) {
		this.deps = deps;
		this.ownerPush = new OwnerPush({
			journal: (name) => this.journal(name),
			provider: (name) => this.registry.getChannel(name),
			ownerPolicy: (name) => this.ownerPolicy(name),
			ownerChannels: () => [...deps.getChannelPolicies().keys()].filter((name) => this.ownerPolicy(name)),
			serves: (name) => {
				const runtime = this.runtimes.get(name);
				return runtime?.holding === true && (runtime.state === "armed" || runtime.state === "capped");
			},
			now: () => this.now(),
			warn: (message) => deps.warn(message),
		});
		this.waitingNotices = new OwnerWaitingNotices({
			push: this.ownerPush,
			waiting: () => deps.ownerControl?.()?.waiting(),
			timers: deps.wakeTimers ?? SYSTEM_TIMER_PORT,
			warn: (message) => deps.warn(message),
		});
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

	/** The session wiring handed in all three owner dependencies; an absent one fails closed (third-party path). */
	private ownerWired(): boolean {
		return (
			this.deps.ownerDelivery !== undefined &&
			this.deps.ownerControl !== undefined &&
			this.deps.isEmergencyStopEngaged !== undefined
		);
	}

	/** The channel's policy while it carries owner authority in this session: wired, shipped, platform ids, listed. */
	private ownerPolicy(name: string): ResolvedChannelPolicy | undefined {
		if (!this.started || !this.ownerWired()) return undefined;
		const policy = this.policy(name);
		return policy && ownerAuthority(this.registry.getChannel(name), policy) ? policy : undefined;
	}

	/** Engaged, or not known (no probe, or the probe failed): no owner turn starts. */
	private emergencyStopEngaged(): boolean {
		try {
			return this.deps.isEmergencyStopEngaged?.() ?? true;
		} catch {
			return true;
		}
	}

	/**
	 * What the subscription the session's model runs on allows now, for the owner pool's dollar bounds: the single reading
	 * every decision below uses. Unknown (no reading, not a subscription login, the bypass off, a throw) keeps the bounds.
	 */
	private ownerQuota(policy: ResolvedChannelPolicy): OwnerQuotaAllowance {
		if (policy.ownerQuotaMaxUsedPercent <= 0)
			return { kind: "unknown", reason: "the subscription bypass is off", subscription: false };
		try {
			return (
				this.deps.ownerDelivery?.quotaAllowance?.(policy.ownerQuotaMaxUsedPercent) ?? {
					kind: "unknown",
					reason: "this session reads no subscription usage",
					subscription: false,
				}
			);
		} catch {
			return { kind: "unknown", reason: "the subscription usage could not be read", subscription: true };
		}
	}

	/** Why no owner turn of the channel may start now; undefined when one may. Reads the journal state it is given. */
	private ownerTurnRefusal(name: string, policy: ResolvedChannelPolicy, state: ChannelJournalState, now: number) {
		if (!this.ownerPolicy(name)) return "owner authority is off for this channel in this session";
		if (this.emergencyStopEngaged()) return "the emergency stop is engaged";
		if (policy.ownerMaxUsdPerDay === 0) return `owner turns are off (channels.${name}.ownerMaxUsdPerDay is 0)`;
		const room = ownerRoom(name, state, policy, now, this.ownerQuota(policy).kind === "room");
		return room.fits
			? undefined
			: `$${room.usedUsd.toFixed(2)} of channels.${name}.ownerMaxUsdPerDay ($${policy.ownerMaxUsdPerDay.toFixed(2)}) is held in the last 24 hours`;
	}

	/** The closure an owner turn's every guarded call asks (`ownerLiveCheck`). */
	private ownerLive(name: string, senderDigest: string, policy: ResolvedChannelPolicy): () => boolean {
		return ownerLiveCheck({
			channel: name,
			senderDigest,
			fingerprint: policyFingerprint(policy),
			getPolicy: () => this.deps.getChannelPolicies().get(name),
			getProvider: () => this.registry.getChannel(name),
			...(this.deps.isEmergencyStopEngaged
				? { isEmergencyStopEngaged: () => this.deps.isEmergencyStopEngaged?.() ?? true }
				: {}),
			isServing: () => this.started && !this.deps.isDisposed() && this.ownerWired(),
		});
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
			// A call that starts waiting on the owner is written to the session before anything else tells of it.
			this.deps.getSessionManager().onEntriesPersisted(() => this.waitingNotices.touch()),
		);
		// Engaged, the pass stops the owner runs (the kill switches); lifted, it offers the owner messages that waited.
		if (this.deps.subscribeEmergencyStop)
			this.unsubscribes.push(this.deps.subscribeEmergencyStop(() => this.onActivity()));
		this.syncOwnerSubscription();
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
		this.draftSubscription?.unsubscribe();
		this.draftSubscription = undefined;
		// Their `live` closures answer false from here on (`isServing`); the runs themselves are aborted.
		for (const [ref, run] of this.ownerRuns) this.stopOwnerRun(ref, run, undefined);
		this.transcriptWait?.();
		this.transcriptWait = undefined;
		this.clearWake();
		this.waitingNotices.stop();
		this.followed.clear();
		this.syncDirWatch();
		await this.registry.stop();
		if (!wasStarted) return;
		for (const [name, runtime] of this.runtimes) {
			if (this.deps.away) this.settleOnClose(name);
			if (runtime.holding) this.releaseHold(name);
			if (runtime.state !== "stopped")
				harnessLog.info("channels", "a channel stopped", { channel: name, from: runtime.state });
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
				const outcome = readBatchOutcome(this.deps, name, batch, now);
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
		const notice = channelStateNotice(name, state, detail, {
			connectionLost: detail !== undefined && runtime.connection === detail,
			builtIn: this.builtIns.has(name),
		});
		this.deps.observeNotice("channel-state", () => ({ scope: name, state: notice ?? "clear" }));
		const fields = { channel: name, state, reason: detail };
		if (state === "suspended" || state === "invalid" || state === "capped")
			harnessLog.warn("channels", "a channel changed to a degraded state", fields);
		else harnessLog.info("channels", "a channel changed state", fields);
		this.syncDirWatch();
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
		this.ownerNotice(name, undefined);
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

	/**
	 * Open the journal directory's watch while this open session follows a host, waits for a channel, or serves one that
	 * carries owner authority (another session may leave the owner a notice there); else close it.
	 */
	private syncDirWatch(): void {
		const watched = ([name, runtime]: [string, ChannelRuntime]) =>
			runtime.state === "served_elsewhere" || (runtime.holding && this.ownerPolicy(name) !== undefined);
		this.dirWatch.sync(
			this.started && !this.deps.away && (this.followed.size > 0 || [...this.runtimes].some(watched)),
		);
	}

	private journalChanged(): void {
		for (const [name, preempted] of this.followed) this.followStep(name, preempted);
		// Admission reads the journal before it locks it, so a channel still served elsewhere costs no write here.
		if ([...this.runtimes.values()].some((runtime) => runtime.state === "served_elsewhere"))
			void this.registry.refreshChannels();
		// A notice another session left for the owner is sent by the session that serves the channel.
		for (const name of this.runtimes.keys()) void this.ownerPush.drain(name);
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

	/** The policies changed outside the settings files (a hub was joined or left): read them again. */
	reload(): void {
		this.onSettingsChanged();
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
			// The owner kill switches: a turn whose authority lapsed (policy changed or gone, sender unlisted, transport
			// replaced, emergency stop engaged) is aborted at the first pass that sees it.
			this.syncOwnerSubscription();
			for (const [ref, run] of this.ownerRuns)
				if (!run.stopped && !run.live()) this.stopOwnerRun(ref, run, "authority");
			for (const [name, runtime] of this.runtimes) {
				if (!runtime.holding && !runtime.draining) continue;
				// A channel whose policy went mid-turn still routes that turn: its answer becomes a draft.
				const policy = this.policy(name);
				if (runtime.holding) this.ownerNotice(name, policy);
				const waiting = await this.routeReplies(name, policy);
				if (!runtime.holding || !policy) {
					if (!waiting && !runtime.offering) runtime.draining = false;
					continue;
				}
				if (runtime.state === "armed" || runtime.state === "capped") this.deliverNext(name, policy);
				this.tellUntold(name);
				void this.ownerPush.drain(name);
			}
			this.waitingNotices.touch();
		} catch (error) {
			this.deps.warn(`Channel delivery failed: ${error instanceof Error ? error.message : String(error)}`);
		} finally {
			this.routing = false;
			if (this.rerun) this.scheduleWork();
			this.armWake();
			this.syncDirWatch();
		}
	}

	private clearWake(): void {
		if (!this.wake) return;
		(this.deps.timers ?? SYSTEM_TIMER_PORT).clearTimeout(this.wake.handle);
		this.wake = undefined;
	}

	/**
	 * The earliest future moment a held item of a channel this session serves needs another pass without any event
	 * arriving: a waiting message passing its day (it becomes a gap), and, while the channel holds new messages at its
	 * bound, the moment the oldest charge leaves the 24-hour window. A moment already past is left to the pass that
	 * follows the event which kept it (a pass cannot expire what its channel is not in a state to deliver).
	 */
	private nextWakeAt(now: number): number | undefined {
		let earliest: number | undefined;
		const consider = (at: number | undefined) => {
			if (at !== undefined && at > now && (earliest === undefined || at < earliest)) earliest = at;
		};
		for (const [name, runtime] of this.runtimes) {
			if (!runtime.holding || (runtime.state !== "armed" && runtime.state !== "capped")) continue;
			try {
				const state = this.journal(name).read().result;
				for (const entry of state.pending) consider(entry.admittedAt + PENDING_EXPIRY_MS);
				if (runtime.state !== "capped") continue;
				for (const batch of state.batches) if (batch.owner !== true) consider(batch.acceptedAt + DAY_MS);
				const policy = this.policy(name);
				if (policy && this.ownerPolicy(name))
					consider(ownerRoom(name, state, policy, now, this.ownerQuota(policy).kind === "room").oldestUntil);
			} catch (error) {
				harnessLog.warn("channels", "a channel journal could not be read for its expiry wake", {
					channel: name,
					reason: error instanceof Error ? error.message : String(error),
				});
			}
		}
		return earliest;
	}

	/**
	 * Keep one alarm on the schedule port for what `nextWakeAt` finds, re-armed after every pass (a pass is what changes
	 * the journal): it fires one more pass, which expires the message or finds the bound lifted, so a channel at rest
	 * needs no inbound event, activity or settings change to notice time passing, and nothing polls.
	 */
	private armWake(): void {
		if (!this.started) return;
		const now = this.now();
		const at = this.nextWakeAt(now);
		if (this.wake?.at === at) return;
		this.clearWake();
		if (at === undefined) return;
		const handle = (this.deps.wakeTimers ?? SYSTEM_TIMER_PORT).setTimeout(() => {
			if (this.wake?.handle !== handle) return;
			this.wake = undefined;
			harnessLog.debug("channels", "the expiry wake fired");
			this.onActivity();
		}, at - now);
		this.wake = { at, handle };
		harnessLog.debug("channels", "an expiry wake was armed", { inMs: at - now });
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
			harnessLog.warn("channels", "an inbound event could not be read; it is ignored", {
				channel: name,
				reason: parsed.reason,
			});
			return;
		}
		const event = parsed.event;
		const eventDigest = digest(event.eventId);
		const provider = this.registry.getChannel(name);
		const senderIds = provider?.senderIds;
		// The owner's ids are implied in the allowlist: without owner authority their messages are a third party's.
		const allowlisted = senderListed([...policy.allowedSenders, ...policy.ownerSenders], event.senderId, provider);
		const owner = this.ownerWired() && ownerAdmission(provider, event, policy);
		const control = owner ? parseOwnerControl(event.text) : undefined;
		const senderDigest = owner ? ownerSenderDigest(name, event.senderId, provider) : undefined;
		const namedId = nameableSenderId(name, event.senderId, senderIds);
		const update = journal.update(now, (state) => {
			if (state.seen.some((entry) => entry.d === eventDigest)) return "duplicate" as const;
			// Where the owner's updates go: each private chat an owner message came from, the latest kept.
			if (senderDigest !== undefined) {
				const others = (state.ownerConversations ?? []).filter(
					(conversation) => conversation.conversationKey !== event.conversationKey,
				);
				state.ownerConversations = [
					...others,
					{ conversationKey: event.conversationKey, address: event.address, senderDigest, at: now },
				].slice(-MAX_OWNER_CONVERSATIONS);
			}
			// A control word is answered by the harness and never waits for a turn; the seen record keeps it once.
			if (control) {
				state.seen.push({ d: eventDigest, at: now, outcome: "delivered" });
				return "control" as const;
			}
			const held = (reason: "unverified" | "not_allowed" | "burst") => {
				state.held.push({ sender: digest(event.senderId).slice(0, 16), kind: event.kind, reason, at: now });
				state.heldTotal++;
				state.seen.push({ d: eventDigest, at: now, outcome: "held" });
				harnessLog.info("channels", "an inbound message was held, not delivered", { channel: name, reason });
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
				const tell = !recent.some((entry) => entry.sender === sender) && recent.length < MAX_SENDER_NOTICES_PER_DAY;
				// An id the notice does not name is kept for the owner's `channel_reply` `list` until the entry ages out.
				if (tell)
					state.onboarding.push({ sender, at: now, ...(namedId === undefined ? { id: event.senderId } : {}) });
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
				...(owner ? { owner: true as const } : {}),
			};
			state.pending.push(pending);
			state.seen.push({ d: eventDigest, at: now, outcome: "pending" });
			return "pending" as const;
		});
		this.afterJournal(name, update.reset);
		if (update.result === "full") {
			harnessLog.warn("channels", "the channel journal is full; an inbound message is refused", {
				channel: name,
				pending: MAX_PENDING_MESSAGES,
			});
			this.deps.observeNotice("channel-state", () => ({
				scope: name,
				state: {
					reason: `${name}:full`,
					text: `Channel ${name} refuses new messages: ${MAX_PENDING_MESSAGES} wait undelivered. The provider is asked to deliver them again later.`,
				},
			}));
			throw new Error(`Channel ${name} journal is full.`);
		}
		if (update.result === "pending") {
			harnessLog.debug("channels", "an inbound message was admitted", { channel: name, owner });
			this.scheduleWork();
		}
		if (update.result === "tell_owner") this.noticeSender(name, event.senderId, namedId, now);
		// Answered past the provider's handler, which resolves once the journal holds the event.
		if (update.result === "control" && control && senderDigest !== undefined)
			queueMicrotask(() => void this.runOwnerControl(name, event, eventDigest, senderDigest, control));
	}

	/** Name at most a platform-assigned id and the key: never the sender's label, words or an id they chose. */
	private noticeSender(name: string, senderId: string, namedId: string | undefined, at: number): void {
		const sender = digest(senderId).slice(0, 16);
		this.deps.observeNotice("channel-sender", () => ({
			scope: `${name}:${sender}`,
			state: {
				reason: `sender:${name}:${sender}:${at}`,
				text: senderNoticeText(name, namedId),
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
		if (state.drafts.filter(isDraftOpen).length >= MAX_PENDING_DRAFTS)
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
		const waiting = state.pending.filter(
			(entry) => entry.kind === "message" && !elsewhere.has(entry.conversationKey),
		);
		if (waiting.length === 0) return { kind: "idle" };
		// Two pools: the third parties' bounds (and the away bound) never hold an owner message, the owner pool never a
		// third party's. An owner message whose sender is no longer listed waits and expires; it is never a third party's.
		const provider = this.registry.getChannel(name);
		const thirdPartyCap = waiting.some((entry) => entry.owner !== true)
			? (this.capReason(name, policy, state, now) ?? this.deps.away?.capReason(now))
			: undefined;
		const ownerWaiting = waiting.filter((entry) => entry.owner === true);
		const ownerCap = ownerWaiting.length > 0 ? this.ownerTurnRefusal(name, policy, state, now) : undefined;
		const ownerListed = (entry: ChannelPendingMessage) =>
			entry.verified === true && senderListed(policy.ownerSenders, entry.senderId, provider);
		const first = waiting.find((entry) =>
			entry.owner === true ? ownerCap === undefined && ownerListed(entry) : thirdPartyCap === undefined,
		);
		if (!first) {
			const cap =
				thirdPartyCap ??
				ownerCap ??
				`owner messages wait: their sender is not verified or no longer in channels.${name}.ownerSenders`;
			return { kind: "capped", cap };
		}
		const owner = first.owner === true;
		// One batch is one conversation and one authority: a forward from the owner's chat is never in an owner batch.
		const batch = state.pending
			.filter(
				(entry) =>
					entry.conversationKey === first.conversationKey &&
					(entry.owner === true) === owner &&
					(!owner || ownerListed(entry)),
			)
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
		return { kind: "deliver", batch: structuredClone(batch), batchId, owner };
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
		this.pushOwnerBound(name, policy, state, now);
		if (pick.kind === "capped") {
			if (runtime.state !== "capped" || runtime.detail !== pick.cap) this.setState(name, "capped", pick.cap);
			return;
		}
		if (runtime.state === "capped") this.setState(name, "armed");
		if (pick.kind !== "deliver") return;
		if (pick.owner) this.offerOwner(name, policy, pick.batch, pick.batchId);
		else this.offer(name, pick.batch, pick.batchId);
	}

	/**
	 * Tell the owner's chat, once per oldest charge, that owner messages wait at the owner pool's daily bound and when
	 * room returns; nothing while no owner message waits.
	 */
	private pushOwnerBound(name: string, policy: ResolvedChannelPolicy, state: ChannelJournalState, now: number): void {
		// An offered message is already a turn's: only messages the bound holds back count.
		const held = state.pending.some(
			(entry) => entry.owner === true && entry.kind === "message" && entry.offeredTo === undefined,
		);
		if (!this.ownerPolicy(name) || !held) return;
		const room = ownerRoom(name, state, policy, now, this.ownerQuota(policy).kind === "room");
		if (room.fits) return;
		const text =
			policy.ownerMaxUsdPerDay === 0
				? `Owner turns are off: channels.${name}.ownerMaxUsdPerDay is 0. Your messages wait up to 24 hours; approve needs a turn, deny, status and stop still answer.`
				: `Owner turns paused: $${room.usedUsd.toFixed(2)} of channels.${name}.ownerMaxUsdPerDay ($${policy.ownerMaxUsdPerDay.toFixed(2)}) is held in the last 24 hours; the oldest charge leaves the window at ${room.oldestUntil !== undefined ? new Date(room.oldestUntil).toISOString() : "its 24 hours' end"}. Your messages wait up to 24 hours; deny, status and stop still answer.`;
		void this.ownerPush.push(name, `bound:${room.oldestUntil ?? "off"}`, text);
	}

	/** Free the offer marks of a batch this session did not deliver. */
	private unmarkOffer(name: string, batchId: string, sessionId: string): void {
		try {
			this.journal(name).update(this.now(), (state) => {
				for (const entry of state.pending)
					if (entry.offeredBatch === batchId && entry.offeredTo === sessionId) clearOffer(entry);
			});
		} catch {
			// Left marked: the next delivery pass of the channel's holder frees it.
		}
	}

	/** The record of a batch the turn of `sessionId` (the session it was offered to) accepted; it answers `latest`. */
	private acceptedBatch(
		batchId: string,
		sessionId: string,
		latest: Pick<ChannelPendingMessage, "conversationKey" | "address">,
		eventDigests: readonly string[],
		allowlisted: boolean,
		now: number,
	): ChannelBatchRecord {
		return {
			id: batchId,
			sessionId,
			pid: process.pid,
			conversationKey: latest.conversationKey,
			address: latest.address,
			eventDigests: [...eventDigests],
			allowlisted,
			acceptedAt: now,
			state: "accepted",
			...(this.deps.away ? { away: true as const } : {}),
		};
	}

	/** Record an accepted batch: its messages leave the pending list as delivered, the batch is kept once. */
	private recordAccepted(name: string, batch: ChannelBatchRecord, now: number): void {
		const delivered = new Set(batch.eventDigests);
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
	}

	/** Hand the batch the journal marked offered to this session to the session; record it once accepted. */
	private offer(name: string, messages: readonly ChannelPendingMessage[], batchId: string): void {
		const runtime = this.runtime(name);
		const sessionId = this.sessionId();
		const delivered = messages.map((message) => message.eventDigest);
		const unmark = () => this.unmarkOffer(name, batchId, sessionId);
		const composed = composeChannelBatch(name, messages);
		const latest = messages[messages.length - 1];
		if (!latest || !isValidChannelName(name)) {
			unmark();
			return;
		}
		harnessLog.info("channels", "a turn was offered", { channel: name, messages: messages.length, batch: batchId });
		const sender = plainLabel(composed.senderLabel) || "unknown sender";
		runtime.offering = true;
		let answered = false;
		const onAccepted = (accepted: boolean) => {
			if (answered) return;
			answered = true;
			runtime.offering = false;
			if (!accepted) {
				unmark();
				harnessLog.warn("channels", "a turn was not accepted; it is offered again", {
					channel: name,
					batch: batchId,
				});
				this.deps.warn(`Channel ${name}: the session did not accept a delivery; it is offered again later.`);
				return;
			}
			const now = this.now();
			this.recordAccepted(
				name,
				this.acceptedBatch(batchId, sessionId, latest, delivered, composed.verified, now),
				now,
			);
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
	 * Hand an owner batch the journal marked offered to this session to the owner delivery: one header line and the
	 * owner's words, the owner-channel origin, and the `live` closure. Recorded once accepted, with its spend observed.
	 */
	private offerOwner(
		name: string,
		policy: ResolvedChannelPolicy,
		messages: readonly ChannelPendingMessage[],
		batchId: string,
	): void {
		const runtime = this.runtime(name);
		const sessionId = this.sessionId();
		const delivery = this.deps.ownerDelivery;
		const latest = messages[messages.length - 1];
		if (!delivery || !latest || !isValidChannelName(name)) {
			this.unmarkOffer(name, batchId, sessionId);
			return;
		}
		const provider = this.registry.getChannel(name);
		const senderDigest = ownerSenderDigest(name, latest.senderId, provider);
		const delivered = messages.map((message) => message.eventDigest);
		runtime.offering = true;
		this.deliverOwnerTurn(
			name,
			{ channel: name, senderDigest, ref: batchId, ...(policy.ownerFullAuthority ? { full: true as const } : {}) },
			composeOwnerBatch(name, messages),
			this.ownerLive(name, senderDigest, policy),
			false,
			(accepted) => {
				runtime.offering = false;
				if (!accepted) {
					this.unmarkOffer(name, batchId, sessionId);
					this.deps.warn(
						`Channel ${name}: the session did not accept an owner message; it is offered again later.`,
					);
					return false;
				}
				const now = this.now();
				const base = this.acceptedBatch(batchId, sessionId, latest, delivered, true, now);
				const quota = this.ownerQuota(policy).kind === "room" ? { quota: true as const } : {};
				this.recordAccepted(name, { ...base, owner: true, senderDigest, ...quota }, now);
				return true;
			},
		);
	}

	/**
	 * Deliver one owner turn (the owner's words, or the approval of the draft `approval`, whose request the run answers)
	 * and keep its run: `live` and the spend observer while it runs. `onAccepted` records it; its answer is routed like
	 * any batch's. A turn whose `live` already answers false when accepted is aborted at once.
	 */
	private deliverOwnerTurn(
		name: string,
		origin: OwnerChannelOrigin,
		text: string,
		live: () => boolean,
		approval: false | Pick<OwnerDraftView, "requestEntryId">,
		onAccepted: (accepted: boolean) => boolean,
	): void {
		const delivery = this.deps.ownerDelivery;
		if (!delivery) {
			onAccepted(false);
			return;
		}
		const run: OwnerRun = { name, live, accepted: false, stopped: false };
		this.ownerRuns.set(origin.ref, run);
		// A stop ends the ref's authority for good: a still-queued batch, guarded calls that raced the abort and later runs
		// that inherit the ref are refused at the edge.
		const guarded = () => !run.stopped && live();
		let answered = false;
		const accept = (accepted: boolean) => {
			if (answered) return;
			answered = true;
			const fields = { channel: name, ref: origin.ref, approval: approval !== false };
			if (accepted) harnessLog.info("channels", "an owner turn started", fields);
			else harnessLog.warn("channels", "an owner turn was not accepted", fields);
			if (!onAccepted(accepted)) {
				this.ownerRuns.delete(origin.ref);
				return;
			}
			run.accepted = true;
			try {
				run.unobserve = delivery.observeRunUsage(origin.ref, (usd) => this.onOwnerUsage(origin.ref, usd));
			} catch (error) {
				// Without its spend observer the turn has no per-turn bound: it is stopped.
				this.deps.warn(
					`Channel ${name}: an owner turn's spend cannot be observed (${error instanceof Error ? error.message : String(error)}); it is stopped.`,
				);
				this.stopOwnerRun(origin.ref, run, undefined);
				return;
			}
			// Stopped before its run existed: the earlier abort found nothing to end, so the run is ended now.
			if (run.stopped) {
				this.abortOwnerRun(origin.ref, name);
				// A stopped core routes nothing more: nothing would settle the batch that ends the observation.
				if (!this.started) run.unobserve?.();
			} else if (!run.live()) this.stopOwnerRun(origin.ref, run, "authority");
			this.scheduleWork();
		};
		try {
			if (approval) delivery.deliverApproval(text, origin, guarded, accept, approval.requestEntryId);
			else delivery.deliver(text, origin, guarded, accept);
		} catch (error) {
			this.deps.warn(
				`Channel ${name}: an owner turn was not delivered (${error instanceof Error ? error.message : String(error)}).`,
			);
			accept(false);
		}
	}

	/**
	 * The spend of an owner turn grew: past the per-turn bound, or with its authority gone, it is stopped. A stopped
	 * turn that still spends is aborted again: spend after the stop means the abort did not end it.
	 */
	private onOwnerUsage(ref: string, usd: number): void {
		const run = this.ownerRuns.get(ref);
		if (!run) return;
		if (run.stopped) {
			this.abortOwnerRun(ref, run.name);
			return;
		}
		const policy = this.policy(run.name);
		// Past the per-turn dollar bound a turn goes on only while the subscription has room; an exhausted one is told apart.
		const quota = policy && usd >= policy.ownerMaxUsdPerTurn ? this.ownerQuota(policy) : undefined;
		if (!policy || (quota && quota.kind !== "room"))
			this.stopOwnerRun(ref, run, quota?.kind === "exhausted" ? "quota" : "bound");
		else if (!run.live()) this.stopOwnerRun(ref, run, "authority");
	}

	private abortOwnerRun(ref: string, name: string): void {
		try {
			this.deps.ownerDelivery?.abortRun(ref);
		} catch (error) {
			this.deps.warn(
				`Channel ${name}: an owner turn could not be aborted (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
	}

	/**
	 * Abort an owner turn (or the run its offer would open). Its spend stays observed until its batch settles, so a run
	 * the abort missed is aborted again; the aborted turn settles unanswered with its spend when its outcome is routed.
	 * The owner's chat is told why, when it still holds owner authority.
	 */
	private stopOwnerRun(ref: string, run: OwnerRun, why: "bound" | "quota" | "authority" | "owner" | undefined): void {
		if (!run.stopped) {
			const fields = { channel: run.name, ref, reason: why ?? "the session stopped" };
			if (why === "bound" || why === "quota")
				harnessLog.warn("channels", "an owner turn was stopped at a spend bound", fields);
			else harnessLog.info("channels", "an owner turn was stopped", fields);
		}
		run.stopped = true;
		this.abortOwnerRun(ref, run.name);
		if (!this.started) {
			run.unobserve?.();
			this.ownerRuns.delete(ref);
		}
		const policy = this.policy(run.name);
		if (why === "bound" && policy)
			void this.ownerPush.push(
				run.name,
				`stopped:${ref}`,
				`Stopped: this turn reached its bound (channels.${run.name}.ownerMaxUsdPerTurn, $${policy.ownerMaxUsdPerTurn.toFixed(2)}).`,
			);
		if (why === "quota" && policy) {
			const quota = this.ownerQuota(policy);
			void this.ownerPush.push(
				run.name,
				`stopped:${ref}`,
				`Stopped: the subscription's usage reached its bound (${quota.kind === "exhausted" ? quota.reason : "its usage is no longer readable"}; channels.${run.name}.ownerQuotaMaxUsedPercent ${policy.ownerQuotaMaxUsedPercent}%).`,
			);
		}
		if (why === "authority" && this.emergencyStopEngaged())
			void this.ownerPush.push(run.name, `stopped:${ref}`, "Stopped: the emergency stop is engaged.");
		this.scheduleWork();
	}

	/** The owner turn of `ref` was settled: it is no longer kept. */
	private endOwnerRun(ref: string): void {
		const run = this.ownerRuns.get(ref);
		if (!run) return;
		run.unobserve?.();
		this.ownerRuns.delete(ref);
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
			const outcome = readBatchOutcome(this.deps, name, batch, now);
			if (outcome.kind === "waiting") {
				waiting = true;
				continue;
			}
			harnessLog.info("channels", "a turn finished", () => ({
				channel: name,
				batch: batch.id,
				owner: batch.owner === true,
				outcome: outcome.kind,
				usd: outcome.usd,
				...(outcome.kind === "unanswered" ? { reason: outcome.reason } : {}),
			}));
			if (batch.owner === true) {
				await this.routeOwnerReply(name, policy, batch, outcome);
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
			await this.deliverReply(name, batch, outcome.text, outcome.usd, provider, draftReason);
		}
		return waiting;
	}

	/**
	 * Keep a turn's answer as a draft for `draftReason`, or when it cannot be sent as is; otherwise mark the batch replied
	 * and send it, keeping it as a draft when sending fails. Whether it was kept as a draft without being sent.
	 */
	private async deliverReply(
		name: string,
		batch: ChannelBatchRecord,
		text: string,
		usd: number,
		provider: ChannelProvider | undefined,
		draftReason: string | undefined,
	): Promise<boolean> {
		const formatted = formatChannelReply(text, provider?.capabilities);
		const reason =
			draftReason ?? (formatted.ok ? undefined : `the reply is ${formatted.reason.replaceAll("_", " ")}`);
		if (reason || !formatted.ok || !provider) {
			this.keepDraft(name, batch, text, reason ?? "the channel is not running", usd);
			return true;
		}
		// Recorded before sending: a crash mid-send loses the reply rather than sending it twice.
		if (!this.settleBatch(name, batch.id, "replied", usd, undefined)) return false;
		let accepted: readonly string[] = [];
		try {
			await sendReplyParts(provider, batch, formatted.parts, [], (digests) => {
				accepted = digests;
			});
			harnessLog.info("channels", "a reply was sent", {
				channel: name,
				batch: batch.id,
				parts: formatted.parts.length,
			});
		} catch (error) {
			// Only a shipped transport's error is kept: its text is Pi's own words. A wrapper's may carry remote text,
			// and the reason reaches the owner's notices unfenced.
			const said = isShippedChannelProvider(provider)
				? boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error))
				: undefined;
			this.keepDraft(name, batch, text, said ? `sending failed: ${said}` : "sending failed", 0, "replied", accepted);
		}
		return false;
	}

	/**
	 * Settle an owner turn that ended. Its answer goes back to the owner's private chat whatever `replyMode` says, while
	 * the channel still holds owner authority for that sender; it waits as a draft when the policy went, the authority
	 * lapsed, the channel is not running or it cannot be sent as is, and when it looks like it holds a secret (the chat is
	 * told it waits). Marked replied before it is sent, as every reply is.
	 */
	private async routeOwnerReply(
		name: string,
		policy: ResolvedChannelPolicy | undefined,
		batch: ChannelBatchRecord,
		outcome: Exclude<BatchOutcome, { readonly kind: "waiting" }>,
	): Promise<void> {
		this.endOwnerRun(batch.id);
		if (outcome.kind === "unanswered") {
			if (!this.settleBatch(name, batch.id, "unanswered", outcome.usd, undefined)) return;
			this.deps.observeNotice("channel-reply", () => ({
				scope: `${name}:${batch.id}`,
				state: {
					reason: `unanswered:${name}:${batch.id}`,
					text: `Channel ${name}: an owner message got no reply (${outcome.reason.replaceAll("_", " ")}).`,
				},
			}));
			// An aborted turn was stopped by its bound, a kill switch or `stop`: each tells the chat itself. A turn an
			// approval turn of the same channel joined goes on in that turn, whose answer the chat gets.
			if (outcome.reason !== "aborted" && outcome.reason !== "owner_channel_joined")
				void this.ownerPush.push(
					name,
					`unanswered:${batch.id}`,
					`Your message got no answer (${outcome.reason.replaceAll("_", " ")}).`,
				);
			return;
		}
		const provider = this.registry.getChannel(name);
		const ownerPolicy = this.ownerPolicy(name);
		const secret = hasMaskableSecretText(outcome.text);
		const draftReason = !policy
			? "the channel's policy was removed"
			: !ownerPolicy ||
					batch.senderDigest === undefined ||
					!listedOwnerDigests(name, ownerPolicy, provider).has(batch.senderDigest)
				? "the owner authority of the channel is off"
				: secret
					? "the reply contains a secret-shaped value"
					: !provider || (this.runtime(name).state !== "armed" && this.runtime(name).state !== "capped")
						? "the channel is not running"
						: undefined;
		const drafted = await this.deliverReply(name, batch, outcome.text, outcome.usd, provider, draftReason);
		if (drafted && secret)
			void this.ownerPush.push(
				name,
				`held:${batch.id}`,
				"Answer held: it looks like it contains a secret; read it at the terminal (channel_reply).",
			);
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
		accepted: readonly string[] = [],
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
			...(accepted.length > 0 ? { deliveredParts: [...accepted] } : {}),
		};
		if (!this.settleBatch(name, batch.id, "drafted", usd, draft, from)) return;
		const fields = { channel: name, draft: draft.id, reason };
		if (from === "replied") harnessLog.warn("channels", "a reply that failed to send waits as a draft", fields);
		else harnessLog.info("channels", "a reply waits as a draft", fields);
		this.deps.observeNotice("channel-reply", () => ({
			scope: `${name}:${batch.id}`,
			state: {
				reason: `draft:${name}:${draft.id}`,
				text: `Channel ${name}: a reply waits as draft ${draft.id} (${reason}). The channel_reply tool sends or dismisses it.`,
			},
		}));
	}

	/**
	 * Tell the owner once that listed owner senders hold no authority: the transport cannot verify them (not the shipped
	 * Telegram or Slack one), or this session cannot host owner turns (the wiring is absent). Cleared when either is fixed
	 * or the list is emptied; an unchanged state observes nothing.
	 */
	private ownerNotice(name: string, policy: ResolvedChannelPolicy | undefined): void {
		const text =
			policy === undefined || policy.ownerSenders.length === 0
				? undefined
				: !ownerAuthority(this.registry.getChannel(name), policy)
					? `Channel ${name}: owner senders listed but the transport cannot verify them; owner authority is off.`
					: !this.ownerWired()
						? `Channel ${name}: owner senders listed but this session cannot host owner turns; owner authority is off.`
						: undefined;
		if ((this.ownerNotices.get(name) ?? "") === (text ?? "")) return;
		if (text) this.ownerNotices.set(name, text);
		else this.ownerNotices.delete(name);
		this.deps.observeNotice("channel-state", () => ({
			scope: `${name}:owner`,
			state: text ? { reason: `${name}:owner:${text}`, text } : "clear",
		}));
	}

	/** Hear the drafts the hosting session holds through its current control handle; re-subscribe when it changes. */
	private syncOwnerSubscription(): void {
		let control: OwnerChannelControl | undefined;
		try {
			control = this.started && this.ownerWired() ? this.deps.ownerControl?.() : undefined;
		} catch {
			control = undefined;
		}
		if (this.draftSubscription?.control === control) return;
		this.draftSubscription?.unsubscribe();
		this.draftSubscription = undefined;
		if (!control) return;
		try {
			const unsubscribe = control.onDraftHeld((view) => {
				queueMicrotask(() => void this.presentDraft(view));
			});
			this.draftSubscription = { control, unsubscribe };
		} catch (error) {
			this.deps.warn(
				`Channels: held drafts cannot be shown on the owner's chat (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
	}

	/** Show a draft an owner turn of a channel this session serves held, to the chat that turn came from. */
	private async presentDraft(view: OwnerDraftView): Promise<void> {
		const ref = view.origin.ref;
		if (!this.started || ref === undefined) return;
		for (const [name, runtime] of this.runtimes) {
			if (!runtime.holding || view.origin.k !== "owner-channel" || view.origin.channel !== name) continue;
			const policy = this.ownerPolicy(name);
			const batch = policy
				? this.journal(name)
						.read()
						.result.batches.find((entry) => entry.id === ref && entry.owner === true)
				: undefined;
			// Shown only to the identity whose message opened the run, in the chat that message came from.
			if (!policy || batch?.senderDigest === undefined) continue;
			await this.ownerPush.present(
				name,
				view.id,
				presentDraft(view, policy.ownerTerminalOnlyClasses),
				batch.conversationKey,
				batch.senderDigest,
				true,
			);
		}
	}

	/** The sender digest of each owner batch of the channel by its id (the ref of the turn it opened). */
	private ownerOpeners(name: string): (ref: string) => string | undefined {
		const batches = this.journal(name).read().result.batches;
		return (ref) => batches.find((batch) => batch.id === ref && batch.owner === true)?.senderDigest;
	}

	/** Answer one owner control word; it never becomes a turn. Replies go to the chat it came from. */
	private async runOwnerControl(
		name: string,
		event: InboundChannelEvent,
		eventDigest: string,
		senderDigest: string,
		control: OwnerControl,
	): Promise<void> {
		const policy = this.started ? this.policy(name) : undefined;
		const provider = this.registry.getChannel(name);
		if (!policy || !provider) return;
		const reply = (text: string, key: string) => this.sendControlReply(name, provider, event, key, text, true);
		try {
			if (control.kind === "status") {
				const status = this.ownerStatus(name, policy, event.conversationKey, senderDigest);
				await reply(status.reply, eventDigest);
				for (const view of status.present)
					await this.ownerPush.present(
						name,
						view.id,
						presentDraft(view, policy.ownerTerminalOnlyClasses),
						event.conversationKey,
						senderDigest,
						false,
					);
				return;
			}
			if (control.kind !== "approve" && control.kind !== "deny") {
				await reply(this.stopOwnerTurns(name), eventDigest);
				return;
			}
			// The approval turn's ref is fixed before the decision: the gate binds the approval to it.
			const ref = digest(`${name}:approval:${control.draftId}:${eventDigest}`).slice(0, 24);
			const by: OwnerDecisionBy = { channel: name, senderDigest, ref, eventDigest };
			let handle: OwnerChannelControl | undefined;
			try {
				handle = this.deps.ownerControl?.();
			} catch {
				handle = undefined;
			}
			const result = decideOwnerDraft(control, {
				channel: name,
				control: handle,
				by,
				terminalOnlyClasses: policy.ownerTerminalOnlyClasses,
				openerOf: this.ownerOpeners(name),
				presentedAt: (draftId) => this.ownerPush.presentedAt(name, draftId, event.conversationKey),
				receivedAt: event.receivedAt,
				turnRefusal: () => this.ownerTurnRefusal(name, policy, this.journal(name).read().result, this.now()),
				approvalRunning: (draftId) =>
					this.journal(name)
						.read()
						.result.batches.some((batch) => batch.approval === draftId && batch.state === "accepted"),
			});
			// An approval's reply waits for its turn: the delivery is started first and answers whether a turn runs it.
			if (result.approved)
				this.deliverOwnerApproval(name, policy, result.approved, by, event, eventDigest, result.reply);
			else await reply(result.reply, eventDigest);
		} catch (error) {
			this.deps.warn(
				`Channel ${name}: an owner control word was not carried out (${error instanceof Error ? error.message : String(error)}).`,
			);
		}
	}

	/**
	 * The approval turn of one draft: its own owner batch, recorded once accepted, and then `approvedReply` to the chat;
	 * a refusal lapses the approval and the chat is told so instead.
	 */
	private deliverOwnerApproval(
		name: string,
		policy: ResolvedChannelPolicy,
		view: OwnerDraftView,
		by: OwnerDecisionBy,
		event: InboundChannelEvent,
		eventDigest: string,
		approvedReply: string,
	): void {
		const provider = this.registry.getChannel(name);
		// The approval run re-issues the held call, so it runs under the channel's authority mode as the policy reads now.
		const origin: OwnerChannelOrigin = {
			channel: by.channel,
			senderDigest: by.senderDigest,
			ref: by.ref,
			...(policy.ownerFullAuthority ? { full: true } : {}),
		};
		const reply = (text: string) => {
			if (provider) void this.sendControlReply(name, provider, event, eventDigest, text);
		};
		this.deliverOwnerTurn(
			name,
			origin,
			approvalTurnText(name, view),
			this.ownerLive(name, by.senderDigest, policy),
			view,
			(accepted) => {
				if (!accepted) {
					reply(
						`No turn started for draft ${view.id}; the approval lapsed. Send approve ${view.id} to try once more while it is held.`,
					);
					return false;
				}
				const now = this.now();
				const batch: ChannelBatchRecord = {
					...this.acceptedBatch(by.ref, this.sessionId(), event, [eventDigest], true, now),
					owner: true,
					senderDigest: by.senderDigest,
					approval: view.id,
					...(this.ownerQuota(policy).kind === "room" ? { quota: true as const } : {}),
				};
				try {
					this.journal(name).update(now, (state) => {
						if (!state.batches.some((existing) => existing.id === batch.id)) state.batches.push(batch);
					});
				} catch (error) {
					this.deps.warn(
						`Channel ${name}: an approval turn was not recorded (${error instanceof Error ? error.message : String(error)}); its answer is not routed.`,
					);
				}
				reply(approvedReply);
				return true;
			},
		);
	}

	/** The `status` reply, and the held drafts not yet shown to this chat that it presents again. */
	private ownerStatus(
		name: string,
		policy: ResolvedChannelPolicy,
		conversationKey: string,
		senderDigest: string,
	): { readonly reply: string; readonly present: readonly OwnerDraftView[] } {
		const now = this.now();
		const state = this.journal(name).read().result;
		const quota = this.ownerQuota(policy);
		const room = ownerRoom(name, state, policy, now, quota.kind === "room");
		const refusal = this.ownerTurnRefusal(name, policy, state, now);
		const waiting = state.pending.filter(
			(entry) => entry.owner === true && entry.conversationKey === conversationKey,
		);
		const running = [...this.ownerRuns.values()].some((run) => run.name === name && run.accepted && !run.stopped);
		let drafts: readonly OwnerDraftView[] = [];
		let waitingLine: string | undefined;
		const openerOf = this.ownerOpeners(name);
		try {
			const control = this.deps.ownerControl?.();
			drafts = (control?.drafts() ?? []).filter(
				(view) => view.state === "pending" && draftInScope(view, name, senderDigest, openerOf),
			);
			waitingLine = waitingStatusLine(control?.waiting());
		} catch {
			// What was read stands: a list that could not be read is left out of the reply.
		}
		const shown = (view: OwnerDraftView) => this.ownerPush.presentedAt(name, view.id, conversationKey) !== undefined;
		const listed = drafts
			.slice(0, MAX_STATUS_DRAFTS)
			.map((view) => `${view.id} (${classLabels(view)}${shown(view) ? "" : ", not shown yet"})`);
		const more = drafts.length - listed.length;
		const suppressed = this.ownerPush.takeSuppressed(name);
		const quotaLine = quotaStatusLine(name, policy, quota);
		const lines = [
			`Owner spend: $${room.usedUsd.toFixed(2)} of $${policy.ownerMaxUsdPerDay.toFixed(2)} in 24 hours, $${policy.ownerMaxUsdPerTurn.toFixed(2)} per turn${refusal ? `; no new turn: ${refusal}` : ""}.`,
			...(quotaLine === undefined ? [] : [quotaLine]),
			`${running ? "A turn is running." : "No turn is running."} ${waiting.length} message(s) wait.`,
			listed.length > 0
				? `Held: ${listed.join("; ")}${more > 0 ? `; and ${more} more` : ""}.`
				: "No held action from this chat.",
			...(waitingLine === undefined ? [] : [waitingLine]),
			...(suppressed > 0
				? [`${suppressed} update(s) were not pushed under channels.${name}.ownerPushPerHour.`]
				: []),
		];
		return {
			reply: lines.join("\n"),
			present: drafts.filter((view) => !shown(view)).slice(0, MAX_STATUS_PRESENTATIONS),
		};
	}

	/** `stop`: abort the channel's running owner turns. */
	private stopOwnerTurns(name: string): string {
		let stopped = 0;
		for (const [ref, run] of this.ownerRuns)
			if (run.name === name && run.accepted && !run.stopped) {
				this.stopOwnerRun(ref, run, "owner");
				stopped++;
			}
		return stopped > 0 ? "Stopped the running turn." : "No turn is running.";
	}

	/** A control reply: Pi's own words, bounded, to the chat it came from, never a secret; `final` ends a hub's ask. */
	private async sendControlReply(
		name: string,
		provider: ChannelProvider,
		event: InboundChannelEvent,
		key: string,
		text: string,
		final = false,
	): Promise<void> {
		if (!text || hasMaskableSecretText(text)) return;
		const bounded = text.length > MAX_CONTROL_REPLY_CHARS ? `${text.slice(0, MAX_CONTROL_REPLY_CHARS - 1)}…` : text;
		try {
			await provider.send({
				conversationKey: event.conversationKey,
				address: event.address,
				text: bounded,
				kind: "message",
				eventId: `control:${digest(key).slice(0, 16)}`,
				...(final ? { final: true } : {}),
			});
		} catch (error) {
			const said = isShippedChannelProvider(provider)
				? boundedRedactedDiagnosticText(error instanceof Error ? error.message : String(error))
				: undefined;
			this.deps.warn(`Channel ${name}: a reply to an owner control word was not sent${said ? ` (${said})` : ""}.`);
		}
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
				if (isDraftOpen(draft))
					views.push({
						id: draft.id,
						channel: name,
						reason: draft.reason,
						createdAt: new Date(draft.createdAt).toISOString(),
						text: draft.text,
						status: draft.state === "pending" ? "waiting" : sendInFlight(draft) ? "sending" : "unknown",
					});
		}
		return views;
	}

	/** Verified senders held in the last 24 hours whose id the owner notice could not name, because the sender chose it. */
	listHeldSenders(): ChannelHeldSenderView[] {
		const now = this.now();
		const views: ChannelHeldSenderView[] = [];
		for (const [name, policy] of this.explicitChannels()) {
			const normalize = this.registry.getChannel(name)?.senderIds?.normalize ?? ((id: string) => id);
			const allowed = new Set([...policy.allowedSenders, ...policy.ownerSenders].map(normalize));
			// A sender the owner has added since is no longer held.
			for (const entry of this.journal(name).read().result.onboarding)
				if (entry.id !== undefined && now - entry.at < DAY_MS && !allowed.has(normalize(entry.id)))
					views.push({ channel: name, id: entry.id, heldAt: new Date(entry.at).toISOString() });
		}
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
			const quota: OwnerQuotaAllowance =
				policy.ownerSenders.length > 0
					? this.ownerQuota(policy)
					: { kind: "unknown", reason: "the channel lists no owner sender", subscription: false };
			return {
				name,
				wakes: { used: usage.wakes, max: policy.maxWakesPerDay },
				spendUsd: { used: usage.usd, max: policy.maxUsdPerDay },
				pendingMessages: state.pending.length,
				pendingDrafts: state.drafts.filter(isDraftOpen).length,
				heldTotal: state.heldTotal,
				gaps: state.gaps.length,
				servedBy: channelServedBy(state.holder, sessionId),
				awayDrafts: state.drafts.filter((draft) => draft.away === true && isDraftOpen(draft)).length,
				...(policy.ownerSenders.length > 0
					? {
							ownerSpendUsd: {
								used: ownerRoom(name, state, policy, now, quota.kind === "room").usedUsd,
								max: policy.ownerMaxUsdPerDay,
							},
							...(quota.kind === "room" ? { ownerQuotaUsedPercent: quota.usedPercent } : {}),
						}
					: {}),
				...(policy.ownerSenders.length > 0 && policy.ownerFullAuthority
					? { ownerFullAuthority: true as const }
					: {}),
			};
		});
	}

	/**
	 * Send a pending draft to the address its conversation came from, or dismiss it. Throws a plain reason.
	 *
	 * At most once: the draft is claimed in the journal (`sending`, under the journal's lock, only while it is still open
	 * and no live send holds it) before anything is sent, and the outcome is recorded after. A second settle finds the
	 * claim and is refused; a crash between the claim and the record leaves the claim, which reads as an unknown outcome
	 * (the message may have reached its conversation) and is never sent again unless the owner sends it again after
	 * seeing that. A send that fails with a transport error gives the claim back, as a failed reply stays a draft.
	 */
	async settleDraft(id: string, action: "send" | "dismiss"): Promise<string> {
		const found = this.listDrafts().find((draft) => draft.id === id);
		if (!found) throw new Error(`No pending reply draft ${id}.`);
		const name = found.channel;
		let send: { readonly provider: ChannelProvider; readonly parts: readonly string[] } | undefined;
		if (action === "send") {
			const provider = this.registry.getChannel(name);
			if (!provider || this.runtime(name).state === "stopped" || !this.runtime(name).holding)
				throw new Error(`Channel ${name} is not running in this session; the draft is kept.`);
			const formatted = formatChannelReply(found.text, provider.capabilities);
			if (!formatted.ok)
				throw new Error(`The draft cannot be sent: it is ${formatted.reason.replaceAll("_", " ")}.`);
			send = { provider, parts: formatted.parts };
		}
		if (!send) {
			const claim = this.claimDraft(name, id, action);
			harnessLog.info("channels", "a draft was dismissed", {
				channel: name,
				draft: id,
				interrupted: claim.interrupted,
			});
			this.scheduleWork();
			return `Dismissed draft ${id}.`;
		}
		const { provider, parts } = send;
		const run = await claimThenEffect({
			claim: () => {
				const claim = this.claimDraft(name, id, "send");
				harnessLog.info("channels", "a draft send was claimed", {
					channel: name,
					draft: id,
					repeatsInterrupted: claim.interrupted,
				});
				return claim;
			},
			effect: (claim) =>
				sendReplyParts(
					provider,
					{ conversationKey: claim.draft.conversationKey, address: claim.draft.address, id: claim.draft.batchId },
					parts,
					claim.draft.deliveredParts,
					(digests) =>
						this.journal(name).update(this.now(), (state) => {
							const entry = state.drafts.find((candidate) => candidate.id === id);
							if (entry?.state === "sending" && entry.sendingBy?.at === claim.draft.sendingBy?.at)
								entry.deliveredParts = [...digests];
						}),
				),
			release: (claim) => {
				harnessLog.warn("channels", "a draft send failed; the draft is kept", { channel: name, draft: id });
				this.journal(name).update(this.now(), (state) => {
					const entry = state.drafts.find((candidate) => candidate.id === id);
					// Only this settle's own claim is given back.
					if (entry?.state !== "sending" || entry.sendingBy?.at !== claim.draft.sendingBy?.at) return;
					if (claim.previous) entry.sendingBy = claim.previous;
					else {
						entry.state = "pending";
						delete entry.sendingBy;
					}
				});
			},
			onReleaseFailed: (error) => {
				this.deps.warn(
					`Channel ${name}: draft ${id} could not be released after a failed send (${error instanceof Error ? error.message : String(error)}); it shows as an unknown outcome.`,
				);
			},
			settle: () => {
				this.journal(name).update(this.now(), (state) => {
					const entry = state.drafts.find((candidate) => candidate.id === id);
					if (entry?.state !== "sending") return;
					entry.state = "sent";
					entry.settledAt = this.now();
					delete entry.sendingBy;
				});
			},
		});
		// claimDraft refuses by throwing and the claim above always returns a claim, so no skip can reach this point.
		if (run.kind === "skipped") throw new Error(`Draft ${id} was not claimed for sending.`);
		if (run.kind === "settle_unrecorded") {
			// Sent, but the journal kept the claim: it will read as an unknown outcome until the owner settles it.
			harnessLog.warn("channels", "a draft was sent but its outcome was not recorded", { channel: name, draft: id });
			return `Sent draft ${id} to its conversation on ${name}, but the journal could not record it (${run.error instanceof Error ? run.error.message : String(run.error)}); the draft will show as an unknown outcome. Dismiss it after checking the conversation.`;
		}
		harnessLog.info("channels", "a draft was sent", { channel: name, draft: id, parts: parts.length });
		this.scheduleWork();
		return `Sent draft ${id} to its conversation on ${name}.`;
	}

	/**
	 * Claim an open draft for `action` in one journal update: a dismiss settles it, a send marks it `sending` by this
	 * session and process. Refused when the draft is gone or another live send holds it. `interrupted` is whether an
	 * earlier send's claim was found whose session ended (its outcome unknown); `previous` is that claim.
	 */
	private claimDraft(
		name: string,
		id: string,
		action: "send" | "dismiss",
	): { draft: ChannelDraftRecord; interrupted: boolean; previous: ChannelDraftRecord["sendingBy"] } {
		const now = this.now();
		const claimed = this.journal(name).update(now, (state) => {
			const entry = state.drafts.find((candidate) => candidate.id === id && isDraftOpen(candidate));
			if (!entry) return "gone" as const;
			if (sendInFlight(entry)) return "busy" as const;
			const previous = entry.sendingBy;
			const interrupted = entry.state === "sending";
			if (action === "dismiss") {
				entry.state = "dismissed";
				entry.settledAt = now;
				delete entry.sendingBy;
			} else {
				entry.state = "sending";
				entry.sendingBy = { sessionId: this.sessionId(), pid: process.pid, at: now };
			}
			return { draft: { ...entry }, interrupted, previous };
		}).result;
		if (claimed === "gone") throw new Error(`No pending reply draft ${id}.`);
		if (claimed === "busy")
			throw new Error(`Draft ${id} is being sent right now; its outcome is recorded when that send ends.`);
		return claimed;
	}
}
