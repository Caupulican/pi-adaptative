import { describe, expect, it } from "vitest";
import {
	type ChannelInboundHandler,
	type ChannelMessage,
	type ChannelProvider,
	GatewayRegistry,
	type JobSchedulerProvider,
	type ScheduledJob,
} from "../src/core/gateways/channel-provider.ts";

class FakeChannel implements ChannelProvider {
	readonly name = "fake-channel";
	started = false;
	stopped = false;
	sent: ChannelMessage[] = [];
	private handler?: ChannelInboundHandler;
	start(onInbound: ChannelInboundHandler): void {
		this.started = true;
		this.handler = onInbound;
	}
	send(message: ChannelMessage): void {
		this.sent.push(message);
	}
	stop(): void {
		this.stopped = true;
	}
	emitInbound(message: ChannelMessage): void {
		this.handler?.(message);
	}
}

class FakeScheduler implements JobSchedulerProvider {
	readonly name = "fake-scheduler";
	started = false;
	stopped = false;
	jobs: ScheduledJob[] = [];
	schedule(job: ScheduledJob): void {
		this.jobs.push(job);
	}
	start(): void {
		this.started = true;
	}
	stop(): void {
		this.stopped = true;
	}
}

describe("GatewayRegistry (R8 interface-driven gateways/cron)", () => {
	it("starts and stops registered providers and routes inbound messages", async () => {
		const registry = new GatewayRegistry();
		const channel = new FakeChannel();
		const scheduler = new FakeScheduler();
		registry.registerChannel(channel);
		registry.registerScheduler(scheduler);
		expect(registry.channelCount).toBe(1);
		expect(registry.schedulerCount).toBe(1);

		const inbound: ChannelMessage[] = [];
		const handler: ChannelInboundHandler = (m) => {
			inbound.push(m);
		};

		await registry.start(handler);
		expect(channel.started).toBe(true);
		expect(scheduler.started).toBe(true);

		channel.emitInbound({ conversationKey: "k1", text: "hello from slack" });
		expect(inbound).toHaveLength(1);
		expect(inbound[0].text).toBe("hello from slack");

		await registry.stop();
		expect(channel.stopped).toBe(true);
		expect(scheduler.stopped).toBe(true);
	});

	it("auto-starts a provider registered after the registry has started", async () => {
		const registry = new GatewayRegistry();
		await registry.start(() => {});
		const late = new FakeChannel();
		registry.registerChannel(late);
		expect(late.started).toBe(true);
	});

	it("is a no-op when empty (the default — no transports baked in)", async () => {
		const registry = new GatewayRegistry();
		expect(registry.channelCount).toBe(0);
		await registry.start(() => {});
		await registry.stop();
		expect(registry.schedulerCount).toBe(0);
	});
});
