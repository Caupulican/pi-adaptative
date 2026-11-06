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

import type { SessionManager } from "../../kernel/session/session-manager.ts";
import type { AgentMessage } from "../../kernel/types.ts";
import type { SendUserMessageOptions } from "../extensions/types.ts";
import {
	type ChannelMessage,
	type ChannelProvider,
	type ChannelProviderStatus,
	GatewayRegistry,
	type JobSchedulerProvider,
	type LifecycleOutcome,
} from "../gateways/channel-provider.ts";
import type { HarnessNoticeKind, HarnessNoticeObservation } from "../harness-notice.ts";
import { isProcessAlive } from "../process-liveness.ts";
import { boundedRedactedDiagnosticText, hasMaskableSecretText } from "../security/secret-text.ts";
import { entryTurnOrigin, isDecisiveOrigin } from "../turn-origin.ts";
import { createBuiltInChannelProvider, isBuiltInChannel } from "./built-in-providers.ts";
import {
	type ChannelBatchRecord,
	type ChannelDraftRecord,
	ChannelJournal,
	type ChannelJournalState,
	type ChannelPendingMessage,
	channelDayUsage,
	DAY_MS,
	digest,
	MAX_PENDING_MESSAGES,
	PENDING_EXPIRY_MS,
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

/** Pending drafts per channel; past it the channel delivers nothing new until the owner sends or dismisses some. */
const MAX_PENDING_DRAFTS = 32;
/** A sender id the owner is told verbatim: plain, short, never prose (a notice enters the owner's turn unfenced). */
const PLAIN_SENDER_ID = /^[A-Za-z0-9._@+-]{1,64}$/;
/** New senders per channel the owner is told about in 24 hours, each once. */
const MAX_SENDER_NOTICES_PER_DAY = 3;

/** Sessions of this process that serve a channel: a holder with this process's pid is live only while listed here. */
const liveHolders = new Map<string, string>();
/** Sessions of this process serving channels: a channel one of them gives up is offered to the others at once. */
const startedSessions = new Set<SessionChannels>();

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
}

/** One reply draft as the owner's release tool lists it. */
export interface ChannelDraftView {
	readonly id: string;
	readonly channel: string;
	readonly reason: string;
	readonly createdAt: string;
	readonly text: string;
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
	observeNotice(kind: HarnessNoticeKind, read: () => HarnessNoticeObservation | undefined): void;
	warn(message: string): void;
	isDisposed(): boolean;
	isChildSession(): boolean;
	/** Rebuild the session's tools: the release tool is offered only while a channel has an explicit policy. */
	refreshTools?(): void;
	now?(): number;
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
	| { readonly kind: "waiting" }
	| { readonly kind: "answered"; readonly text: string; readonly usd: number }
	| { readonly kind: "unanswered"; readonly reason: string };

export class SessionChannels {
	private readonly deps: SessionChannelsDeps;
	private readonly registry: GatewayRegistry;
	private readonly runtimes = new Map<string, ChannelRuntime>();
	private readonly journals = new Map<string, ChannelJournal>();
	private readonly unsubscribes: (() => void)[] = [];
	private started = false;
	/** When this session started serving: gaps recorded before it were another session's to tell. */
	private startedAt = 0;
	private routing = false;
	private rerun = false;
	private drainQueued = false;
	/** Whether a channel had an explicit policy when the tools were last built for it. */
	private toolsOfferRelease = false;
	/** Shipped transports this session registered, by channel name. */
	private readonly builtIns = new Map<string, ChannelProvider>();
	/** Names a deployment wrapper registered: its provider wins over a shipped one. */
	private readonly wrapperNames = new Set<string>();

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
			} else if (this.runtimes.delete(name)) {
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

	/** Stop every provider and give up every channel this session serves. Bounded by the registry's lifecycle timeout. */
	async stop(): Promise<void> {
		const wasStarted = this.started;
		this.started = false;
		startedSessions.delete(this);
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
		await this.registry.stop();
		if (!wasStarted) return;
		for (const [name, runtime] of this.runtimes) {
			if (runtime.holding) this.releaseHold(name);
			runtime.state = "stopped";
			runtime.connection = undefined;
		}
	}

	private setState(name: string, state: ChannelRuntimeState, detail?: string): void {
		const runtime = this.runtime(name);
		runtime.state = state;
		runtime.detail = detail;
		const notice = this.stateNotice(name, state, detail);
		this.deps.observeNotice("channel-state", () => ({ scope: name, state: notice ?? "clear" }));
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

	private dropHold(name: string): false {
		const runtime = this.runtime(name);
		runtime.connection = undefined;
		if (runtime.holding) this.releaseHold(name);
		return false;
	}

	/**
	 * Record this session as the channel's serving session unless another live one holds it. A holder whose process is
	 * gone is replaced; batches it accepted and never answered become one gap (their turns are in its transcript).
	 */
	private takeHold(name: string): boolean {
		const sessionId = this.deps.getSessionManager().getSessionId();
		const journalPath = this.journal(name).path;
		const update = this.journal(name).update(this.now(), (state) => {
			const holder = state.holder;
			if (holder && holder.sessionId !== sessionId) {
				const live =
					holder.pid === process.pid
						? liveHolders.get(journalPath) === holder.sessionId
						: isProcessAlive(holder.pid);
				if (live) return false;
			}
			state.holder = { sessionId, pid: process.pid };
			let orphaned = 0;
			for (const batch of state.batches) {
				if (batch.state === "accepted" && batch.sessionId !== sessionId) {
					batch.state = "unanswered";
					orphaned++;
				}
			}
			if (orphaned > 0)
				state.gaps.push({
					id: digest(`${name}:unanswered:${sessionId}:${this.now()}`).slice(0, 16),
					reason: "unanswered",
					count: orphaned,
					at: this.now(),
				});
			return true;
		});
		this.afterJournal(name, update.reset);
		if (!update.result) return false;
		liveHolders.set(journalPath, sessionId);
		this.runtime(name).holding = true;
		return true;
	}

	private releaseHold(name: string): void {
		const runtime = this.runtime(name);
		runtime.holding = false;
		const journal = this.journal(name);
		if (liveHolders.get(journal.path) === this.deps.getSessionManager().getSessionId())
			liveHolders.delete(journal.path);
		try {
			const sessionId = this.deps.getSessionManager().getSessionId();
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
		for (const other of startedSessions)
			if (other !== this) queueMicrotask(() => void other.registry.refreshChannels());
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
		const shown = reason !== undefined && this.builtIns.has(name) ? boundedRedactedDiagnosticText(reason) : undefined;
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
			for (const [name, runtime] of this.runtimes) {
				if (!runtime.holding) continue;
				const policy = this.policy(name);
				if (!policy) continue;
				await this.routeReplies(name, policy);
				if (runtime.state === "armed" || runtime.state === "capped") this.deliverNext(name, policy);
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

	private noticeGaps(name: string, state: ChannelJournalState, since: number): void {
		for (const gap of state.gaps) {
			if (gap.at < since) continue;
			const text =
				gap.reason === "expired"
					? `Channel ${name}: ${gap.count} message(s) waited more than 24 hours and were dropped undelivered.`
					: gap.reason === "unanswered"
						? `Channel ${name}: ${gap.count} delivered conversation(s) got no reply (the turn ended without an answer for them, or the session that served them closed).`
						: `Channel ${name}: its journal could not be read and was replaced; messages and drafts it held are not delivered.`;
			this.deps.observeNotice("channel-gap", () => ({
				scope: `${name}:${gap.id}`,
				state: { reason: `gap:${name}:${gap.id}`, text },
			}));
		}
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
		const update = journal.update(now, (state) => {
			if (state.seen.some((entry) => entry.d === eventDigest)) return "duplicate" as const;
			const held = (reason: "unverified" | "not_allowed" | "burst") => {
				state.held.push({ sender: digest(event.senderId).slice(0, 16), kind: event.kind, reason, at: now });
				state.heldTotal++;
				state.seen.push({ d: eventDigest, at: now, outcome: "held" });
				return "held" as const;
			};
			if (!isAdmittedKind(event.kind)) {
				state.ignoredTotal++;
				state.seen.push({ d: eventDigest, at: now, outcome: "ignored" });
				return "ignored" as const;
			}
			if (!event.verified) return held("unverified");
			if (!policy.allowedSenders.includes(event.senderId)) {
				// The owner learns a verified sender's id from the harness, at most once a day per sender, a few a day.
				const sender = digest(event.senderId).slice(0, 16);
				const recent = state.onboarding.filter((entry) => now - entry.at < DAY_MS);
				const tell =
					PLAIN_SENDER_ID.test(event.senderId) &&
					!recent.some((entry) => entry.sender === sender) &&
					recent.length < MAX_SENDER_NOTICES_PER_DAY;
				if (tell) state.onboarding.push({ sender, at: now });
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
		if (update.result === "tell_owner") this.noticeSender(name, event.senderId, now);
	}

	/** Name only the plain id and the exact key: never the sender's label or words, which the sender chose. */
	private noticeSender(name: string, senderId: string, at: number): void {
		const sender = digest(senderId).slice(0, 16);
		this.deps.observeNotice("channel-sender", () => ({
			scope: `${name}:${sender}`,
			state: {
				reason: `sender:${name}:${sender}:${at}`,
				text: `Channel ${name} held a message from sender ${senderId}, who is not in channels.${name}.allowedSenders. To let them start turns, add "${senderId}" to that list.`,
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

	/** Deliver the conversation with the oldest waiting message as one third-party turn. */
	private deliverNext(name: string, policy: ResolvedChannelPolicy): void {
		const runtime = this.runtime(name);
		if (runtime.offering) return;
		const sessionId = this.deps.getSessionManager().getSessionId();
		const now = this.now();
		const update = this.journal(name).update(now, (state) => {
			const expired = state.pending.filter((entry) => now - entry.admittedAt >= PENDING_EXPIRY_MS);
			if (expired.length > 0) {
				const gone = new Set(expired.map((entry) => entry.eventDigest));
				state.pending = state.pending.filter((entry) => !gone.has(entry.eventDigest));
				for (const entry of state.seen) if (gone.has(entry.d)) entry.outcome = "expired";
				const messages = expired.filter((entry) => entry.kind === "message").length;
				if (messages > 0)
					state.gaps.push({
						id: digest(`${name}:expired:${[...gone].join(",")}`).slice(0, 16),
						reason: "expired",
						count: messages,
						at: now,
					});
			}
			// One turn per channel at a time: its reply is routed before the next batch is offered.
			if (state.batches.some((batch) => batch.state === "accepted" && batch.sessionId === sessionId))
				return { kind: "busy" as const, state: structuredClone(state) };
			// A bound holds messages; with none waiting there is nothing to hold and nothing to tell.
			const first = state.pending.find((entry) => entry.kind === "message");
			if (!first) return { kind: "idle" as const, state: structuredClone(state) };
			const cap = this.capReason(name, policy, state, now);
			if (cap) return { kind: "capped" as const, cap, state: structuredClone(state) };
			const batch = state.pending
				.filter((entry) => entry.conversationKey === first.conversationKey)
				.slice(0, policy.maxBatch);
			return { kind: "deliver" as const, batch, state: structuredClone(state) };
		});
		this.afterJournal(name, update.reset);
		this.noticeGaps(name, update.result.state, this.startedAt);
		const result = update.result;
		if (result.kind === "capped") {
			if (runtime.state !== "capped" || runtime.detail !== result.cap) this.setState(name, "capped", result.cap);
			return;
		}
		if (runtime.state === "capped") this.setState(name, "armed");
		if (result.kind !== "deliver") return;
		this.offer(name, result.batch);
	}

	private offer(name: string, messages: readonly ChannelPendingMessage[]): void {
		const runtime = this.runtime(name);
		const composed = composeChannelBatch(name, messages);
		const latest = messages[messages.length - 1];
		if (!latest || !isValidChannelName(name)) return;
		const sessionId = this.deps.getSessionManager().getSessionId();
		const sender = plainLabel(composed.senderLabel) || "unknown sender";
		const delivered = new Set(messages.map((message) => message.eventDigest));
		// The batch's id rides on the turn's origin record, so routing finds the turn whatever became of its text.
		const batchId = digest(`${name}:${[...delivered].join(",")}`).slice(0, 24);
		runtime.offering = true;
		let answered = false;
		const onAccepted = (accepted: boolean) => {
			if (answered) return;
			answered = true;
			runtime.offering = false;
			if (!accepted) {
				this.deps.warn(`Channel ${name}: the session did not accept a delivery; it is offered again later.`);
				return;
			}
			const now = this.now();
			const batch: ChannelBatchRecord = {
				id: batchId,
				sessionId,
				conversationKey: latest.conversationKey,
				address: latest.address,
				eventDigests: [...delivered],
				allowlisted: composed.verified,
				acceptedAt: now,
				state: "accepted",
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
	 * How a batch's turn ended. Its user entry is the one whose origin record names this channel and the batch's id
	 * (`ref`). The answer is the first completed assistant answer after it; a decisive entry before that (the owner's
	 * words, or another third party's, a host event someone else wrote included) means this batch got none.
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
				? { kind: "unanswered", reason: "not_delivered" }
				: { kind: "waiting" };
		let usd = 0;
		for (let i = index + 1; i < branch.length; i++) {
			const entry = branch[i];
			if (entry === undefined) continue;
			const origin = entryTurnOrigin(entry);
			if (origin && isDecisiveOrigin(origin))
				return { kind: "unanswered", reason: origin.k === "owner-typed" ? "owner_steered" : "mixed" };
			if (entry.type !== "message") continue;
			const message = entry.message;
			if (message.role !== "assistant") continue;
			usd += message.usage?.cost?.total ?? 0;
			if (message.stopReason === "stop" || message.stopReason === "length") {
				const text = messageText(message)?.trim() ?? "";
				return text ? { kind: "answered", text, usd } : { kind: "unanswered", reason: "empty_answer" };
			}
		}
		return now - batch.acceptedAt >= DAY_MS ? { kind: "unanswered", reason: "no_answer" } : { kind: "waiting" };
	}

	private async routeReplies(name: string, policy: ResolvedChannelPolicy): Promise<void> {
		const sessionId = this.deps.getSessionManager().getSessionId();
		const now = this.now();
		const { result: batches } = this.journal(name).update(now, (state) =>
			state.batches
				.filter((batch) => batch.state === "accepted" && batch.sessionId === sessionId)
				.map((batch) => ({ ...batch })),
		);
		for (const batch of batches) {
			const outcome = this.batchOutcome(name, batch, now);
			if (outcome.kind === "waiting") continue;
			if (outcome.kind === "unanswered") {
				this.settleBatch(name, batch.id, "unanswered", 0, undefined);
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
			const draftReason =
				policy.replyMode !== "auto"
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
			this.settleBatch(name, batch.id, "replied", outcome.usd, undefined);
			try {
				await this.sendParts(provider, batch, formatted.parts);
			} catch (error) {
				this.keepDraft(
					name,
					batch,
					outcome.text,
					`sending failed: ${error instanceof Error ? error.message : String(error)}`,
					0,
				);
			}
		}
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

	private settleBatch(
		name: string,
		batchId: string,
		state: ChannelBatchRecord["state"],
		usd: number,
		draft: ChannelDraftRecord | undefined,
	): void {
		this.journal(name).update(this.now(), (journal) => {
			const batch = journal.batches.find((entry) => entry.id === batchId);
			if (batch) {
				batch.state = state;
				if (usd > 0) batch.usd = (batch.usd ?? 0) + usd;
			}
			if (draft && !journal.drafts.some((entry) => entry.id === draft.id)) journal.drafts.push(draft);
		});
	}

	private keepDraft(name: string, batch: ChannelBatchRecord, text: string, reason: string, usd: number): void {
		const draft: ChannelDraftRecord = {
			id: digest(`draft:${name}:${batch.id}`).slice(0, 10),
			batchId: batch.id,
			conversationKey: batch.conversationKey,
			address: batch.address,
			text: text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)} [cut by the harness]` : text,
			reason,
			createdAt: this.now(),
			state: "pending",
		};
		this.settleBatch(name, batch.id, "drafted", usd, draft);
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

	/**
	 * What each channel with an explicit policy has used of its daily bounds and holds undelivered, from its journal.
	 * Reads only, and carries no third party's text.
	 */
	readJournalSummaries(): ChannelJournalSummary[] {
		const now = this.now();
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
