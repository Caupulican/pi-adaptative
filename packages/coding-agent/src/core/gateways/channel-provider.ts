/**
 * Interface-driven gateways & scheduling (adaptive-agent design R8).
 *
 * pi does NOT bake transports (Slack/Discord/email/webhooks) or a cron tick loop into the core — that
 * would bloat the agent and couple it to deployment concerns. Instead it exposes two provider contracts
 * that a deployment wrapper (server, headless runner) implements and registers; the core only manages
 * their lifecycle. This keeps the CLI/agent transport- and schedule-agnostic while still offering a
 * first-class, uniform extension point.
 */

/** A message arriving from / sent to an external channel (gateway). */
export interface ChannelMessage {
	/** Stable conversation/session key for this channel (e.g. `slack_C123`). */
	conversationKey: string;
	/** Message text. */
	text: string;
	/** Optional opaque metadata the provider round-trips. */
	meta?: Record<string, unknown>;
}

/** Handler the core supplies to a channel for inbound messages. */
export type ChannelInboundHandler = (message: ChannelMessage) => void | Promise<void>;

/**
 * A transport channel (Telegram/Slack/email/webhook/...). Implemented by a deployment wrapper and
 * registered via {@link GatewayRegistry}. The core starts it (handing it an inbound handler) and stops
 * it on shutdown; it never imports any transport SDK itself.
 */
export interface ChannelProvider {
	readonly name: string;
	/** Begin listening; deliver inbound messages to `onInbound`. */
	start(onInbound: ChannelInboundHandler): void | Promise<void>;
	/** Send an outbound message on this channel. */
	send(message: ChannelMessage): void | Promise<void>;
	/** Stop listening and release resources. */
	stop(): void | Promise<void>;
}

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
}

export const DEFAULT_GATEWAY_LIFECYCLE_TIMEOUT_MS = 30_000;

type LifecycleProvider = ChannelProvider | JobSchedulerProvider;
type LifecyclePhase = "start" | "stop";
type LifecycleSettlement = "fulfilled" | "rejected";
type LifecycleOutcome = LifecycleSettlement | "timed_out";

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
	private inboundHandler: ChannelInboundHandler = () => {};
	private readonly pendingLifecycle = new Set<Promise<void>>();
	private readonly providerLifecycle = new WeakMap<LifecycleProvider, ProviderLifecycleState>();
	private nextStartRequestId = 0;
	private readonly lifecycleTimeoutMs: number;
	private readonly onDiagnostic: (message: string) => void;

	constructor(options: GatewayRegistryOptions = {}) {
		this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? DEFAULT_GATEWAY_LIFECYCLE_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.lifecycleTimeoutMs) || this.lifecycleTimeoutMs < 1) {
			throw new TypeError("Gateway lifecycle timeout must be a positive safe integer.");
		}
		this.onDiagnostic = options.onDiagnostic ?? (() => {});
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
		if (!stillDesired || (settlement === "fulfilled" && timedOut)) {
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
		if (this.started)
			void this.requestProviderStart(
				provider,
				() => provider.start(this.inboundHandler),
				() => this.channels.get(provider.name) === provider,
			);
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

	get schedulerCount(): number {
		return this.schedulers.size;
	}

	/** Start every registered provider; inbound channel messages are routed to `onInbound`. */
	async start(onInbound: ChannelInboundHandler): Promise<void> {
		if (this.started) {
			await this.drainLifecycle();
			return;
		}
		this.started = true;
		this.inboundHandler = onInbound;
		await Promise.all([
			...[...this.channels.values()].map((channel) =>
				this.requestProviderStart(
					channel,
					() => channel.start(onInbound),
					() => this.channels.get(channel.name) === channel,
				),
			),
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
