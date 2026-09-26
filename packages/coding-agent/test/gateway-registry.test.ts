import { afterEach, describe, expect, it, vi } from "vitest";
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
	afterEach(() => vi.useRealTimers());

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

	it("does not restart the same provider object when registration is repeated", async () => {
		const registry = new GatewayRegistry();
		await registry.start(() => {});
		let starts = 0;
		const provider: ChannelProvider = {
			name: "idempotent",
			start: () => {
				starts += 1;
			},
			send: () => {},
			stop: () => {},
		};

		registry.registerChannel(provider);
		registry.registerChannel(provider);
		await registry.start(() => {});

		expect(starts).toBe(1);
	});

	it("waits for a late async start before completing shutdown", async () => {
		const registry = new GatewayRegistry();
		await registry.start(() => {});
		let releaseStart!: () => void;
		let stopCalled = false;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		registry.registerChannel({
			name: "late-async",
			start: async () => startGate,
			send: () => {},
			stop: () => {
				stopCalled = true;
			},
		});

		let shutdownSettled = false;
		const shutdown = registry.stop().then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();
		expect(shutdownSettled).toBe(false);
		expect(stopCalled).toBe(false);

		releaseStart();
		await shutdown;
		expect(stopCalled).toBe(true);
	});

	it("does not complete shutdown before an initial async start is terminally stopped", async () => {
		const registry = new GatewayRegistry();
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		let active = false;
		let stopCalls = 0;
		registry.registerChannel({
			name: "initial-async",
			start: async () => {
				await startGate;
				active = true;
			},
			send: () => {},
			stop: () => {
				stopCalls += 1;
				active = false;
			},
		});

		const starting = registry.start(() => {});
		let shutdownSettled = false;
		const shutdown = registry.stop().then(() => {
			shutdownSettled = true;
		});
		await Promise.resolve();
		await Promise.resolve();
		const settledBeforeStart = shutdownSettled;

		releaseStart();
		await Promise.all([starting, shutdown]);

		expect(settledBeforeStart).toBe(false);
		expect(stopCalls).toBe(1);
		expect(active).toBe(false);
	});

	it("stops a replaced provider when its pending start completes", async () => {
		const registry = new GatewayRegistry();
		let releaseOldStart!: () => void;
		const oldStartGate = new Promise<void>((resolve) => {
			releaseOldStart = resolve;
		});
		let oldActive = false;
		let oldStopCalls = 0;
		const oldProvider: ChannelProvider = {
			name: "replaceable",
			start: async () => {
				await oldStartGate;
				oldActive = true;
			},
			send: () => {},
			stop: () => {
				oldStopCalls += 1;
				oldActive = false;
			},
		};
		let replacementActive = false;
		const replacement: ChannelProvider = {
			name: "replaceable",
			start: () => {
				replacementActive = true;
			},
			send: () => {},
			stop: () => {
				replacementActive = false;
			},
		};
		registry.registerChannel(oldProvider);

		const starting = registry.start(() => {});
		registry.registerChannel(replacement);
		expect(oldStopCalls).toBe(0);
		expect(replacementActive).toBe(true);

		releaseOldStart();
		await starting;
		await Promise.resolve();
		await Promise.resolve();

		expect(oldStopCalls).toBe(1);
		expect(oldActive).toBe(false);
		expect(replacementActive).toBe(true);
	});

	it("still stops a replaced provider when its pending start rejects", async () => {
		const registry = new GatewayRegistry();
		let rejectOldStart!: (error: Error) => void;
		const oldStartGate = new Promise<void>((_resolve, reject) => {
			rejectOldStart = reject;
		});
		let oldStopCalls = 0;
		const oldProvider: ChannelProvider = {
			name: "rejecting-replacement",
			start: async () => oldStartGate,
			send: () => {},
			stop: () => {
				oldStopCalls += 1;
			},
		};
		registry.registerChannel(oldProvider);

		const starting = registry.start(() => {});
		registry.registerChannel({
			name: "rejecting-replacement",
			start: () => {},
			send: () => {},
			stop: () => {},
		});
		rejectOldStart(new Error("partial setup failed"));
		await starting;

		expect(oldStopCalls).toBe(1);
	});

	it("bounds a provider start that never settles and continues starting independent providers", async () => {
		vi.useFakeTimers();
		const diagnostics: string[] = [];
		const registry = new GatewayRegistry({
			lifecycleTimeoutMs: 25,
			onDiagnostic: (message) => diagnostics.push(message),
		});
		registry.registerChannel({
			name: "hanging-start",
			start: () => new Promise<void>(() => {}),
			send: () => {},
			stop: () => {},
		});
		const scheduler = new FakeScheduler();
		registry.registerScheduler(scheduler);

		const starting = registry.start(() => {});
		expect(scheduler.started).toBe(true);
		await vi.advanceTimersByTimeAsync(25);
		await starting;

		expect(scheduler.started).toBe(true);
		expect(diagnostics).toEqual([expect.stringContaining("hanging-start start timed out")]);
		await registry.stop();
	});

	it("does not let stale late-start cleanup stop a restarted provider generation", async () => {
		vi.useFakeTimers();
		const registry = new GatewayRegistry({ lifecycleTimeoutMs: 25 });
		let releaseFirstStart!: () => void;
		const firstStart = new Promise<void>((resolve) => {
			releaseFirstStart = resolve;
		});
		let startCalls = 0;
		let stopCalls = 0;
		let active = false;
		registry.registerChannel({
			name: "restartable",
			start: () => {
				startCalls += 1;
				if (startCalls === 1) {
					return firstStart.then(() => {
						active = true;
					});
				}
				active = true;
			},
			send: () => {},
			stop: () => {
				stopCalls += 1;
				active = false;
			},
		});

		const firstStarting = registry.start(() => {});
		await vi.advanceTimersByTimeAsync(25);
		await firstStarting;
		await registry.stop();
		expect(stopCalls).toBe(1);

		await registry.start(() => {});
		expect(startCalls).toBe(1);
		expect(active).toBe(false);

		releaseFirstStart();
		await vi.advanceTimersByTimeAsync(0);
		await registry.start(() => {});

		expect(startCalls).toBe(2);
		expect(stopCalls).toBe(2);
		expect(active).toBe(true);
	});

	it("still cleans up a timed-out start that settles after the registry stays stopped", async () => {
		vi.useFakeTimers();
		const registry = new GatewayRegistry({ lifecycleTimeoutMs: 25 });
		let releaseStart!: () => void;
		const startGate = new Promise<void>((resolve) => {
			releaseStart = resolve;
		});
		let stopCalls = 0;
		registry.registerChannel({
			name: "late-stopped",
			start: async () => startGate,
			send: () => {},
			stop: () => {
				stopCalls += 1;
			},
		});

		const starting = registry.start(() => {});
		await vi.advanceTimersByTimeAsync(25);
		await starting;
		await registry.stop();
		expect(stopCalls).toBe(1);

		releaseStart();
		await Promise.resolve();
		await registry.stop();

		expect(stopCalls).toBe(2);
	});

	it("bounds a provider stop that never settles", async () => {
		vi.useFakeTimers();
		const diagnostics: string[] = [];
		const registry = new GatewayRegistry({
			lifecycleTimeoutMs: 25,
			onDiagnostic: (message) => diagnostics.push(message),
		});
		registry.registerChannel({
			name: "hanging-stop",
			start: () => {},
			send: () => {},
			stop: () => new Promise<void>(() => {}),
		});
		const scheduler = new FakeScheduler();
		registry.registerScheduler(scheduler);
		await registry.start(() => {});

		const stopping = registry.stop();
		await Promise.resolve();
		expect(scheduler.stopped).toBe(true);
		await vi.advanceTimersByTimeAsync(25);
		await stopping;

		expect(diagnostics).toEqual([expect.stringContaining("hanging-stop stop timed out")]);
	});

	it("quarantines a timed-out stop before restarting the same provider", async () => {
		vi.useFakeTimers();
		const registry = new GatewayRegistry({ lifecycleTimeoutMs: 25 });
		let releaseStop!: () => void;
		const stopGate = new Promise<void>((resolve) => {
			releaseStop = resolve;
		});
		let startCalls = 0;
		let active = false;
		registry.registerChannel({
			name: "slow-stop",
			start: () => {
				startCalls += 1;
				active = true;
			},
			send: () => {},
			stop: async () => {
				await stopGate;
				active = false;
			},
		});
		await registry.start(() => {});

		const stopping = registry.stop();
		await vi.advanceTimersByTimeAsync(25);
		await stopping;
		await registry.start(() => {});

		expect(startCalls).toBe(1);
		releaseStop();
		await Promise.resolve();
		await registry.start(() => {});

		expect(startCalls).toBe(2);
		expect(active).toBe(true);
	});

	it("is a no-op when empty (the default — no transports baked in)", async () => {
		const registry = new GatewayRegistry();
		expect(registry.channelCount).toBe(0);
		await registry.start(() => {});
		await registry.stop();
		expect(registry.schedulerCount).toBe(0);
	});
});
