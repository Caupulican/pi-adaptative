import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@caupulican/pi-agent-core/node";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { createEventBus } from "../src/core/event-bus.ts";
import {
	createExtensionRuntime,
	disposeExtensionEventSubscriptions,
	loadExtension,
	loadExtensionFromFactory,
	loadExtensions,
} from "../src/core/extensions/loader.ts";
import { ExtensionRunner } from "../src/core/extensions/runner.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";

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

	it("disposes event subscriptions and restores shared runtime state when an eager factory throws", async () => {
		const bus = createEventBus();
		const runtime = createExtensionRuntime();
		const baselineRegistration = {
			name: "baseline-provider",
			config: { baseUrl: "https://baseline.example.test" },
			extensionPath: "baseline-extension",
		};
		runtime.pendingProviderRegistrations.push(baselineRegistration);
		runtime.flagValues.set("baseline-flag", "kept");
		let received = 0;

		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.events.on("chan", () => {
						received++;
					});
					pi.unregisterProvider("baseline-provider");
					pi.registerProvider("leaked-provider", { baseUrl: "https://leaked.example.test" });
					pi.registerFlag("leaked-flag", { type: "boolean", default: true });
					throw new Error("boom");
				},
				process.cwd(),
				bus,
				runtime,
				"failing-extension",
			),
		).rejects.toThrow("boom");

		bus.emit("chan", {});
		await new Promise((resolve) => setImmediate(resolve));
		expect(received).toBe(0);
		expect(runtime.pendingProviderRegistrations).toEqual([baselineRegistration]);
		expect([...runtime.flagValues]).toEqual([["baseline-flag", "kept"]]);
	});

	it("times out an extension module whose top-level evaluation never settles", async () => {
		const dir = createTempDir();
		const extensionPath = join(dir, "hanging-extension.mjs");
		writeFileSync(extensionPath, "await new Promise(() => {});\nexport default () => {};\n", "utf8");

		const result = await loadExtension(extensionPath, dir, createEventBus(), createExtensionRuntime(), {
			moduleTimeoutMs: 10,
		});

		expect(result.extension).toBeNull();
		expect(result.error).toContain("Extension module import timed out after 10ms");
	});

	it("times out an unresolved factory and rejects its late API registrations", async () => {
		let registerLate = () => {};
		const loading = loadExtensionFromFactory(
			async (pi) => {
				registerLate = () => pi.registerFlag("late-flag", { type: "boolean", default: true });
				await new Promise<void>(() => {});
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"timed-out-extension",
			{ factoryTimeoutMs: 10 },
		);

		await expect(loading).rejects.toThrow("Extension factory timed out after 10ms");
		expect(registerLate).toThrow("Extension generation is no longer active");
	});

	it("bounds unresolved async disposers and invalidates the disposed API generation", async () => {
		let registerLate = () => {};
		const extension = await loadExtensionFromFactory(
			(pi) => {
				registerLate = () => pi.registerFlag("late-flag", { type: "boolean", default: true });
				pi.onDispose(() => new Promise<void>(() => {}));
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
			"disposed-extension",
		);

		await expect(disposeExtensionEventSubscriptions([extension], { timeoutMs: 10 })).resolves.toBeUndefined();
		expect(registerLate).toThrow("Extension generation is no longer active");
	});

	it("restores removed and overridden providers when a bound-runtime factory throws", async () => {
		const runtime = createExtensionRuntime();
		const registered = new Map<string, object>();
		const runner = new ExtensionRunner(
			[],
			runtime,
			process.cwd(),
			SessionManager.inMemory(),
			ModelRegistry.inMemory(AuthStorage.inMemory()),
		);
		runner.bindCore({} as never, {} as never, {
			registerProvider: (name, config) => registered.set(name, config),
			unregisterProvider: (name) => registered.delete(name),
		});
		const baselineConfig = { baseUrl: "https://baseline.example.test" };
		runtime.registerProvider("baseline-provider", baselineConfig, "baseline-extension");

		await expect(
			loadExtensionFromFactory(
				(pi) => {
					pi.unregisterProvider("baseline-provider");
					pi.registerProvider("baseline-provider", { baseUrl: "https://replacement.example.test" });
					pi.registerProvider("leaked-provider", { baseUrl: "https://leaked.example.test" });
					throw new Error("bound boom");
				},
				process.cwd(),
				createEventBus(),
				runtime,
				"failing-extension",
			),
		).rejects.toThrow("bound boom");

		expect(registered.get("baseline-provider")).toBe(baselineConfig);
		expect(registered.has("leaked-provider")).toBe(false);
		expect(runtime.providerRegistrations.get("baseline-provider")).toEqual({
			config: baselineConfig,
			extensionPath: "baseline-extension",
		});
		expect(runtime.getProvidersForExtension("baseline-extension")).toEqual(["baseline-provider"]);
		expect(runtime.getProvidersForExtension("failing-extension")).toEqual([]);
	});

	it("throws synchronously when a factory calls an async session action without awaiting it", async () => {
		await expect(
			loadExtensionFromFactory(
				(pi) => {
					void pi.setModel({} as Parameters<typeof pi.setModel>[0]);
				},
				process.cwd(),
				createEventBus(),
				createExtensionRuntime(),
				"invalid-action-extension",
			),
		).rejects.toThrow("Action methods cannot be called during extension loading");
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
				"  pi.registerProvider('lazy-provider', { baseUrl: 'https://lazy.example.test' });",
				"  pi.registerFlag('lazy-flag', { type: 'string', default: 'attempt-' + attempts });",
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
		expect(result.runtime.pendingProviderRegistrations.map(({ name }) => name)).toEqual(["lazy-provider"]);
		expect(result.runtime.flagValues.get("lazy-flag")).toBe("attempt-2");
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
