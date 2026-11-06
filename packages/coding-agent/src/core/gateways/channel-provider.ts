/**
 * Interface-driven gateways & scheduling (adaptive-agent design R8).
 *
 * pi ships three transports (Telegram, Slack and Gmail, `core/channels/built-in-providers.ts`) and no cron
 * tick loop; every other transport (Discord, other mail, webhooks) comes from a deployment wrapper (server, headless
 * runner) that implements these provider contracts and registers them; the core only manages their
 * lifecycle. The shipped transports implement the same contract, so the core treats them alike.
 */

/** What an inbound event is. Any other kind a provider reports is journaled and ignored. */
export type ChannelMessageKind = "message" | "reaction";

/** Who wrote an inbound event, as the provider knows it. */
export interface ChannelSender {
	/** The provider's stable sender id; `channels.<name>.allowedSenders` lists these. */
	id: string;
	/** A display label; self-declared on most transports, so it is shown, never trusted. */
	label?: string;
	/** Whether the provider itself authenticated the sender (a signed webhook, a bot API's user id). */
	verified: boolean;
}

/** A message arriving from / sent to an external channel (gateway). */
export interface ChannelMessage {
	/** Stable conversation/session key for this channel (e.g. `slack_C123`). */
	conversationKey: string;
	/** Message text. */
	text: string;
	/** Optional opaque metadata the provider round-trips. It never reaches the model. */
	meta?: Record<string, unknown>;
	/** The provider's stable id of this event. Required inbound: the admission journal is keyed by (channel, eventId). */
	eventId?: string;
	/** Required inbound. */
	sender?: ChannelSender;
	/** Opaque reply address only the provider resolves. Required inbound; the reply goes back to the same address. */
	address?: string;
	/** Defaults to `message`. */
	kind?: ChannelMessageKind;
	/** When the provider received the event, epoch milliseconds; defaults to admission time. */
	receivedAt?: number;
}

/** What the transport accepts outbound; replies are split and formatted to it. */
export interface ChannelCapabilities {
	/** The longest text one outbound message may carry; longer replies are sent in parts. */
	maxMessageChars?: number;
	/** Whether the transport renders markdown; otherwise replies are sent as plain text. */
	markdown?: boolean;
	/** Whether an address can name a thread inside a conversation. */
	threads?: boolean;
}

/** What a transport's sender ids are: the core reads it to decide where an id may be shown and how ids compare. */
export interface ChannelSenderIds {
	/**
	 * `platform`: the service assigns each sender's id (a Telegram user number, a Slack user id), so the sender cannot
	 * choose its text and an owner notice may name it. `sender`: the sender picks it (a mail address), so it is text a third
	 * party wrote and is shown only fenced as data. A provider that does not say is taken as `sender`.
	 */
	readonly assignedBy: "platform" | "sender";
	/** The one form ids compare in; `allowedSenders` entries are put in it before they are matched. Identity when omitted. */
	readonly normalize?: (id: string) => string;
}

/** Handler the core supplies to a channel for inbound messages. It resolves once the event is held; a rejection means "redeliver". */
export type ChannelInboundHandler = (message: ChannelMessage) => void | Promise<void>;

/** Whether a started channel receives messages: a transport that lost its connection reports why, in its own words. */
export type ChannelProviderStatus =
	| { readonly state: "connected" }
	| { readonly state: "suspended"; readonly reason: string };

/** Optional: a provider that never calls it is taken as connected while started. */
export type ChannelStatusReporter = (status: ChannelProviderStatus) => void;

/**
 * A transport channel (Telegram/Slack/email/webhook/...). Implemented by a deployment wrapper (or shipped, see
 * `core/channels/built-in-providers.ts`) and registered via {@link GatewayRegistry}. The core starts it (handing it an
 * inbound handler) and stops it on shutdown; it never imports any transport SDK itself.
 */
export interface ChannelProvider {
	readonly name: string;
	readonly capabilities?: ChannelCapabilities;
	readonly senderIds?: ChannelSenderIds;
	/**
	 * Begin listening; deliver inbound messages to `onInbound`. `report` tells a later loss or return of the connection;
	 * its reason is shown to the owner (redacted), so it is the provider's own words, never remote text or a credential.
	 */
	start(onInbound: ChannelInboundHandler, report?: ChannelStatusReporter): void | Promise<void>;
	/** Send an outbound message on this channel: a reply carries the inbound `address` and a reply `eventId`. */
	send(message: ChannelMessage): void | Promise<void>;
	/** Stop listening and release resources. */
	stop(): void | Promise<void>;
}

/** The core's handler for every channel: the registry binds each provider's own name to its events. */
export type GatewayInboundHandler = (channel: string, message: ChannelMessage) => void | Promise<void>;

/** A scheduled job definition. */
export interface ScheduledJob {
	id: string;
	/** Cron expression or interval spec the provider understands. */
	schedule: string;
	/** Invoked when the job fires. */
	run: () => void | Promise<void>;
}

/**
 * A scheduler (cron-like). Implemented by a deployment wrapper and registered via
 * {@link GatewayRegistry}. The core registers jobs + starts/stops it; it owns no tick loop itself.
 */
export interface JobSchedulerProvider {
	readonly name: string;
	schedule(job: ScheduledJob): void;
	start(): void | Promise<void>;
	stop(): void | Promise<void>;
}

export interface GatewayRegistryOptions {
	/** Bound for each provider lifecycle callback. */
	lifecycleTimeoutMs?: number;
	onDiagnostic?: (message: string) => void;
	/** Whether a registered channel may start; one it does not admit is never started. Defaults to every channel. */
	admitChannel?: (name: string) => boolean;
	/** How each channel start ended: a rejected or timed-out start is stopped again. `reason` is a rejection's own text, unredacted. */
	onChannelStart?: (name: string, outcome: LifecycleOutcome, reason?: string) => void;
	/** A status the current started provider of `name` reported; reports of a replaced or stopped provider are dropped. */
	onChannelStatus?: (name: string, status: ChannelProviderStatus) => void;
}

export const DEFAULT_GATEWAY_LIFECYCLE_TIMEOUT_MS = 30_000;

type LifecycleProvider = ChannelProvider | JobSchedulerProvider;
type LifecyclePhase = "start" | "stop";
type LifecycleSettlement = "fulfilled" | "rejected";
export type LifecycleOutcome = LifecycleSettlement | "timed_out";

interface LifecycleRun {
	settlement: Promise<LifecycleSettlement>;
	bounded: Promise<LifecycleOutcome>;
}

interface DesiredProviderStart {
	id: number;
	operation: () => void | Promise<void>;
	isCurrent: () => boolean;
}

interface ProviderStartAttempt {
	request: DesiredProviderStart;
	settlement: Promise<LifecycleSettlement>;
	bounded?: Promise<void>;
}

interface ProviderStopAttempt {
	settlement: Promise<LifecycleSettlement>;
	bounded?: Promise<void>;
}

interface ProviderLifecycleState {
	desiredStart?: DesiredProviderStart;
	lastStartAttemptId?: number;
	startAttempt?: ProviderStartAttempt;
	stopAttempt?: ProviderStopAttempt;
	/** The text the last rejected channel start threw. */
	startFailure?: string;
}

/**
 * Holds registered channel + scheduler providers and drives their lifecycle. A session starts all
 * registered providers when it binds and stops them on dispose. Registration is additive and idempotent
 * by provider name (last registration wins).
 */
export class GatewayRegistry {
	private readonly channels = new Map<string, ChannelProvider>();
	private readonly schedulers = new Map<string, JobSchedulerProvider>();
	private started = false;
	private inboundHandler: GatewayInboundHandler = () => {};
	private readonly pendingLifecycle = new Set<Promise<void>>();
	private readonly providerLifecycle = new WeakMap<LifecycleProvider, ProviderLifecycleState>();
	private nextStartRequestId = 0;
	private readonly lifecycleTimeoutMs: number;
	private readonly onDiagnostic: (message: string) => void;
	private readonly admitChannel: (name: string) => boolean;
	private readonly onChannelStart: (name: string, outcome: LifecycleOutcome, reason?: string) => void;
	private readonly onChannelStatus: (name: string, status: ChannelProviderStatus) => void;

	constructor(options: GatewayRegistryOptions = {}) {
		this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? DEFAULT_GATEWAY_LIFECYCLE_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.lifecycleTimeoutMs) || this.lifecycleTimeoutMs < 1) {
			throw new TypeError("Gateway lifecycle timeout must be a positive safe integer.");
		}
		this.onDiagnostic = options.onDiagnostic ?? (() => {});
		this.admitChannel = options.admitChannel ?? (() => true);
		this.onChannelStart = options.onChannelStart ?? (() => {});
		this.onChannelStatus = options.onChannelStatus ?? (() => {});
	}

	/** A channel start bound to the provider's own name, admitted only while `admitChannel` holds and it is the registered one. */
	private requestChannelStart(channel: ChannelProvider): Promise<void> {
		if (!this.admitChannel(channel.name)) return Promise.resolve();
		const state = this.stateFor(channel);
		return this.requestProviderStart(
			channel,
			async () => {
				state.startFailure = undefined;
				try {
					await channel.start(
						(message) => this.inboundHandler(channel.name, message),
						(status) => this.reportChannelStatus(channel, state, status),
					);
				} catch (error) {
					state.startFailure = error instanceof Error ? error.message : String(error);
					throw error;
				}
			},
			() => this.channels.get(channel.name) === channel && this.admitChannel(channel.name),
		);
	}

	private reportChannelStart(provider: LifecycleProvider, outcome: LifecycleOutcome): void {
		if (this.channels.get(provider.name) !== provider) return;
		const reason = outcome === "rejected" ? this.providerLifecycle.get(provider)?.startFailure : undefined;
		try {
			this.onChannelStart(provider.name, outcome, reason);
		} catch {}
	}

	/** Only the registered provider, while its start is still wanted, speaks for its channel. */
	private reportChannelStatus(
		channel: ChannelProvider,
		state: ProviderLifecycleState,
		status: ChannelProviderStatus,
	): void {
		if (!this.started || this.channels.get(channel.name) !== channel || state.desiredStart === undefined) return;
		try {
			this.onChannelStatus(channel.name, status);
		} catch {}
	}

	/**
	 * Re-read `admitChannel` for every registered channel while started: a newly admitted one starts, one no longer
	 * admitted stops. A start already wanted is not repeated; a start that failed is no longer wanted, so it is tried again.
	 */
	refreshChannels(): Promise<void> {
		if (!this.started) return Promise.resolve();
		const pending: Promise<void>[] = [];
		for (const channel of this.channels.values()) {
			const wanted = this.providerLifecycle.get(channel)?.desiredStart !== undefined;
			const admitted = this.admitChannel(channel.name);
			if (admitted && !wanted) pending.push(this.requestChannelStart(channel));
			else if (!admitted && wanted) pending.push(this.requestProviderStop(channel));
		}
		return Promise.all(pending).then(() => {});
	}

	private beginLifecycle(
		providerName: string,
		phase: LifecyclePhase,
		operation: () => void | Promise<void>,
	): LifecycleRun {
		let settlement: Promise<LifecycleSettlement>;
		try {
			settlement = Promise.resolve(operation()).then(
				() => "fulfilled",
				() => "rejected",
			);
		} catch {
			settlement = Promise.resolve("rejected");
		}
		const bounded = (async (): Promise<LifecycleOutcome> => {
			let timeout: ReturnType<typeof setTimeout> | undefined;
			try {
				const outcome = await Promise.race([
					settlement,
					new Promise<"timed_out">((resolve) => {
						timeout = setTimeout(() => resolve("timed_out"), this.lifecycleTimeoutMs);
						timeout.unref?.();
					}),
				]);
				if (outcome === "timed_out") {
					try {
						this.onDiagnostic(
							`Gateway ${providerName} ${phase} timed out after ${this.lifecycleTimeoutMs}ms; session lifecycle continued.`,
						);
					} catch {}
				}
				return outcome;
			} finally {
				if (timeout) clearTimeout(timeout);
			}
		})();
		return { settlement, bounded };
	}

	private trackLifecycle(pending: Promise<void>): void {
		this.pendingLifecycle.add(pending);
		void pending.then(
			() => this.pendingLifecycle.delete(pending),
			() => this.pendingLifecycle.delete(pending),
		);
	}

	private stateFor(provider: LifecycleProvider): ProviderLifecycleState {
		let state = this.providerLifecycle.get(provider);
		if (!state) {
			state = {};
			this.providerLifecycle.set(provider, state);
		}
		return state;
	}

	private requestProviderStart(
		provider: LifecycleProvider,
		operation: () => void | Promise<void>,
		isCurrent: () => boolean,
	): Promise<void> {
		const state = this.stateFor(provider);
		state.desiredStart = { id: ++this.nextStartRequestId, operation, isCurrent };
		return this.startDesiredProvider(provider, state);
	}

	private startDesiredProvider(provider: LifecycleProvider, state: ProviderLifecycleState): Promise<void> {
		const desired = state.desiredStart;
		if (
			!this.started ||
			!desired?.isCurrent() ||
			state.startAttempt ||
			state.stopAttempt ||
			state.lastStartAttemptId === desired.id
		) {
			return Promise.resolve();
		}
		state.lastStartAttemptId = desired.id;
		const run = this.beginLifecycle(provider.name, "start", desired.operation);
		const attempt: ProviderStartAttempt = { request: desired, settlement: run.settlement };
		state.startAttempt = attempt;
		const bounded = this.observeProviderStart(provider, state, attempt, run.bounded);
		attempt.bounded = bounded;
		this.trackLifecycle(bounded);
		return bounded;
	}

	private async observeProviderStart(
		provider: LifecycleProvider,
		state: ProviderLifecycleState,
		attempt: ProviderStartAttempt,
		boundedOutcome: Promise<LifecycleOutcome>,
	): Promise<void> {
		const outcome = await boundedOutcome;
		if (state.desiredStart?.id === attempt.request.id) this.reportChannelStart(provider, outcome);
		if (outcome === "timed_out") {
			void attempt.settlement.then((settlement) => {
				this.trackLifecycle(this.finishProviderStart(provider, state, attempt, settlement, true));
			});
			return;
		}
		await this.finishProviderStart(provider, state, attempt, outcome, false);
	}

	private async finishProviderStart(
		provider: LifecycleProvider,
		state: ProviderLifecycleState,
		attempt: ProviderStartAttempt,
		settlement: LifecycleSettlement,
		timedOut: boolean,
	): Promise<void> {
		if (state.startAttempt !== attempt) return;
		state.startAttempt = undefined;
		const stillDesired =
			this.started &&
			state.desiredStart?.id === attempt.request.id &&
			attempt.request.isCurrent() &&
			!state.stopAttempt;
		if (!stillDesired || settlement === "rejected" || timedOut) {
			// A failed start is no longer wanted: the next registration or `refreshChannels` asks again.
			if (state.desiredStart?.id === attempt.request.id) state.desiredStart = undefined;
			await this.startProviderStop(provider, state);
		}
		await this.startDesiredProvider(provider, state);
	}

	private requestProviderStop(provider: LifecycleProvider): Promise<void> {
		const state = this.stateFor(provider);
		state.desiredStart = undefined;
		const pendingStart = state.startAttempt;
		if (pendingStart?.bounded) {
			const bounded = pendingStart.bounded.then(async () => {
				if (state.startAttempt === pendingStart) await this.startProviderStop(provider, state);
			});
			this.trackLifecycle(bounded);
			return bounded;
		}
		return this.startProviderStop(provider, state);
	}

	private startProviderStop(provider: LifecycleProvider, state: ProviderLifecycleState): Promise<void> {
		if (state.stopAttempt) return state.stopAttempt.bounded ?? Promise.resolve();
		const run = this.beginLifecycle(provider.name, "stop", () => provider.stop());
		const attempt: ProviderStopAttempt = { settlement: run.settlement };
		state.stopAttempt = attempt;
		const bounded = this.observeProviderStop(provider, state, attempt, run.bounded);
		attempt.bounded = bounded;
		this.trackLifecycle(bounded);
		return bounded;
	}

	private async observeProviderStop(
		provider: LifecycleProvider,
		state: ProviderLifecycleState,
		attempt: ProviderStopAttempt,
		boundedOutcome: Promise<LifecycleOutcome>,
	): Promise<void> {
		const outcome = await boundedOutcome;
		if (outcome === "timed_out") {
			void attempt.settlement.then(() => {
				this.trackLifecycle(this.finishProviderStop(provider, state, attempt));
			});
			return;
		}
		await this.finishProviderStop(provider, state, attempt);
	}

	private async finishProviderStop(
		provider: LifecycleProvider,
		state: ProviderLifecycleState,
		attempt: ProviderStopAttempt,
	): Promise<void> {
		if (state.stopAttempt !== attempt) return;
		state.stopAttempt = undefined;
		await this.startDesiredProvider(provider, state);
	}

	private async drainLifecycle(): Promise<void> {
		while (this.pendingLifecycle.size > 0) {
			await Promise.allSettled([...this.pendingLifecycle]);
		}
	}

	registerChannel(provider: ChannelProvider): void {
		// Stop a same-named provider being replaced so its listeners/sockets don't leak (Bug #17).
		const existing = this.channels.get(provider.name);
		if (existing === provider) return;
		if (existing) void this.requestProviderStop(existing);
		this.channels.set(provider.name, provider);
		if (this.started) void this.requestChannelStart(provider);
	}

	/** Forget the channel registered under `name` and stop it; resolves once its bounded stop settled. */
	unregisterChannel(name: string): Promise<void> {
		const existing = this.channels.get(name);
		if (!existing) return Promise.resolve();
		this.channels.delete(name);
		return this.requestProviderStop(existing);
	}

	registerScheduler(provider: JobSchedulerProvider): void {
		const existing = this.schedulers.get(provider.name);
		if (existing === provider) return;
		if (existing) void this.requestProviderStop(existing);
		this.schedulers.set(provider.name, provider);
		if (this.started)
			void this.requestProviderStart(
				provider,
				() => provider.start(),
				() => this.schedulers.get(provider.name) === provider,
			);
	}

	getChannel(name: string): ChannelProvider | undefined {
		return this.channels.get(name);
	}

	get channelCount(): number {
		return this.channels.size;
	}

	get channelNames(): string[] {
		return [...this.channels.keys()];
	}

	get schedulerCount(): number {
		return this.schedulers.size;
	}

	/** Start every registered provider the registry admits; each channel's inbound messages reach `onInbound` under its name. */
	async start(onInbound: GatewayInboundHandler): Promise<void> {
		if (this.started) {
			await this.drainLifecycle();
			return;
		}
		this.started = true;
		this.inboundHandler = onInbound;
		await Promise.all([
			...[...this.channels.values()].map((channel) => this.requestChannelStart(channel)),
			...[...this.schedulers.values()].map((scheduler) =>
				this.requestProviderStart(
					scheduler,
					() => scheduler.start(),
					() => this.schedulers.get(scheduler.name) === scheduler,
				),
			),
		]);
		await this.drainLifecycle();
	}

	/** Stop every registered provider. Best-effort; always leaves the registry stopped. */
	async stop(): Promise<void> {
		if (!this.started) {
			await this.drainLifecycle();
			return;
		}
		this.started = false;
		await Promise.all([
			...[...this.channels.values()].map((channel) => this.requestProviderStop(channel)),
			...[...this.schedulers.values()].map((scheduler) => this.requestProviderStop(scheduler)),
		]);
		// A start may settle while the stop pass is running and admit a compensating stop. Drain until
		// no bounded lifecycle work remains; raw timed-out operations stay quarantined per provider.
		await this.drainLifecycle();
	}
}
