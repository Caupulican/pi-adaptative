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
	private readonly lifecycleTimeoutMs: number;
	private readonly onDiagnostic: (message: string) => void;

	constructor(options: GatewayRegistryOptions = {}) {
		this.lifecycleTimeoutMs = options.lifecycleTimeoutMs ?? DEFAULT_GATEWAY_LIFECYCLE_TIMEOUT_MS;
		if (!Number.isSafeInteger(this.lifecycleTimeoutMs) || this.lifecycleTimeoutMs < 1) {
			throw new TypeError("Gateway lifecycle timeout must be a positive safe integer.");
		}
		this.onDiagnostic = options.onDiagnostic ?? (() => {});
	}

	private async runLifecycle(
		providerName: string,
		phase: "start" | "stop",
		operation: () => void | Promise<void>,
		onLateStart?: () => void,
	): Promise<void> {
		let operationPromise: Promise<void>;
		try {
			operationPromise = Promise.resolve(operation());
		} catch {
			return;
		}
		let timeout: ReturnType<typeof setTimeout> | undefined;
		const outcome = await Promise.race([
			operationPromise.then(
				() => "settled" as const,
				() => "settled" as const,
			),
			new Promise<"timed_out">((resolve) => {
				timeout = setTimeout(() => resolve("timed_out"), this.lifecycleTimeoutMs);
				timeout.unref?.();
			}),
		]);
		if (timeout) clearTimeout(timeout);
		if (outcome !== "timed_out") return;
		try {
			this.onDiagnostic(
				`Gateway ${providerName} ${phase} timed out after ${this.lifecycleTimeoutMs}ms; session lifecycle continued.`,
			);
		} catch {}
		if (onLateStart) void operationPromise.then(onLateStart, () => undefined);
	}

	private trackLifecycle(
		providerName: string,
		phase: "start" | "stop",
		operation: () => void | Promise<void>,
		onLateStart?: () => void,
	): void {
		let pending: Promise<void>;
		try {
			pending = this.runLifecycle(providerName, phase, operation, onLateStart);
		} catch {
			return;
		}
		this.pendingLifecycle.add(pending);
		void pending.finally(() => this.pendingLifecycle.delete(pending));
	}

	private async drainLifecycle(): Promise<void> {
		while (this.pendingLifecycle.size > 0) {
			await Promise.allSettled([...this.pendingLifecycle]);
		}
	}

	registerChannel(provider: ChannelProvider): void {
		// Stop a same-named provider being replaced so its listeners/sockets don't leak (Bug #17).
		const existing = this.channels.get(provider.name);
		if (existing && existing !== provider) this.trackLifecycle(existing.name, "stop", () => existing.stop());
		this.channels.set(provider.name, provider);
		if (this.started)
			this.trackLifecycle(
				provider.name,
				"start",
				() => provider.start(this.inboundHandler),
				() => {
					this.trackLifecycle(provider.name, "stop", () => provider.stop());
				},
			);
	}

	registerScheduler(provider: JobSchedulerProvider): void {
		const existing = this.schedulers.get(provider.name);
		if (existing && existing !== provider) this.trackLifecycle(existing.name, "stop", () => existing.stop());
		this.schedulers.set(provider.name, provider);
		if (this.started)
			this.trackLifecycle(
				provider.name,
				"start",
				() => provider.start(),
				() => {
					this.trackLifecycle(provider.name, "stop", () => provider.stop());
				},
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
				this.runLifecycle(
					channel.name,
					"start",
					() => channel.start(onInbound),
					() => {
						this.trackLifecycle(channel.name, "stop", () => channel.stop());
					},
				),
			),
			...[...this.schedulers.values()].map((scheduler) =>
				this.runLifecycle(
					scheduler.name,
					"start",
					() => scheduler.start(),
					() => {
						this.trackLifecycle(scheduler.name, "stop", () => scheduler.stop());
					},
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
		// Late-registration starts and replacement stops must settle before the final stop pass;
		// otherwise an async start can complete after shutdown and leak a listener/process.
		await this.drainLifecycle();
		await Promise.all([
			...[...this.channels.values()].map((channel) => this.runLifecycle(channel.name, "stop", () => channel.stop())),
			...[...this.schedulers.values()].map((scheduler) =>
				this.runLifecycle(scheduler.name, "stop", () => scheduler.stop()),
			),
		]);
	}
}
