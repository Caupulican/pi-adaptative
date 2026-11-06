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
	GatewayRegistry,
	type JobSchedulerProvider,
	type LifecycleOutcome,
} from "../gateways/channel-provider.ts";
import type { HarnessNoticeKind, HarnessNoticeObservation } from "../harness-notice.ts";
import { isProcessAlive } from "../process-liveness.ts";
import { hasMaskableSecretText } from "../security/secret-text.ts";
import { entryTurnOrigin, isDecisiveOrigin } from "../turn-origin.ts";
import {
	type ChannelBatchRecord,
	type ChannelDraftRecord,
	ChannelJournal,
	type ChannelJournalState,
	type ChannelPendingMessage,
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

/** Sessions of this process that serve a channel: a holder with this process's pid is live only while listed here. */
const liveHolders = new Map<string, string>();

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
	now?(): number;
}

interface ChannelRuntime {
	state: ChannelRuntimeState;
	detail?: string;
	/** This session recorded itself as the channel's serving session. */
	holding: boolean;
	/** A batch handed to `sendUserMessage` whose acceptance is not known yet. */
	offering: boolean;
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

	constructor(deps: SessionChannelsDeps) {
		this.deps = deps;
		this.registry = new GatewayRegistry({
			onDiagnostic: (message) => deps.warn(message),
			admitChannel: (name) => this.admit(name),
			onChannelStart: (name, outcome) => this.onChannelStart(name, outcome),
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
		this.registry.registerChannel(provider);
	}

	registerScheduler(provider: JobSchedulerProvider): void {
		this.registry.registerScheduler(provider);
	}

	/** Every registered channel and what it is doing; read-only. */
	getStates(): ChannelStateView[] {
		return this.registry.channelNames.map((name) => {
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
		this.unsubscribes.push(
			this.deps.subscribeSettings(() => this.onSettingsChanged()),
			this.deps.subscribeForegroundActivity(() => this.onActivity()),
		);
		void this.registry.start((name, message) => this.receive(name, message));
	}

	/** Stop every provider and give up every channel this session serves. Bounded by the registry's lifecycle timeout. */
	async stop(): Promise<void> {
		const wasStarted = this.started;
		this.started = false;
		for (const unsubscribe of this.unsubscribes.splice(0)) unsubscribe();
		await this.registry.stop();
		if (!wasStarted) return;
		for (const [name, runtime] of this.runtimes) {
			if (runtime.holding) this.releaseHold(name);
			runtime.state = "stopped";
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
				return {
					reason,
					text: `Channel ${name} did not start (${detail ?? "start failed"}); it is tried again when settings change or the provider registers again.`,
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
		if (runtime.state !== "armed" && runtime.state !== "capped" && runtime.state !== "starting")
			this.setState(name, "starting");
		return true;
	}

	private dropHold(name: string): false {
		if (this.runtime(name).holding) this.releaseHold(name);
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
	}

	private onChannelStart(name: string, outcome: LifecycleOutcome): void {
		if (!this.started) return;
		if (outcome === "fulfilled") {
			this.setState(name, "armed");
			this.scheduleWork();
			return;
		}
		this.setState(name, "suspended", outcome === "timed_out" ? "its start timed out" : "its start failed");
	}

	private onSettingsChanged(): void {
		if (!this.started) return;
		void this.registry.refreshChannels();
		this.scheduleWork();
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
			if (!policy.allowedSenders.includes(event.senderId)) return held("not_allowed");
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
	}

	/** Why the channel delivers nothing now, or undefined. Reads the journal state it is given. */
	private capReason(
		name: string,
		policy: ResolvedChannelPolicy,
		state: ChannelJournalState,
		now: number,
	): string | undefined {
		const recent = state.batches.filter((batch) => now - batch.acceptedAt < DAY_MS);
		if (recent.length >= policy.maxWakesPerDay)
			return `its bound of ${policy.maxWakesPerDay} turn(s) in 24 hours is reached (channels.${name}.maxWakesPerDay)`;
		const spent = recent.reduce((sum, batch) => sum + (batch.usd ?? 0), 0);
		if (spent >= policy.maxUsdPerDay)
			return `$${spent.toFixed(2)} spent in the last 24 hours reaches channels.${name}.maxUsdPerDay`;
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

	/** The pending reply drafts of every channel with an explicit policy. */
	listDrafts(): ChannelDraftView[] {
		const views: ChannelDraftView[] = [];
		for (const [name, resolution] of this.deps.getChannelPolicies()) {
			if (resolution.kind !== "policy" || resolution.policy.mode !== "explicit" || !isValidChannelName(name))
				continue;
			const { result: drafts } = this.journal(name).update(this.now(), (state) =>
				state.drafts.filter((draft) => draft.state === "pending").map((draft) => ({ ...draft })),
			);
			for (const draft of drafts)
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
