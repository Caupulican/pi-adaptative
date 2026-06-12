import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	disposeExtensionEventSubscriptions,
	loadExtensionFromFactory,
} from "../src/core/extensions/loader.ts";

describe("extension event bus subscriptions across reloads", () => {
	it("drops a disposed generation's bus handlers while keeping the new generation subscribed", async () => {
		const bus = createEventBus();
		let oldReceived = 0;
		const oldGeneration = await loadExtensionFromFactory(
			(pi) => {
				pi.events.on("chan", () => {
					oldReceived++;
				});
			},
			process.cwd(),
			bus,
			createExtensionRuntime(),
		);

		disposeExtensionEventSubscriptions([oldGeneration]);

		let newReceived = 0;
		await loadExtensionFromFactory(
			(pi) => {
				pi.events.on("chan", () => {
					newReceived++;
				});
			},
			process.cwd(),
			bus,
			createExtensionRuntime(),
		);

		bus.emit("chan", {});
		await new Promise((resolve) => setImmediate(resolve));

		expect(newReceived).toBe(1);
		expect(oldReceived).toBe(0);
	});

	it("keeps manual unsubscribe working and harmless under later disposal", async () => {
		const bus = createEventBus();
		let received = 0;
		const generation = await loadExtensionFromFactory(
			(pi) => {
				const off = pi.events.on("chan", () => {
					received++;
				});
				off();
			},
			process.cwd(),
			bus,
			createExtensionRuntime(),
		);

		bus.emit("chan", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(received).toBe(0);

		disposeExtensionEventSubscriptions([generation]);
	});
});
