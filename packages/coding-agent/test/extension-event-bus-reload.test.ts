import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	disposeExtensionEventSubscriptions,
	loadExtensionFromFactory,
	loadExtensions,
} from "../src/core/extensions/loader.ts";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function createTempDir(): string {
	const dir = join(tmpdir(), `pi-extension-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	tempDirs.push(dir);
	return dir;
}

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

	it("disposes event subscriptions when an eager factory throws", async () => {
		const bus = createEventBus();
		let received = 0;

		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.events.on("chan", () => {
						received++;
					});
					throw new Error("boom");
				},
				process.cwd(),
				bus,
				createExtensionRuntime(),
			),
		).rejects.toThrow("boom");

		bus.emit("chan", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(received).toBe(0);
	});

	it("resets lazy-load event subscriptions after a throwing factory so retry does not double-fire", async () => {
		const dir = createTempDir();
		const extensionPath = join(dir, "lazy-extension.mjs");
		writeFileSync(
			extensionPath,
			[
				"let attempts = 0;",
				"export default (pi) => {",
				"  attempts++;",
				"  pi.events.on('chan', () => { globalThis.__piLazyEvents = (globalThis.__piLazyEvents ?? 0) + 1; });",
				"  if (attempts === 1) throw new Error('lazy boom');",
				"  pi.registerTool({ name: 'lazy_tool', description: 'lazy', parameters: { type: 'object', properties: {} }, execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }) });",
				"};",
			].join("\n"),
			"utf-8",
		);
		const bus = createEventBus();
		Reflect.set(globalThis, "__piLazyEvents", 0);
		const result = await loadExtensions(
			[{ path: extensionPath, lazyTools: [{ name: "lazy_tool", description: "lazy" }] }],
			dir,
			bus,
		);
		const extension = result.extensions[0]!;
		const tool = extension.tools.get("lazy_tool")!.definition;

		const context = {} as unknown as Parameters<typeof tool.execute>[4];
		await expect(tool.execute("call-1", {}, undefined, undefined, context)).rejects.toThrow("lazy boom");
		await tool.execute("call-2", {}, undefined, undefined, context);
		bus.emit("chan", {});
		await new Promise((resolve) => setImmediate(resolve));

		expect(Reflect.get(globalThis, "__piLazyEvents")).toBe(1);
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
