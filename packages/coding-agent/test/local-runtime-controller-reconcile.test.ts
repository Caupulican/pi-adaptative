import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { LocalRuntimeController, type LocalRuntimeControllerDeps } from "../src/core/local-runtime-controller.ts";
import {
	BONSAI_27B,
	PRISM_LLAMACPP_PINNED_RELEASE,
	type PrismLlamaCppDeps,
} from "../src/core/models/llamacpp-runtime.ts";
import { HF_TRANSFORMERS_PROVIDER } from "../src/core/models/local-registration.ts";
import type {
	LocalRuntimeDeps,
	LocalRuntimeStatus,
	TransformersRuntimeStatus,
} from "../src/core/models/local-runtime.ts";
import { tempDir } from "./temp-dir.ts";

/**
 * Reload/profile-switch away from a local model must stop that model's pi-spawned runtime
 * instead of leaving it running untracked — but must never touch a runtime still backing an
 * eligible model, and must never touch a server this session merely detected (never spawned).
 * Exercises LocalRuntimeController.reconcile()/dispose() directly, the same house style as
 * local-runtime-controller-prism-llamacpp.test.ts (real runtimes, faked fetch/spawn/exists).
 */

function scratchDir(name: string): string {
	return mkdtempSync(join(tmpdir(), `pi-controller-reconcile-${name}-`));
}

function ollamaModel(id: string, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "ollama",
		id,
		name: id,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:11434/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
		...overrides,
	} as Model<Api>;
}

function transformersModel(id: string, port: number, overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: HF_TRANSFORMERS_PROVIDER,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `http://127.0.0.1:${port}/v1`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
		...overrides,
	} as Model<Api>;
}

function bonsaiModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "llama-cpp",
		id: BONSAI_27B.repo,
		name: BONSAI_27B.repo,
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:8090/v1",
		reasoning: false,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
		...overrides,
	} as Model<Api>;
}

function controller(
	agentDir: string,
	localRuntimeDeps?: LocalRuntimeDeps,
	prismLlamaCppDeps?: PrismLlamaCppDeps,
): LocalRuntimeController {
	const deps: LocalRuntimeControllerDeps = {
		agentDir,
		localRuntimeDeps,
		prismLlamaCppDeps,
		getLastAssistantMessage: () => undefined,
		getUIContext: () => undefined,
		emit: () => {},
		resolveConfiguredTierModel: () => undefined,
		formatModel: (model) => `${model.provider}/${model.id}`,
	};
	return new LocalRuntimeController(deps);
}

/** An Ollama server that's already up and serves exactly `installedTags`; spawning is a hard
 * failure so tests can assert the confirmed-up fast path (never a reboot) held right up to reconcile. */
function configuredOllamaDeps(installedTags: string[]): LocalRuntimeDeps {
	return {
		fetchFn: (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/api/tags"))
				return Response.json({ models: installedTags.map((name) => ({ name, size: 1_000 })) });
			if (u.endsWith("/api/ps")) return Response.json({ models: [] });
			return new Response("{}", { status: 200 });
		}) as unknown as typeof fetch,
		existsFn: () => true,
		spawnFn: () => {
			throw new Error("must not spawn — a configured server is already reachable");
		},
		sleepFn: async () => {},
	};
}

describe("LocalRuntimeController.reconcile — Ollama", () => {
	it("stops a runtime dropped from the eligible set and evicts it from the cache", async () => {
		const agentDir = scratchDir("ollama-drop");
		try {
			const ctrl = controller(agentDir, configuredOllamaDeps(["qwen3:0.6b"]));
			const model = ollamaModel("qwen3:0.6b");

			expect((await ctrl.ensureLocalModelReady(model)).ready).toBe(true);
			const runtimeBefore = ctrl.getLocalRuntime("http://127.0.0.1:11434");
			const stopSpy = vi.spyOn(runtimeBefore, "stop");

			ctrl.reconcile([]); // nothing eligible any more

			expect(stopSpy).toHaveBeenCalledTimes(1);
			expect(ctrl.getLocalRuntime("http://127.0.0.1:11434")).not.toBe(runtimeBefore);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("fences a pending Ollama probe before it can start a removed runtime", async () => {
		const agentDir = tempDir("pi-controller-reconcile-ollama-race-");
		const ctrl = controller(agentDir);
		const model = ollamaModel("retired-ollama");
		const runtime = ctrl.getLocalRuntime("http://127.0.0.1:11434");
		const detected = Promise.withResolvers<LocalRuntimeStatus>();
		vi.spyOn(runtime, "detect").mockImplementation(() => detected.promise);
		const start = vi.spyOn(runtime, "start").mockResolvedValue({ started: true, reason: "started" });

		const readiness = ctrl.ensureLocalModelReady(model);
		ctrl.reconcile([]);
		const ownedModelsDir = runtime.ownedModelsDir();
		const userModelsDir = runtime.userModelsDir();
		detected.resolve({
			binaryPath: "/test/ollama",
			binarySource: "system",
			serverUp: false,
			serverUrl: runtime.baseUrl,
			managedByPi: false,
			ownedModelsDir,
			userModelsDir,
			ownedStore: { kind: "pi-owned", path: ownedModelsDir, modelCount: 0 },
			userStore: { kind: "user", path: userModelsDir, modelCount: 0 },
			serverModels: [],
		});

		await expect(readiness).resolves.toEqual({ ready: false, reason: "runtime_reconciled" });
		expect(start).not.toHaveBeenCalled();
		expect(ctrl.getLocalRuntime("http://127.0.0.1:11434")).not.toBe(runtime);
	});

	it("drops the stale confirmed-up cache entry too — a later ensure call re-probes for real", async () => {
		const agentDir = scratchDir("ollama-reprobe");
		try {
			let tagsCalls = 0;
			const deps: LocalRuntimeDeps = {
				fetchFn: (async (url: string) => {
					const u = String(url);
					if (u.endsWith("/api/tags")) {
						tagsCalls += 1;
						return Response.json({ models: [{ name: "qwen3:0.6b", size: 1_000 }] });
					}
					if (u.endsWith("/api/ps")) return Response.json({ models: [] });
					return new Response("{}", { status: 200 });
				}) as unknown as typeof fetch,
				existsFn: () => true,
				spawnFn: () => {
					throw new Error("must not spawn — a configured server is already reachable");
				},
				sleepFn: async () => {},
			};
			const ctrl = controller(agentDir, deps);
			const model = ollamaModel("qwen3:0.6b");

			await ctrl.ensureLocalModelReady(model);
			const callsAfterFirst = tagsCalls;
			ctrl.reconcile([]);

			const result = await ctrl.ensureLocalModelReady(model);
			expect(result.ready).toBe(true);
			expect(tagsCalls).toBeGreaterThan(callsAfterFirst); // NOT "confirmed_up_cached" — genuinely re-probed
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("leaves an eligible server's runtime, and its cached confirmation, completely untouched", async () => {
		const agentDir = scratchDir("ollama-keep");
		try {
			const ctrl = controller(agentDir, configuredOllamaDeps(["qwen3:0.6b"]));
			const model = ollamaModel("qwen3:0.6b");

			await ctrl.ensureLocalModelReady(model);
			const runtimeBefore = ctrl.getLocalRuntime("http://127.0.0.1:11434");
			const stopSpy = vi.spyOn(runtimeBefore, "stop");

			ctrl.reconcile([model]); // still eligible

			expect(stopSpy).not.toHaveBeenCalled();
			expect(ctrl.getLocalRuntime("http://127.0.0.1:11434")).toBe(runtimeBefore);
			expect(await ctrl.ensureLocalModelReady(model)).toEqual({ ready: true, reason: "confirmed_up_cached" });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("a server hosting an eligible AND a dropped model survives, but only the dropped model's confirmation is pruned", async () => {
		const agentDir = scratchDir("ollama-mixed");
		try {
			const ctrl = controller(agentDir, configuredOllamaDeps(["qwen3:0.6b", "llama3:8b"]));
			const kept = ollamaModel("qwen3:0.6b");
			const dropped = ollamaModel("llama3:8b");

			await ctrl.ensureLocalModelReady(kept);
			await ctrl.ensureLocalModelReady(dropped);
			const runtimeBefore = ctrl.getLocalRuntime("http://127.0.0.1:11434");
			const stopSpy = vi.spyOn(runtimeBefore, "stop");

			ctrl.reconcile([kept]); // dropped's model id no longer in the live configuration

			expect(stopSpy).not.toHaveBeenCalled(); // the shared server still backs an eligible model
			expect(ctrl.getLocalRuntime("http://127.0.0.1:11434")).toBe(runtimeBefore);
			expect(await ctrl.ensureLocalModelReady(kept)).toEqual({ ready: true, reason: "confirmed_up_cached" });
			// dropped's own confirmation was pruned even though the server survived
			expect((await ctrl.ensureLocalModelReady(dropped)).reason).not.toBe("confirmed_up_cached");
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("is a safe no-op for a server this session only detected (never spawned)", async () => {
		const agentDir = scratchDir("ollama-detected");
		try {
			const ctrl = controller(agentDir, configuredOllamaDeps(["qwen3:0.6b"]));
			const model = ollamaModel("qwen3:0.6b");

			await ctrl.ensureLocalModelReady(model); // server already up -> detected, never spawned
			const runtime = ctrl.getLocalRuntime("http://127.0.0.1:11434");
			const stopSpy = vi.spyOn(runtime, "stop");

			ctrl.reconcile([]);

			expect(stopSpy).toHaveReturnedWith({ stopped: false }); // stop() itself no-ops: no child to kill
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});

describe("LocalRuntimeController.reconcile — Transformers", () => {
	it("stops a dropped model's runtime and evicts it, leaves a different eligible model's runtime alone", async () => {
		const agentDir = scratchDir("transformers");
		try {
			const deps: LocalRuntimeDeps = {
				fetchFn: (async (url: string) => {
					const body = String(url).includes(":18101") ? { model: "dropped-model" } : { model: "kept-model" };
					if (String(url).endsWith("/health")) return Response.json(body);
					return new Response("{}", { status: 200 });
				}) as unknown as typeof fetch,
				existsFn: () => true,
			};
			const ctrl = controller(agentDir, deps);
			const kept = transformersModel("kept-model", 18_100);
			const dropped = transformersModel("dropped-model", 18_101);

			expect((await ctrl.ensureTransformersModelReady(kept)).ready).toBe(true);
			expect((await ctrl.ensureTransformersModelReady(dropped)).ready).toBe(true);

			const keptRuntimeBefore = ctrl.getTransformersRuntime("kept-model", "http://127.0.0.1:18100");
			const droppedRuntimeBefore = ctrl.getTransformersRuntime("dropped-model", "http://127.0.0.1:18101");
			const keptStopSpy = vi.spyOn(keptRuntimeBefore, "stop");
			const droppedStopSpy = vi.spyOn(droppedRuntimeBefore, "stop");

			ctrl.reconcile([kept]);

			expect(droppedStopSpy).toHaveBeenCalledTimes(1);
			expect(keptStopSpy).not.toHaveBeenCalled();
			expect(ctrl.getTransformersRuntime("dropped-model", "http://127.0.0.1:18101")).not.toBe(droppedRuntimeBefore);
			expect(ctrl.getTransformersRuntime("kept-model", "http://127.0.0.1:18100")).toBe(keptRuntimeBefore);
			expect(await ctrl.ensureTransformersModelReady(kept)).toEqual({ ready: true, reason: "confirmed_up_cached" });
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("fences a pending readiness probe before it can start a runtime removed by reconcile", async () => {
		const agentDir = tempDir("pi-controller-reconcile-transformers-race-");
		const ctrl = controller(agentDir);
		const model = transformersModel("retired-model", 18_102);
		const runtime = ctrl.getTransformersRuntime("retired-model", "http://127.0.0.1:18102");
		const detected = Promise.withResolvers<TransformersRuntimeStatus>();
		vi.spyOn(runtime, "detect").mockImplementation(() => detected.promise);
		const start = vi.spyOn(runtime, "start").mockResolvedValue({ started: true, reason: "started" });

		const readiness = ctrl.ensureTransformersModelReady(model);
		ctrl.reconcile([]);
		detected.resolve({
			runtimeInstalled: true,
			serverUp: false,
			baseUrl: runtime.baseUrl,
			modelId: runtime.modelId,
			venvDir: runtime.venvDir,
			cacheDir: runtime.cacheDir,
			serverScriptPath: "/test/transformers-server.py",
		});

		await expect(readiness).resolves.toEqual({ ready: false, reason: "runtime_reconciled" });
		expect(start).not.toHaveBeenCalled();
		expect(ctrl.getTransformersRuntime("retired-model", "http://127.0.0.1:18102")).not.toBe(runtime);
	});

	it("stops a runtime whose start completes after reconcile retired its owner", async () => {
		const agentDir = tempDir("pi-controller-reconcile-transformers-late-start-");
		const ctrl = controller(agentDir);
		const model = transformersModel("late-model", 18_104);
		const runtime = ctrl.getTransformersRuntime("late-model", "http://127.0.0.1:18104");
		vi.spyOn(runtime, "detect").mockResolvedValue({
			runtimeInstalled: true,
			serverUp: false,
			baseUrl: runtime.baseUrl,
			modelId: runtime.modelId,
			venvDir: runtime.venvDir,
			cacheDir: runtime.cacheDir,
			serverScriptPath: "/test/transformers-server.py",
		});
		const started = Promise.withResolvers<{ started: boolean; reason: string }>();
		const start = vi.spyOn(runtime, "start").mockImplementation(() => started.promise);
		const stop = vi.spyOn(runtime, "stop");

		const readiness = ctrl.ensureTransformersModelReady(model);
		await vi.waitFor(() => expect(start).toHaveBeenCalledTimes(1));
		ctrl.reconcile([]);
		started.resolve({ started: true, reason: "started" });

		await expect(readiness).resolves.toEqual({ ready: false, reason: "runtime_reconciled" });
		expect(stop).toHaveBeenCalledTimes(2);
	});

	it("lets a pending readiness probe continue when reconcile retains its exact runtime", async () => {
		const agentDir = tempDir("pi-controller-reconcile-transformers-retained-");
		const ctrl = controller(agentDir);
		const model = transformersModel("retained-model", 18_103);
		const runtime = ctrl.getTransformersRuntime("retained-model", "http://127.0.0.1:18103");
		const detected = Promise.withResolvers<TransformersRuntimeStatus>();
		vi.spyOn(runtime, "detect").mockImplementation(() => detected.promise);
		const start = vi.spyOn(runtime, "start").mockResolvedValue({ started: true, reason: "started" });

		const readiness = ctrl.ensureTransformersModelReady(model);
		ctrl.reconcile([model]);
		detected.resolve({
			runtimeInstalled: true,
			serverUp: false,
			baseUrl: runtime.baseUrl,
			modelId: runtime.modelId,
			venvDir: runtime.venvDir,
			cacheDir: runtime.cacheDir,
			serverScriptPath: "/test/transformers-server.py",
		});

		await expect(readiness).resolves.toEqual({ ready: true, reason: "started" });
		expect(start).toHaveBeenCalledTimes(1);
		expect(ctrl.getTransformersRuntime("retained-model", "http://127.0.0.1:18103")).toBe(runtime);
	});
});

describe("LocalRuntimeController.reconcile — prism llama.cpp", () => {
	function writeManifest(agentDir: string): void {
		const runtimeDir = join(agentDir, "runtimes", "prism-llamacpp");
		mkdirSync(runtimeDir, { recursive: true });
		writeFileSync(
			join(runtimeDir, "install.json"),
			JSON.stringify({ release: PRISM_LLAMACPP_PINNED_RELEASE, binaryRelPath: "bin/llama-server", backend: "cpu" }),
		);
	}

	function configuredPrismDeps(): PrismLlamaCppDeps {
		return {
			fetchFn: (async (url: string) => {
				const endpoint = String(url);
				if (endpoint.endsWith("/health")) return new Response("", { status: 200 });
				if (endpoint.endsWith("/v1/models")) return Response.json({ data: [{ id: BONSAI_27B.repo }] });
				return new Response("", { status: 404 });
			}) as unknown as typeof fetch,
		};
	}

	it("stops and drains the singleton prism runtime when no eligible model is pi-managed prism", async () => {
		const agentDir = scratchDir("prism-drop");
		try {
			writeManifest(agentDir);
			const ctrl = controller(agentDir, undefined, configuredPrismDeps());

			const runtimeBefore = ctrl.getPrismLlamaCppRuntime();
			await expect(ctrl.ensureIsolatedModelReady(bonsaiModel())).resolves.toBeUndefined();
			const stopSpy = vi.spyOn(runtimeBefore, "stop");

			ctrl.reconcile([]); // no prism model eligible any more

			expect(stopSpy).toHaveBeenCalledTimes(1);
			expect(ctrl.getPrismLlamaCppRuntime()).not.toBe(runtimeBefore); // drained: a fresh instance is created next
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("leaves the prism runtime running when its model is still eligible", async () => {
		const agentDir = scratchDir("prism-keep");
		try {
			writeManifest(agentDir);
			const ctrl = controller(agentDir, undefined, configuredPrismDeps());
			const model = bonsaiModel();

			const runtimeBefore = ctrl.getPrismLlamaCppRuntime();
			await ctrl.ensureIsolatedModelReady(model);
			const stopSpy = vi.spyOn(runtimeBefore, "stop");

			ctrl.reconcile([model]);

			expect(stopSpy).not.toHaveBeenCalled();
			expect(ctrl.getPrismLlamaCppRuntime()).toBe(runtimeBefore);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("fences a pending prism probe before it can self-heal a removed runtime", async () => {
		const agentDir = tempDir("pi-controller-reconcile-prism-race-");
		const health = Promise.withResolvers<Response>();
		let fetches = 0;
		const ctrl = controller(agentDir, undefined, {
			fetchFn: (async () => {
				fetches += 1;
				if (fetches === 1) return health.promise;
				return new Response("", { status: 500 });
			}) as unknown as typeof fetch,
		});

		const readiness = ctrl.ensureIsolatedModelReady(bonsaiModel());
		ctrl.reconcile([]);
		health.resolve(new Response("", { status: 500 }));

		await expect(readiness).rejects.toThrow("runtime_reconciled");
		expect(fetches).toBe(1);
	});
});

describe("LocalRuntimeController.dispose", () => {
	it("stops every pi-spawned runtime unconditionally (session teardown)", async () => {
		const agentDir = scratchDir("dispose");
		try {
			const ctrl = controller(agentDir, configuredOllamaDeps(["qwen3:0.6b"]));
			const model = ollamaModel("qwen3:0.6b");
			await ctrl.ensureLocalModelReady(model);
			const runtimeBefore = ctrl.getLocalRuntime("http://127.0.0.1:11434");
			const stopSpy = vi.spyOn(runtimeBefore, "stop");

			ctrl.dispose();

			expect(stopSpy).toHaveBeenCalledTimes(1);
			expect(ctrl.getLocalRuntime("http://127.0.0.1:11434")).not.toBe(runtimeBefore);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});

	it("continues releasing sibling runtimes when one stop fails", () => {
		const agentDir = scratchDir("dispose-stop-failure");
		try {
			const ctrl = controller(agentDir);
			const failedOllama = ctrl.getLocalRuntime("http://127.0.0.1:11434");
			const siblingOllama = ctrl.getLocalRuntime("http://127.0.0.1:11435");
			const transformers = ctrl.getTransformersRuntime("model-a", "http://127.0.0.1:18100");
			const prism = ctrl.getPrismLlamaCppRuntime();
			vi.spyOn(failedOllama, "stop").mockImplementation(() => {
				throw new Error("first child stop failed");
			});
			const siblingStop = vi.spyOn(siblingOllama, "stop");
			const transformersStop = vi.spyOn(transformers, "stop");
			const prismStop = vi.spyOn(prism, "stop");

			expect(() => ctrl.dispose()).not.toThrow();

			expect(siblingStop).toHaveBeenCalledTimes(1);
			expect(transformersStop).toHaveBeenCalledTimes(1);
			expect(prismStop).toHaveBeenCalledTimes(1);
			expect(ctrl.getLocalRuntime("http://127.0.0.1:11434")).not.toBe(failedOllama);
			expect(ctrl.getLocalRuntime("http://127.0.0.1:11435")).not.toBe(siblingOllama);
			expect(ctrl.getTransformersRuntime("model-a", "http://127.0.0.1:18100")).not.toBe(transformers);
			expect(ctrl.getPrismLlamaCppRuntime()).not.toBe(prism);
		} finally {
			rmSync(agentDir, { recursive: true, force: true });
		}
	});
});
