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

	registerChannel(provider: ChannelProvider): void {
		// Stop a same-named provider being replaced so its listeners/sockets don't leak (Bug #17).
		const existing = this.channels.get(provider.name);
		if (existing && existing !== provider) void Promise.resolve(existing.stop()).catch(() => {});
		this.channels.set(provider.name, provider);
		if (this.started) void Promise.resolve(provider.start(this.inboundHandler)).catch(() => {});
	}

	registerScheduler(provider: JobSchedulerProvider): void {
		const existing = this.schedulers.get(provider.name);
		if (existing && existing !== provider) void Promise.resolve(existing.stop()).catch(() => {});
		this.schedulers.set(provider.name, provider);
		if (this.started) void Promise.resolve(provider.start()).catch(() => {});
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
		if (this.started) return;
		this.started = true;
		this.inboundHandler = onInbound;
		for (const channel of this.channels.values()) {
			try {
				await channel.start(onInbound);
			} catch {
				// a failing channel must not block the others
			}
		}
		for (const scheduler of this.schedulers.values()) {
			try {
				await scheduler.start();
			} catch {}
		}
	}

	/** Stop every registered provider. Best-effort; always leaves the registry stopped. */
	async stop(): Promise<void> {
		if (!this.started) return;
		this.started = false;
		for (const channel of this.channels.values()) {
			try {
				await channel.stop();
			} catch {}
		}
		for (const scheduler of this.schedulers.values()) {
			try {
				await scheduler.stop();
			} catch {}
		}
	}
}
