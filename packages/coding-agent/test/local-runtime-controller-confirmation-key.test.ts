import type { Api, Model } from "@caupulican/pi-ai";
import { describe, expect, it } from "vitest";
import { LocalRuntimeController, type LocalRuntimeControllerDeps } from "../src/core/local-runtime-controller.ts";
import type { LocalRuntimeDeps } from "../src/core/models/local-runtime.ts";

/**
 * Regression: `confirmationKey` must be scoped to `${serverUrl}\0${model.id}` for EVERY
 * managed-local provider, not just Transformers. Before the fix, Ollama (and pi-managed prism)
 * cached "confirmed up" by bare `serverUrl`, so the FIRST model confirmed on a server waved every
 * OTHER model requested on that same server straight through `ensureLocalModelReady` — skipping the
 * installed-model check and the residency arbiter — instead of surfacing an honest
 * `model_missing_on_server` for a model that was never actually installed there.
 */

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

function controller(localRuntimeDeps: LocalRuntimeDeps): LocalRuntimeController {
	const deps: LocalRuntimeControllerDeps = {
		agentDir: "/tmp/pi-test-confirmation-key",
		localRuntimeDeps,
		getLastAssistantMessage: () => undefined,
		getUIContext: () => undefined,
		emit: () => {},
		resolveConfiguredTierModel: () => undefined,
		formatModel: (model) => `${model.provider}/${model.id}`,
	};
	return new LocalRuntimeController(deps);
}

/** A server that's already up and serves exactly `installedTags`; never spawns (spawning would mean
 * the "already confirmed up" fast path failed to short-circuit as expected). */
function configuredServerDeps(installedTags: string[]): { deps: LocalRuntimeDeps; tagsCalls: number[] } {
	const tagsCalls: number[] = [];
	let call = 0;
	const deps: LocalRuntimeDeps = {
		fetchFn: (async (url: string) => {
			const u = String(url);
			if (u.endsWith("/api/tags")) {
				call += 1;
				tagsCalls.push(call);
				return Response.json({ models: installedTags.map((name) => ({ name, size: 1_000 })) });
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
	return { deps, tagsCalls };
}

describe("LocalRuntimeController.confirmationKey — per-(server, model), never per-server alone", () => {
	it("a second model on an already-confirmed server is NOT waved through when it isn't installed there", async () => {
		const { deps } = configuredServerDeps(["qwen3:0.6b"]);
		const ctrl = controller(deps);

		const first = await ctrl.ensureLocalModelReady(ollamaModel("qwen3:0.6b"));
		expect(first).toEqual({ ready: true, reason: "already_running_configured_server" });

		// A DIFFERENT model on the SAME server: must recheck installed models and residency, not
		// short-circuit off the first model's cached "confirmed up" flag.
		const second = await ctrl.ensureLocalModelReady(ollamaModel("llama3:8b"));
		expect(second.ready).toBe(false);
		expect(second.reason).toContain("model_missing_on_server:llama3:8b");
	});

	it("the SAME model on the SAME server reuses the cache on a second call (steady-state fast path preserved)", async () => {
		const { deps, tagsCalls } = configuredServerDeps(["qwen3:0.6b"]);
		const ctrl = controller(deps);

		const first = await ctrl.ensureLocalModelReady(ollamaModel("qwen3:0.6b"));
		const callsAfterFirst = tagsCalls.length;
		const second = await ctrl.ensureLocalModelReady(ollamaModel("qwen3:0.6b"));

		expect(first.ready).toBe(true);
		expect(second).toEqual({ ready: true, reason: "confirmed_up_cached" });
		expect(tagsCalls.length).toBe(callsAfterFirst); // no extra health round trip on the cache hit
	});

	it("confirming model A does not corrupt the cache for model B once B later becomes available (independent keys)", async () => {
		let installed = ["qwen3:0.6b"];
		const deps: LocalRuntimeDeps = {
			fetchFn: (async (url: string) => {
				const u = String(url);
				if (u.endsWith("/api/tags"))
					return Response.json({ models: installed.map((name) => ({ name, size: 1_000 })) });
				if (u.endsWith("/api/ps")) return Response.json({ models: [] });
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch,
			existsFn: () => true,
			spawnFn: () => {
				throw new Error("must not spawn — a configured server is already reachable");
			},
			sleepFn: async () => {},
		};
		const ctrl = controller(deps);

		const a1 = await ctrl.ensureLocalModelReady(ollamaModel("qwen3:0.6b"));
		expect(a1.ready).toBe(true);
		const bMissing = await ctrl.ensureLocalModelReady(ollamaModel("llama3:8b"));
		expect(bMissing.ready).toBe(false);

		// B becomes installed on the server; its own key was never poisoned by A's cache entry, so it
		// gets a fresh, real check and confirms independently.
		installed = ["qwen3:0.6b", "llama3:8b"];
		const bNowReady = await ctrl.ensureLocalModelReady(ollamaModel("llama3:8b"));
		expect(bNowReady).toEqual({ ready: true, reason: "already_running_configured_server" });

		// A's own cached confirmation is untouched by B's key.
		const a2 = await ctrl.ensureLocalModelReady(ollamaModel("qwen3:0.6b"));
		expect(a2).toEqual({ ready: true, reason: "confirmed_up_cached" });
	});
});
